import fs from 'fs/promises';
import path from 'path';
import { randomBytes, randomUUID } from 'crypto';

const root = path.resolve('wiki-data');
const pagesDir = path.join(root, 'pages');
const uploadsDir = path.join(root, 'uploads');

export function getUploadsDir() {
    return uploadsDir;
}

export async function ensureStorage() {
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.mkdir(uploadsDir, { recursive: true });
}

function pagePath(id) {
    return path.join(pagesDir, `${id}.json`);
}

async function atomicWrite(filePath, data) {
    const temp = filePath + '.tmp';
    await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(temp, filePath);
}

export async function listPages({ deleted } = {}) {
    await ensureStorage();
    const files = await fs.readdir(pagesDir);
    const pages = [];
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
            const raw = await fs.readFile(path.join(pagesDir, file), 'utf-8');
            pages.push(JSON.parse(raw));
        } catch (err) {
            console.error('Bad page file', file, err.message);
        }
    }
    pages.sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0));
    if (deleted === 'only') return pages.filter((p) => p.deletedAt);
    if (deleted === 'all') return pages;
    return pages.filter((p) => !p.deletedAt);
}

export async function getPage(id) {
    const raw = await fs.readFile(pagePath(id), 'utf-8');
    return JSON.parse(raw);
}

export async function createPage({ title, parentId, content }) {
    await ensureStorage();
    const pages = await listPages();
    const siblings = pages.filter((p) => (p.parentId || null) === (parentId || null));
    const now = Date.now();
    const page = {
        id: randomUUID(),
        title: (title || '未命名').trim() || '未命名',
        parentId: parentId || null,
        content: content || '',
        order: siblings.length,
        createdAt: now,
        updatedAt: now
    };
    await atomicWrite(pagePath(page.id), page);
    return page;
}

export async function updatePage(id, patch) {
    const page = await getPage(id);
    const next = { ...page, updatedAt: Date.now() };
    if (patch.title !== undefined) next.title = String(patch.title).trim() || '未命名';
    if (patch.content !== undefined) next.content = patch.content;
    if (patch.parentId !== undefined) next.parentId = patch.parentId || null;
    if (patch.order !== undefined) next.order = patch.order;
    if (next.parentId === next.id) next.parentId = page.parentId || null;
    await atomicWrite(pagePath(id), next);
    return next;
}

export async function trashPage(id) {
    const page = await getPage(id);
    if (page.deletedAt) return page;
    page.deletedAt = Date.now();
    page.updatedAt = page.deletedAt;
    await atomicWrite(pagePath(id), page);
    return page;
}

export async function restorePage(id) {
    const page = await getPage(id);
    page.deletedAt = null;
    page.updatedAt = Date.now();
    await atomicWrite(pagePath(id), page);
    return page;
}

export async function purgePage(id) {
    const pages = await listPages({ deleted: 'all' });
    const target = pages.find((p) => p.id === id);
    if (!target || !target.deletedAt) return { ok: false };
    const children = pages.filter((p) => p.parentId === id);
    for (const child of children) {
        child.parentId = target.parentId || null;
        child.updatedAt = Date.now();
        await atomicWrite(pagePath(child.id), child);
    }
    await fs.unlink(pagePath(id));
    return { ok: true };
}

export async function ensureShareToken(id) {
    const page = await getPage(id);
    if (page.deletedAt) throw new Error('not found');
    if (!page.shareToken || page.shareToken.length < 16) {
        page.shareToken = randomBytes(18).toString('base64url');
        page.updatedAt = Date.now();
        await atomicWrite(pagePath(id), page);
    }
    return page;
}

export async function findByShareToken(token) {
    if (!token || token.length < 12) return null;
    const pages = await listPages();
    return pages.find((p) => p.shareToken === token) || null;
}

export async function trashTree(ids) {
    const all = await listPages({ deleted: 'all' });
    const doomed = new Set(ids.filter(Boolean));
    let grew = true;
    while (grew) {
        grew = false;
        for (const page of all) {
            if (page.parentId && doomed.has(page.parentId) && !doomed.has(page.id)) {
                doomed.add(page.id);
                grew = true;
            }
        }
    }
    const now = Date.now();
    let count = 0;
    for (const id of doomed) {
        const page = all.find((p) => p.id === id);
        if (!page || page.deletedAt) continue;
        page.deletedAt = now;
        page.updatedAt = now;
        await atomicWrite(pagePath(id), page);
        count += 1;
    }
    return { ok: true, count };
}

export async function emptyTrash() {
    const all = await listPages({ deleted: 'all' });
    const deletedIds = new Set(all.filter((page) => page.deletedAt).map((page) => page.id));
    for (const page of all) {
        if (page.deletedAt || !page.parentId || !deletedIds.has(page.parentId)) continue;
        let parentId = page.parentId;
        const seen = new Set();
        while (parentId && deletedIds.has(parentId) && !seen.has(parentId)) {
            seen.add(parentId);
            const parent = all.find((item) => item.id === parentId);
            parentId = parent ? parent.parentId : null;
        }
        page.parentId = parentId || null;
        page.updatedAt = Date.now();
        await atomicWrite(pagePath(page.id), page);
    }
    let count = 0;
    for (const page of all) {
        if (!page.deletedAt) continue;
        await fs.unlink(pagePath(page.id));
        count += 1;
    }
    return { ok: true, count };
}

export async function saveImported(page) {
    await ensureStorage();
    await atomicWrite(pagePath(page.id), page);
    return page;
}

export async function seedIfEmpty() {
    const pages = await listPages();
    if (pages.length) return pages;
    const home = await createPage({
        title: '首页',
        content: `<h2>这是 RBWiki</h2><p>左边是目录。一篇就是一页，页下面还可以再挂页。</p><p>正文会自动保存。图片、标题和列表都可以直接写在这里。</p>`
    });
    await createPage({
        title: '怎么用',
        parentId: home.id,
        content: `<p>点目录里的 <b>+</b> 新建一页。把鼠标放在某一页上，再点它右边的 <b>+</b>，就是在它下面新建子页。</p><p>把一页拖到另一页上，它会变成那一页的子页。拖到目录顶部的「页面」上，则回到最外层。</p>`
    });
    return listPages();
}
