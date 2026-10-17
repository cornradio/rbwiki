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
    trashTree,
    emptyTrash
} from './data-manager.js';
import { importVault, suggestVaults } from './obsidian-import.js';
import { loadAuth, loadSessions, setPassword, checkPassword, createSession, dropSession, validSession } from './auth.js';
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
    limits: { fileSize: 15 * 1024 * 1024 }
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

app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!guardWrite(req, res)) return;
    if (!req.file) return res.status(400).json({ error: 'no file' });
    res.json({ url: `/uploads/${req.file.filename}` });
});

app.get(`/${auth.shareSpace}/:token`, (req, res) => {
    res.sendFile(path.join(publicDir, 'share.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'lost.html'));
});

app.get(['/rbWiki', '/rbWiki/', '/rbwiki', '/rbwiki/'], (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
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

const port = Number(process.env.PORT) || 3010;
app.listen(port, () => {
    console.log(`RBWiki http://localhost:${port}`);
});
