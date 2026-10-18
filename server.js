import express from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    ensureStorage,
    getUploadsDir,
    listPages,
    getPage,
    createPage,
    updatePage,
    trashPage,
    restorePage,
    purgePage,
    seedIfEmpty,
    ensureShareToken,
    findByShareToken,
    rewriteUploadRefs,
    trashTree,
    emptyTrash
} from './data-manager.js';
import { importVault, importPreparedVault, importVaultZip, suggestVaults } from './obsidian-import.js';
import { archiveObsidian } from './obsidian-export.js';
import { loadAuth, loadSessions, setPassword, setHomePath, checkPassword, createSession, dropSession, validSession } from './auth.js';
import { archiveLibrary, importLibrary } from './library.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

await ensureStorage();
await seedIfEmpty();
await loadSessions();
let auth = await loadAuth();

const app = express();
app.use(express.json({ limit: '8mb' }));

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, getUploadsDir()),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').slice(0, 8);
            cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`);
        }
    }),
});
const zipUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.resolve('wiki-data', 'tmp');
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => cb(null, `import-${Date.now()}.zip`)
    }),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

function readCookie(req) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        if (part.slice(0, idx).trim() === 'rbw') return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return '';
}

function writeCookie(res, token) {
    const value = token
        ? `rbw=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}`
        : 'rbw=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
    res.setHeader('Set-Cookie', value);
}

function guardWrite(req, res) {
    if (!auth.password) return true;
    if (validSession(readCookie(req))) return true;
    res.status(401).json({ error: '需要密码' });
    return false;
}

function publicPage(page) {
    if (!page) return page;
    const copy = { ...page };
    delete copy.shareToken;
    return copy;
}

app.get('/api/auth/status', (req, res) => {
    const canWrite = !auth.password || validSession(readCookie(req));
    res.json({ hasPassword: !!auth.password, canWrite, shareSpace: auth.shareSpace });
});

app.post('/api/auth/login', async (req, res) => {
    if (!auth.password) return res.status(400).json({ error: '还没有设置密码' });
    const ok = await checkPassword(req.body && req.body.password, auth);
    if (!ok) return res.status(401).json({ error: '密码不对' });
    writeCookie(res, await createSession());
    res.json({ ok: true });
});

app.post('/api/auth/logout', async (req, res) => {
    await dropSession(readCookie(req));
    writeCookie(res, '');
    res.json({ ok: true });
});

const RESERVED_HOME = new Set(['api', 'uploads', 'index.html', 'favicon.svg', 'app.js', 'app.css', 'share.html', 'lost.html']);

function homeName() {
    const raw = String(auth.homePath || 'rbWiki').trim().replace(/^\/+|\/+$/g, '');
    return raw || 'rbWiki';
}

function normalizeHomePath(input) {
    const name = String(input || '').trim().replace(/^\/+|\/+$/g, '');
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(name)) return '';
    if (RESERVED_HOME.has(name.toLowerCase())) return '';
    if (name === auth.shareSpace) return '';
    return name;
}

app.post('/api/auth/home', async (req, res) => {
    if (!guardWrite(req, res)) return;
    const name = normalizeHomePath(req.body && req.body.path);
    if (!name) return res.status(400).json({ error: '路径用 4 到 64 位字母、数字、下划线或短横线，别用系统保留的名字' });
    auth = await setHomePath(name);
    res.json({ path: name });
});

app.post('/api/auth/password', async (req, res) => {
    const password = String((req.body && req.body.password) || '');
    if (password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
    if (auth.password && !validSession(readCookie(req))) {
        return res.status(401).json({ error: '先解锁再改密码' });
    }
    auth = await setPassword(password);
    writeCookie(res, await createSession());
    res.json({ ok: true });
});

app.get('/api/pages', async (req, res) => {
    const deleted = req.query.deleted === '1' ? 'only' : undefined;
    const pages = await listPages({ deleted });
    res.json(pages.map(publicPage));
});

app.get('/api/obsidian/vaults', async (req, res) => {
    res.json(await suggestVaults());
});

app.post('/api/obsidian/import', async (req, res) => {
    if (!guardWrite(req, res)) return;
    try {
        const vault = (req.body && req.body.path) || '';
        if (!vault) return res.status(400).json({ error: '需要文件夹路径' });
        const existing = await listPages({ deleted: 'all' });
        const result = await importVault(vault, existing);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message || '导入失败' });
    }
});

function safeUploadRel(rel) {
    return String(rel || '').replace(/\\/g, '/').split('/').filter((part) => part && part !== '.' && part !== '..').join('/');
}

const vaultUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.resolve('wiki-data', 'tmp', 'incoming');
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => cb(null, `${Date.now()}-${randomUUID()}`)
    }),
    limits: { fieldSize: 32 * 1024 * 1024, files: 20000 }
});

app.post('/api/obsidian/upload', (req, res) => {
    if (!guardWrite(req, res)) return;
    vaultUpload.array('files', 20000)(req, res, async (err) => {
        const stage = path.resolve('wiki-data', 'tmp', `vault-${Date.now()}-${randomUUID().slice(0, 8)}`);
        const cleanup = async () => {
            await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
            for (const file of req.files || []) fs.promises.unlink(file.path).catch(() => {});
        };
        try {
            if (err || !req.files || !req.files.length) {
                await cleanup();
                return res.status(400).json({ error: '没有选择文件' });
            }
            let paths = [];
            try { paths = JSON.parse((req.body && req.body.paths) || '[]'); } catch { paths = []; }
            if (!Array.isArray(paths) || paths.length !== req.files.length) {
                await cleanup();
                return res.status(400).json({ error: '文件列表不完整' });
            }
            await fs.promises.mkdir(stage, { recursive: true });
            for (let i = 0; i < req.files.length; i++) {
                const rel = safeUploadRel(paths[i]);
                if (!rel) continue;
                const dest = path.resolve(stage, rel);
                if (dest !== path.join(stage, rel)) continue;
                await fs.promises.mkdir(path.dirname(dest), { recursive: true });
                try {
                    await fs.promises.rename(req.files[i].path, dest);
                } catch {
                    await fs.promises.copyFile(req.files[i].path, dest);
                    await fs.promises.unlink(req.files[i].path).catch(() => {});
                }
            }
            const existing = await listPages({ deleted: 'all' });
            res.json(await importPreparedVault(stage, existing));
        } catch (error) {
            if (!res.headersSent) res.status(400).json({ error: error.message || '导入失败' });
        } finally {
            await cleanup();
        }
    });
});

app.post('/api/obsidian/zip', (req, res) => {
    if (!guardWrite(req, res)) return;
    zipUpload.single('file')(req, res, async (err) => {
        if (err || !req.file) return res.status(400).json({ error: '需要压缩包' });
        try {
            const existing = await listPages({ deleted: 'all' });
            res.json(await importVaultZip(req.file.path, existing, req.file.originalname));
        } catch (error) {
            res.status(400).json({ error: error.message || '导入失败' });
        } finally {
            fs.promises.unlink(req.file.path).catch(() => {});
        }
    });
});

function pageSubtree(pages, rootId) {
    const root = pages.find((page) => page.id === rootId);
    if (!root) return null;
    const byParent = new Map();
    for (const page of pages) {
        const key = page.parentId || '';
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(page);
    }
    const out = [root];
    const walk = (id) => {
        for (const child of byParent.get(id) || []) {
            out.push(child);
            walk(child.id);
        }
    };
    walk(root.id);
    return out;
}

function obsidianFilename(title) {
    const name = String(title || 'rbwiki').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 80) || 'rbwiki';
    return name + '-obsidian.zip';
}

app.get('/api/obsidian/export', async (req, res) => {
    if (!guardWrite(req, res)) return;
    const pages = await listPages();
    const root = String(req.query.root || '');
    const chosen = root ? pageSubtree(pages, root) : pages;
    if (!chosen) return res.status(404).json({ error: '没有这个页面' });
    const filename = obsidianFilename(root ? chosen[0].title : 'rbwiki');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="vault.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    const archive = archiveObsidian(chosen);
    archive.on('error', () => {
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
    });
    archive.pipe(res);
});

app.get('/api/library/export', async (req, res) => {
    if (!guardWrite(req, res)) return;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="rbwiki.zip"');
    const archive = await archiveLibrary();
    archive.on('error', () => {
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
    });
    archive.pipe(res);
});

app.post('/api/library/import', zipUpload.single('file'), async (req, res) => {
    if (!guardWrite(req, res)) return;
    if (!req.file) return res.status(400).json({ error: '需要压缩包' });
    try {
        res.json(await importLibrary(req.file.path));
    } catch (err) {
        res.status(400).json({ error: err.message || '导入失败' });
    } finally {
        fs.promises.unlink(req.file.path).catch(() => {});
    }
});

app.post('/api/library/trash', async (req, res) => {
    if (!guardWrite(req, res)) return;
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '没有选中页面' });
    res.json(await trashTree(ids));
});

app.post('/api/library/empty-trash', async (req, res) => {
    if (!guardWrite(req, res)) return;
    res.json(await emptyTrash());
});

function attrValue(attrs, name) {
    const match = String(attrs).match(new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i'));
    if (!match) return '';
    return (match[2] ?? match[3] ?? '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function escapeAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function anchorPageId(attrs) {
    const dataPage = attrValue(attrs, 'data-page');
    if (dataPage) return dataPage;
    const href = attrValue(attrs, 'href');
    const match = href.match(/^\/p\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
}

function rewriteShareHtml(html, byId) {
    return String(html || '').replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs, inner) => {
        const id = anchorPageId(attrs);
        if (id) {
            const target = byId.get(id);
            if (!target || !target.shareToken) return inner;
            return `<a href="/${auth.shareSpace}/${target.shareToken}">${inner}</a>`;
        }
        const href = attrValue(attrs, 'href');
        if (href.startsWith('/uploads/')) {
            return `<a class="file-link" href="${escapeAttr(href)}">${inner}</a>`;
        }
        if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
            return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener">${inner}</a>`;
        }
        return inner;
    });
}

async function shareContent(html) {
    const pages = await listPages();
    const byId = new Map(pages.map((page) => [page.id, page]));
    const ids = new Set();
    String(html || '').replace(/<a\b([^>]*)>/gi, (_, attrs) => {
        const id = anchorPageId(attrs);
        if (id && byId.has(id)) ids.add(id);
        return _;
    });
    for (const id of ids) {
        const page = byId.get(id);
        if (!page.shareToken || page.shareToken.length < 16) byId.set(id, await ensureShareToken(id));
    }
    return rewriteShareHtml(html, byId);
}

app.get('/api/view/:token', async (req, res) => {
    const page = await findByShareToken(req.params.token);
    if (!page) return res.status(404).json({ error: 'not found' });
    res.json({
        title: page.title,
        content: await shareContent(page.content),
        updatedAt: page.updatedAt
    });
});

app.get('/api/pages/:id', async (req, res) => {
    try {
        res.json(publicPage(await getPage(req.params.id)));
    } catch {
        res.status(404).json({ error: 'not found' });
    }
});

app.post('/api/pages/:id/share', async (req, res) => {
    if (!guardWrite(req, res)) return;
    try {
        const page = await ensureShareToken(req.params.id);
        res.json({ path: `/${auth.shareSpace}/${page.shareToken}` });
    } catch {
        res.status(404).json({ error: 'not found' });
    }
});

app.post('/api/pages', async (req, res) => {
    if (!guardWrite(req, res)) return;
    res.json(publicPage(await createPage(req.body || {})));
});

app.put('/api/pages/:id', async (req, res) => {
    if (!guardWrite(req, res)) return;
    try {
        res.json(publicPage(await updatePage(req.params.id, req.body || {})));
    } catch {
        res.status(404).json({ error: 'not found' });
    }
});

app.post('/api/pages/:id/trash', async (req, res) => {
    if (!guardWrite(req, res)) return;
    try {
        res.json(await trashPage(req.params.id));
    } catch {
        res.status(404).json({ error: 'not found' });
    }
});

app.post('/api/pages/:id/restore', async (req, res) => {
    if (!guardWrite(req, res)) return;
    try {
        res.json(await restorePage(req.params.id));
    } catch {
        res.status(404).json({ error: 'not found' });
    }
});

app.delete('/api/pages/:id', async (req, res) => {
    if (!guardWrite(req, res)) return;
    const result = await purgePage(req.params.id);
    if (!result.ok) return res.status(404).json({ error: '只能彻底删除回收站里的页面' });
    res.json(result);
});

function decodeUploadName(name) {
    const raw = String(name || '');
    if ([...raw].some((ch) => ch.charCodeAt(0) > 255)) return raw;
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    if (decoded.includes('\uFFFD')) return raw;
    if (Buffer.from(decoded, 'utf8').toString('latin1') !== raw) return raw;
    return decoded;
}

function safeUploadName(name) {
    const base = path.basename(decodeUploadName(name)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
    return base || '文件';
}

app.post('/api/upload', (req, res) => {
    if (!guardWrite(req, res)) return;
    upload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: '上传失败' });
        if (!req.file) return res.status(400).json({ error: '没有文件' });
        res.json({
            url: `/uploads/${req.file.filename}`,
            name: safeUploadName(req.file.originalname),
            size: req.file.size
        });
    });
});

function removeUpload(rawName) {
    const name = path.basename(String(rawName || ''));
    if (!name || name !== String(rawName || '') || name === '.' || name === '..') return false;
    const root = path.resolve(getUploadsDir());
    const target = path.resolve(root, name);
    if (target !== path.join(root, name) || !fs.existsSync(target)) return false;
    fs.unlinkSync(target);
    return true;
}

app.delete('/api/uploads/:name', (req, res) => {
    if (!guardWrite(req, res)) return;
    const removed = removeUpload(req.params.name);
    if (!removed) return res.status(404).json({ error: '文件不在了' });
    res.json({ ok: true });
});

function uploadFilePath(rawName) {
    const name = path.basename(String(rawName || ''));
    if (!name || name !== String(rawName || '') || name === '.' || name === '..') return null;
    const root = path.resolve(getUploadsDir());
    const target = path.resolve(root, name);
    if (target !== path.join(root, name) || !fs.existsSync(target)) return null;
    return target;
}

const replaceUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, getUploadsDir()),
        filename: (req, file, cb) => cb(null, `.replace-${Date.now()}-${randomUUID().slice(0, 8)}`)
    })
});

app.put('/api/uploads/:name', (req, res) => {
    if (!guardWrite(req, res)) return;
    replaceUpload.single('file')(req, res, async (err) => {
        if (err || !req.file) return res.status(400).json({ error: '没有文件' });
        const tempPath = req.file.path;
        const dropTemp = () => { try { fs.unlinkSync(tempPath); } catch { /* already moved */ } };
        try {
            const oldName = path.basename(String(req.params.name || ''));
            const oldPath = uploadFilePath(oldName);
            if (!oldPath) {
                dropTemp();
                return res.status(404).json({ error: '文件不在了' });
            }
            if (!String(req.file.mimetype || '').startsWith('image/')) {
                dropTemp();
                return res.status(400).json({ error: '只能替换图片' });
            }
            const ext = path.extname(req.file.originalname || '').toLowerCase();
            const safeExt = ext === '.jpeg' ? '.jpg' : (/^\.(jpg|png|webp|gif)$/.test(ext) ? ext : '.jpg');
            const stem = path.basename(oldName, path.extname(oldName));
            const newName = stem + safeExt;
            const newPath = path.join(path.dirname(oldPath), newName);
            if (newName !== oldName && fs.existsSync(newPath)) {
                dropTemp();
                return res.status(409).json({ error: '同名文件已经在了' });
            }
            fs.copyFileSync(tempPath, newPath);
            dropTemp();
            if (newName !== oldName) {
                fs.unlinkSync(oldPath);
                await rewriteUploadRefs(oldName, newName);
            }
            const size = fs.statSync(newPath).size;
            res.json({ url: `/uploads/${newName}`, name: newName, size, from: oldName });
        } catch {
            dropTemp();
            res.status(500).json({ error: '替换失败' });
        }
    });
});

function uploadRefCount(html, name) {
    const needle = `/uploads/${name}`;
    let refs = 0;
    let from = 0;
    const text = String(html || '');
    while (from < text.length) {
        const at = text.indexOf(needle, from);
        if (at < 0) break;
        const next = text[at + needle.length] || '';
        if (!/[A-Za-z0-9._-]/.test(next)) refs += 1;
        from = at + needle.length;
    }
    return refs;
}

function uploadLabel(html, name) {
    const needle = `/uploads/${name}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(html || '').match(new RegExp(`<a\\b[^>]*href="${needle}"[^>]*>([^<]*)</a>`));
    if (!match) return '';
    return decodeUploadName(match[1]).replace(/\s*\([^)]*\)\s*$/, '').trim();
}

app.get('/api/uploads', async (req, res) => {
    if (!guardWrite(req, res)) return;
    const pages = await listPages({ deleted: 'all' });
    const dir = getUploadsDir();
    const names = fs.readdirSync(dir).filter((name) => {
        try { return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; }
    });
    const items = names.map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        let refs = 0;
        let label = '';
        for (const page of pages) {
            refs += uploadRefCount(page.content, name);
            if (!label) label = uploadLabel(page.content, name);
        }
        return {
            name,
            url: `/uploads/${name}`,
            size: stat.size,
            mtime: stat.mtimeMs,
            refs,
            label: label || name
        };
    });
    items.sort((a, b) => b.mtime - a.mtime);
    res.json(items);
});

app.post('/api/uploads/delete', (req, res) => {
    if (!guardWrite(req, res)) return;
    const names = Array.isArray(req.body && req.body.names) ? req.body.names : [];
    let count = 0;
    for (const raw of names) {
        if (removeUpload(raw)) count += 1;
    }
    res.json({ count });
});

app.get(`/${auth.shareSpace}/:token`, (req, res) => {
    res.sendFile(path.join(publicDir, 'share.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'lost.html'));
});

app.use((req, res, next) => {
    const name = req.path.replace(/^\/+|\/+$/g, '');
    if (name && name.toLowerCase() === homeName().toLowerCase()) {
        return res.sendFile(path.join(publicDir, 'index.html'));
    }
    next();
});

app.use((req, res, next) => {
    if (req.path.toLowerCase() === '/index.html') return res.redirect(302, '/');
    next();
});

app.use('/uploads', express.static(getUploadsDir()));
app.use(express.static(publicDir, {
    index: false,
    setHeaders(res, filePath) {
        if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    }
}));

app.use((req, res) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        return res.status(404).sendFile(path.join(publicDir, 'lost.html'));
    }
    res.status(404).json({ error: 'not found' });
});

const port = Number(process.env.PORT) || 3010;
app.listen(port, () => {
    console.log(`RBWiki http://localhost:${port}`);
});
