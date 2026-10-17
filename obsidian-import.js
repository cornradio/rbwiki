import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { getUploadsDir, saveImported } from './data-manager.js';

const SKIP = new Set(['.obsidian', '.trash', '.git', 'node_modules']);

function relKey(vault, file) {
    return path.relative(vault, file).split(path.sep).join('/');
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function inline(text, ctx) {
    const tokens = [];
    const hold = (html) => {
        const key = `\u0000${tokens.length}\u0000`;
        tokens.push(html);
        return key;
    };
    let src = text.replace(/!\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g, (_, name) => {
        const file = ctx.imageFor(name.trim());
        if (!file) return hold(`<span class="missing">缺图 ${escapeHtml(name.trim())}</span>`);
        const url = ctx.useImage(file);
        return hold(`<img src="${url}" alt="${escapeHtml(path.basename(file))}">`);
    });
    src = src.replace(/\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, name, _hash, label) => {
        const title = name.trim();
        const id = ctx.linkFor(title);
        const textLabel = (label || title).trim();
        if (!id) return hold(`<span class="missing">${escapeHtml(textLabel)}</span>`);
        return hold(`<a class="wikilink" data-page="${id}" href="#">${escapeHtml(textLabel)}</a>`);
    });
    src = src.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
        return hold(`<img src="${escapeHtml(url.trim())}" alt="${escapeHtml(alt)}">`);
    });
    src = escapeHtml(src);
    src = src.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    src = src.replace(/`([^`]+)`/g, '<code>$1</code>');
    src = src.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    src = src.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    tokens.forEach((html, i) => {
        src = src.replace(`\u0000${i}\u0000`, html);
    });
    return src;
}

function markdownToHtml(md, ctx) {
    const body = String(md || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const lines = body.split(/\r?\n/);
    const out = [];
    let para = [];
    let list = [];
    let code = null;
    const flushPara = () => {
        if (!para.length) return;
        out.push('<p>' + inline(para.join(' '), ctx) + '</p>');
        para = [];
    };
    const flushList = () => {
        if (!list.length) return;
        out.push('<ul>' + list.map((item) => '<li>' + inline(item, ctx) + '</li>').join('') + '</ul>');
        list = [];
    };
    for (const line of lines) {
        if (code) {
            if (line.startsWith('```')) {
                out.push('<pre>' + escapeHtml(code.join('\n')) + '</pre>');
                code = null;
            } else code.push(line);
            continue;
        }
        if (line.startsWith('```')) {
            flushPara();
            flushList();
            code = [];
            continue;
        }
        if (!line.trim()) {
            flushPara();
            flushList();
            continue;
        }
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            flushPara();
            flushList();
            const level = Math.min(4, heading[1].length + 1);
            out.push(`<h${level}>${inline(heading[2], ctx)}</h${level}>`);
            continue;
        }
        const item = line.match(/^\s*[-*]\s+(.*)$/);
        if (item) {
            flushPara();
            list.push(item[1]);
            continue;
        }
        flushList();
        para.push(line.trim());
    }
    if (code) out.push('<pre>' + escapeHtml(code.join('\n')) + '</pre>');
    flushPara();
    flushList();
    return out.join('');
}

function titleFrom(md, filename) {
    const fm = String(md || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
        const titled = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
        if (titled) return titled[1].trim();
    }
    return filename.replace(/\.md$/i, '');
}

async function walk(dir, files) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, files);
        else files.push(full);
    }
}

export async function suggestVaults() {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const starts = [path.join(home, 'Documents'), path.join(home, 'OneDrive')];
    const found = [];
    async function scan(dir, depth) {
        if (found.length >= 15 || depth > 4) return;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        if (entries.some((e) => e.isDirectory() && e.name === '.obsidian')) found.push(dir);
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
            await scan(path.join(dir, entry.name), depth + 1);
        }
    }
    for (const start of starts) await scan(start, 0);
    return found;
}

export async function importVault(vaultPath, existingPages) {
    const vault = path.resolve(vaultPath);
    const info = await fs.stat(vault);
    if (!info.isDirectory()) throw new Error('路径不是文件夹');
    try {
        await fs.access(path.join(vault, '.obsidian'));
    } catch {
        throw new Error('这个文件夹里没有 .obsidian，不像 Obsidian 库');
    }

    const files = [];
    await walk(vault, files);
    const notes = files.filter((file) => file.toLowerCase().endsWith('.md'));
    const imageByName = new Map();
    for (const file of files) {
        if (file.toLowerCase().endsWith('.md')) continue;
        const key = path.basename(file).toLowerCase();
        if (!imageByName.has(key)) imageByName.set(key, file);
    }

    const bySource = new Map();
    for (const page of existingPages) {
        if (page.sourceVault === vault && page.sourcePath) bySource.set(page.sourcePath, page);
    }

    const now = Date.now();
    const pages = [];
    const dirty = new Set();
    const uploads = getUploadsDir();
    await fs.mkdir(uploads, { recursive: true });
    const manifestPath = path.resolve('wiki-data', 'asset-index.json');
    let manifest = {};
    try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')); } catch { manifest = {}; }

    const statCache = new Map();
    async function fileStat(file) {
        if (!statCache.has(file)) statCache.set(file, await fs.stat(file));
        return statCache.get(file);
    }

    function assetName(file) {
        const ext = path.extname(file).slice(0, 8);
        return createHash('sha1').update(file).digest('hex').slice(0, 12) + ext;
    }

    async function assetFresh(file) {
        const stat = await fileStat(file);
        const key = vault + '|' + relKey(vault, file);
        const prev = manifest[key];
        const mtime = Math.round(stat.mtimeMs);
        const name = assetName(file);
        const dest = path.join(uploads, name);
        let exists = false;
        try { await fs.access(dest); exists = true; } catch { exists = false; }
        if (prev && exists && prev.size === stat.size && prev.mtime === mtime) return true;
        if (!prev && exists && (await fs.stat(dest)).size === stat.size) {
            manifest[key] = { size: stat.size, mtime, name };
            return true;
        }
        return false;
    }

    function mark(page) {
        page.updatedAt = now;
        dirty.add(page);
    }

    function upsert(sourcePath, title, parentId) {
        const previous = bySource.get(sourcePath);
        if (previous && previous.deletedAt) return previous;
        if (previous) {
            const parent = parentId || null;
            if (previous.title !== title || (previous.parentId || null) !== parent) {
                previous.title = title;
                previous.parentId = parent;
                mark(previous);
            }
            if (!pages.includes(previous)) pages.push(previous);
            return previous;
        }
        const page = {
            id: randomUUID(),
            title,
            parentId: parentId || null,
            content: '',
            order: 0,
            createdAt: now,
            updatedAt: now,
            sourceVault: vault,
            sourcePath,
            sourceHash: '',
            deletedAt: null
        };
        bySource.set(sourcePath, page);
        pages.push(page);
        dirty.add(page);
        return page;
    }

    const rootPage = upsert('.', path.basename(vault), null);
    const folderCache = new Map([['', rootPage]]);

    function folderPage(relDir) {
        const key = relDir.split(path.sep).join('/');
        if (folderCache.has(key)) return folderCache.get(key);
        const parentRel = path.dirname(relDir);
        const parent = folderPage(parentRel === '.' ? '' : parentRel);
        const page = upsert(key, path.basename(relDir), parent.id);
        folderCache.set(key, page);
        return page;
    }

    const notePages = [];
    let skipped = 0;
    let added = 0;
    let changed = 0;
    for (const file of notes) {
        const rel = path.relative(vault, file);
        const dir = path.dirname(rel);
        const parent = folderPage(dir === '.' ? '' : dir);
        const raw = await fs.readFile(file, 'utf-8');
        const hash = createHash('sha1').update(raw).digest('hex');
        const title = titleFrom(raw, path.basename(file));
        const sourcePath = relKey(vault, file);
        const previous = bySource.get(sourcePath);
        const isNew = !previous || !previous.id || !existingPages.some((p) => p.id === previous.id);
        let imagesStale = false;
        if (!isNew && previous.sourceHash === hash && !previous.deletedAt) {
            const re = /!\[\[([^\]|#]+)/g;
            let match;
            while ((match = re.exec(raw))) {
                const img = imageByName.get(path.basename(match[1].trim()).toLowerCase());
                if (img && !(await assetFresh(img))) { imagesStale = true; break; }
            }
            if (!imagesStale && (previous.parentId || null) === parent.id && previous.title === title) {
                if (!pages.includes(previous)) pages.push(previous);
                skipped += 1;
                continue;
            }
        }
        const page = upsert(sourcePath, title, parent.id);
        if (page.deletedAt) { skipped += 1; continue; }
        page.sourceHash = hash;
        notePages.push({ page, raw });
        if (isNew) added += 1;
        else changed += 1;
    }

    const linkFor = (name) => {
        const needle = name.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
        const hit = pages.find((p) => {
            const source = (p.sourcePath || '').replace(/\.md$/i, '').toLowerCase();
            return source === needle || source.endsWith('/' + needle) || (p.title || '').toLowerCase() === needle;
        });
        return hit ? hit.id : '';
    };
    const imageFor = (name) => imageByName.get(path.basename(name).toLowerCase()) || '';
    const usedImages = new Map();
    const useImage = (file) => {
        if (usedImages.has(file)) return usedImages.get(file);
        const url = `/uploads/${assetName(file)}`;
        usedImages.set(file, url);
        return url;
    };

    for (const item of notePages) {
        item.page.content = markdownToHtml(item.raw, { linkFor, imageFor, useImage });
        mark(item.page);
    }

    let images = 0;
    for (const file of usedImages.keys()) {
        if (await assetFresh(file)) continue;
        const stat = await fileStat(file);
        const name = assetName(file);
        await fs.copyFile(file, path.join(uploads, name));
        manifest[vault + '|' + relKey(vault, file)] = {
            size: stat.size,
            mtime: Math.round(stat.mtimeMs),
            name
        };
        images += 1;
    }

    const orders = new Map();
    for (const page of pages) {
        if (page.deletedAt) continue;
        const key = page.parentId || '';
        const order = orders.get(key) || 0;
        if (page.order !== order) {
            page.order = order;
            mark(page);
        }
        orders.set(key, order + 1);
    }
    for (const page of dirty) {
        if (page.deletedAt) continue;
        await saveImported(page);
    }
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');
    return { vault, pages: pages.length, notes: notePages.length, added, changed, skipped, images };
}
