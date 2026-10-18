const treeEl = document.getElementById('tree');
const treeHead = document.getElementById('tree-head');
const pageEl = document.getElementById('page');
const emptyEl = document.getElementById('empty');
const titleEl = document.getElementById('title');
const editorEl = document.getElementById('editor');
const statusEl = document.getElementById('status');
const finderEl = document.getElementById('finder');
const finderInput = document.getElementById('finder-input');
const finderResults = document.getElementById('finder-results');
const menuEl = document.getElementById('menu');

let pages = [];
let currentId = sessionStorage.getItem('rbw-page');
let saveTimer = null;
let savedRange = null;
let trashMode = false;
let canWrite = true;
let editorComposing = false;
let finderMode = 'all';
let finderIndex = 0;
let finderHits = [];
let menuPageId = null;
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
const collapsed = new Set(JSON.parse(localStorage.getItem('rbw-collapsed') || '[]'));
const collapsedTrash = new Set();
let trashFolded = false;

function folded(id) {
    return (trashMode ? collapsedTrash : collapsed).has(id);
}

function paintTheme() {
    const choice = localStorage.getItem('rbw-theme') || 'auto';
    const dark = choice === 'dark' || (choice !== 'light' && themeMedia.matches);
    document.documentElement.classList.toggle('theme-dark', dark);
    document.querySelectorAll('.theme-switch [data-theme], .look [data-theme]').forEach((btn) => {
        btn.classList.toggle('on', btn.dataset.theme === choice);
    });
}

function chooseTheme(choice) {
    localStorage.setItem('rbw-theme', choice);
    paintTheme();
}

themeMedia.addEventListener('change', paintTheme);
paintTheme();

function persistCollapsed() {
    localStorage.setItem('rbw-collapsed', JSON.stringify([...collapsed]));
}

function toggleFold(id) {
    const set = trashMode ? collapsedTrash : collapsed;
    if (set.has(id)) set.delete(id);
    else set.add(id);
    if (!trashMode) persistCollapsed();
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

async function api(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) {
        canWrite = false;
        document.body.classList.add('locked');
        applyLock();
        statusEl.textContent = '需要密码才能修改';
        openSettings();
    }
    return res;
}

async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
        }
    } catch (e) {}
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
}

function rememberRange() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    if (!editorEl.contains(sel.anchorNode)) return;
    savedRange = sel.getRangeAt(0).cloneRange();
}

function restoreRange() {
    editorEl.focus();
    if (!savedRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
}

function childrenOf(id) {
    const ids = new Set(pages.map((p) => p.id));
    const parentOf = (page) => (page.parentId && ids.has(page.parentId) ? page.parentId : null);
    return pages
        .filter((p) => parentOf(p) === (id || null))
        .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.title || '').localeCompare(b.title || '', 'zh'));
}

function pageIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M7 4.2h6.4L18 8.8V19.2a1.2 1.2 0 0 1-1.2 1.2H7.2A1.2 1.2 0 0 1 6 19.2V5.4A1.2 1.2 0 0 1 7.2 4.2H7z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M13.2 4.5V9h4.5"/></svg>';
}

function folderIcon(open) {
    if (open) {
        return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.2 8.2c0-.9.7-1.6 1.6-1.6h3.4l1.5 1.7h8.4c.9 0 1.6.7 1.6 1.6v.5H6.2L3.2 8.2z"/><path fill="currentColor" d="M4.4 11.2h16.1l-1.7 6.2c-.2.7-.8 1.2-1.5 1.2H6.3c-.8 0-1.4-.6-1.5-1.3L4.4 11.2z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 7.4c0-.8.7-1.5 1.5-1.5h4l1.7 2h7.3c.8 0 1.5.7 1.5 1.5v8.2c0 .8-.7 1.5-1.5 1.5h-13C4.7 19.6 4 18.9 4 18.1V7.4z"/></svg>';
}

function descendantIds(id) {
    const out = [];
    for (const child of childrenOf(id)) {
        out.push(child.id, ...descendantIds(child.id));
    }
    return out;
}

function applyLock() {
    const locked = !canWrite || trashMode;
    titleEl.readOnly = locked;
    editorEl.contentEditable = locked ? 'false' : 'true';
    document.getElementById('copy-link').classList.toggle('hidden', trashMode);
    document.getElementById('trash-page').classList.toggle('hidden', !canWrite || trashMode);
    document.body.classList.toggle('trash', trashMode);
    document.getElementById('trash-banner').classList.toggle('hidden', !trashMode);
    document.getElementById('tree-label').textContent = trashMode ? '回收站' : '页面';
    const emptyText = document.querySelector('#empty p');
    if (emptyText) emptyText.textContent = trashMode ? '回收站是空的。' : '还没有页面。';
}

async function refreshAuth() {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    canWrite = !!data.canWrite;
    document.body.classList.toggle('locked', !canWrite);
    applyLock();
    return data;
}

async function load(selectId) {
    const res = await fetch('/api/pages' + (trashMode ? '?deleted=1' : ''));
    pages = await res.json();
    if (trashMode && !trashFolded) {
        const ids = new Set(pages.map((p) => p.id));
        pages.forEach((page) => {
            if (pages.some((child) => child.parentId === page.id && ids.has(child.id))) collapsedTrash.add(page.id);
        });
        trashFolded = true;
    }
    if (selectId) currentId = selectId;
    if (!pages.some((p) => p.id === currentId)) currentId = pages[0] ? pages[0].id : null;
    if (!trashMode) sessionStorage.setItem('rbw-page', currentId || '');
    renderTree();
    showCurrent();
}

function renderTree() {
    treeEl.innerHTML = '';
    treeEl.appendChild(branch(null));
}

function branch(parentId) {
    const ul = document.createElement('ul');
    childrenOf(parentId).forEach((page) => {
        const li = document.createElement('li');
        li.appendChild(row(page));
        if (!folded(page.id)) li.appendChild(branch(page.id));
        ul.appendChild(li);
    });
    return ul;
}

function row(page) {
    const el = document.createElement('div');
    el.className = 'row' + (page.id === currentId ? ' active' : '');
    el.draggable = canWrite && !trashMode;
    el.dataset.id = page.id;

    const hasKids = childrenOf(page.id).length > 0;
    const twist = document.createElement(hasKids ? 'button' : 'span');
    if (hasKids) twist.type = 'button';
    twist.className = 'twist' + (hasKids ? (folded(page.id) ? ' shut' : ' open') : ' page-icon');
    twist.innerHTML = hasKids ? folderIcon(!folded(page.id)) : pageIcon();
    if (hasKids) {
        twist.setAttribute('aria-label', folded(page.id) ? '展开' : '收起');
        twist.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFold(page.id);
            renderTree();
        });
    }

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = page.title || '未命名';

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add';
    add.title = '新建子页';
    add.textContent = '+';
    add.addEventListener('click', (e) => {
        e.stopPropagation();
        createPage(page.id);
    });

    el.append(twist, name);
    if (canWrite && !trashMode) el.append(add);
    el.addEventListener('click', () => openPage(page.id));
    el.addEventListener('contextmenu', (e) => {
        if (!canWrite) return;
        e.preventDefault();
        menuPageId = page.id;
        document.querySelectorAll('.row.menu-target').forEach((node) => node.classList.remove('menu-target'));
        el.classList.add('menu-target');
        document.getElementById('menu-copy').classList.toggle('hidden', trashMode);
        document.getElementById('menu-export').classList.toggle('hidden', trashMode || !hasKids);
        document.getElementById('menu-trash').classList.toggle('hidden', trashMode);
        document.getElementById('menu-restore').classList.toggle('hidden', !trashMode);
        document.getElementById('menu-purge').classList.toggle('hidden', !trashMode);
        menuEl.classList.remove('hidden');
        menuEl.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px';
        menuEl.style.top = Math.min(e.clientY, window.innerHeight - 140) + 'px';
    });
    el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', page.id);
        e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drop');
        movePage(e.dataTransfer.getData('text/plain'), page.id);
    });
    return el;
}

function showCurrent() {
    const page = pages.find((p) => p.id === currentId);
    const has = !!page;
    emptyEl.classList.toggle('hidden', has);
    pageEl.classList.toggle('hidden', !has);
    applyLock();
    if (!page) return;
    if (document.activeElement !== titleEl) titleEl.value = page.title || '';
    if (document.activeElement !== editorEl) {
        editorEl.innerHTML = page.content || '';
        decorateHeadings();
    }
    deselectImage();
    closeLinkBar(false);
    closeFloatMenus();
    statusEl.textContent = '';
    applyLock();
    document.title = (page.title || '未命名') + ' · RBWiki';
}

async function openPage(id) {
    flushSave();
    currentId = id;
    sessionStorage.setItem('rbw-page', id);
    const res = await fetch('/api/pages/' + id);
    const page = await res.json();
    const idx = pages.findIndex((p) => p.id === id);
    if (idx >= 0) pages[idx] = page;
    else pages.push(page);
    renderTree();
    titleEl.value = page.title || '';
    editorEl.innerHTML = page.content || '';
    decorateHeadings();
    deselectImage();
    closeLinkBar(false);
    closeFloatMenus();
    statusEl.textContent = '';
    document.title = (page.title || '未命名') + ' · RBWiki';
    emptyEl.classList.add('hidden');
    pageEl.classList.remove('hidden');
    applyLock();
}

async function createPage(parentId) {
    if (!canWrite) return openSettings();
    flushSave();
    const res = await api('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '未命名', parentId: parentId || null, content: '' })
    });
    if (!res.ok) return;
    const page = await res.json();
    if (parentId) collapsed.delete(parentId);
    persistCollapsed();
    await load(page.id);
    titleEl.focus();
    titleEl.select();
}

async function movePage(id, parentId) {
    if (!canWrite || !id || id === parentId) return;
    if (parentId && descendantIds(id).includes(parentId)) return;
    const page = pages.find((p) => p.id === id);
    if (!page || (page.parentId || null) === (parentId || null)) return;
    statusEl.textContent = '移动中…';
    const res = await api('/api/pages/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: parentId || null })
    });
    if (res.ok) await load(currentId);
}

function scheduleSave() {
    if (!canWrite || trashMode) return;
    statusEl.textContent = '未保存';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
}

async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const page = pages.find((p) => p.id === currentId);
    if (!page || !canWrite || trashMode) return;
    const title = titleEl.value;
    const content = editorContent();
    if (title === page.title && content === (page.content || '')) return;
    statusEl.textContent = '保存中…';
    const res = await api('/api/pages/' + page.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content })
    });
    if (!res.ok) {
        if (res.status !== 401) statusEl.textContent = '保存失败';
        return;
    }
    const saved = await res.json();
    const idx = pages.findIndex((p) => p.id === saved.id);
    if (idx >= 0) pages[idx] = { ...pages[idx], ...saved };
    statusEl.textContent = '已保存';
    renderTree();
}

function blocksOf(html) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    const nodes = [...div.querySelectorAll('p, li, h1, h2, h3, h4, h5, pre, blockquote, td')];
    const texts = nodes.map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (texts.length) return texts;
    const whole = (div.textContent || '').replace(/\s+/g, ' ').trim();
    return whole ? [whole] : [];
}

function snippetAround(text, q) {
    const at = text.toLowerCase().indexOf(q.toLowerCase());
    if (at < 0) return null;
    const start = Math.max(0, at - 36);
    const end = Math.min(text.length, at + q.length + 56);
    return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

function highlight(text, q) {
    const at = text.toLowerCase().indexOf(q.toLowerCase());
    if (at < 0) return escapeHtml(text);
    return escapeHtml(text.slice(0, at)) + '<mark>' + escapeHtml(text.slice(at, at + q.length)) + '</mark>' + escapeHtml(text.slice(at + q.length));
}

function pathOf(page) {
    const names = [];
    let cur = page;
    const seen = new Set();
    while (cur && cur.parentId && !seen.has(cur.id)) {
        seen.add(cur.id);
        const parent = pages.find((p) => p.id === cur.parentId);
        if (!parent) break;
        names.unshift(parent.title || '未命名');
        cur = parent;
    }
    return names.join(' / ');
}

function collectHits(q) {
    const query = q.trim();
    if (!query) return [];
    const lower = query.toLowerCase();
    const out = [];
    for (const page of pages) {
        const title = page.title || '未命名';
        const titleHit = title.toLowerCase().includes(lower);
        const snippets = [];
        if (finderMode !== 'title') {
            for (const block of blocksOf(page.content)) {
                const snip = snippetAround(block, query);
                if (snip) snippets.push(snip);
                if (snippets.length >= 3) break;
            }
        }
        if (finderMode === 'title' ? titleHit : (titleHit || snippets.length)) {
            out.push({ page, titleHit, snippets });
        }
    }
    return out.slice(0, 40);
}

function renderFinder() {
    finderHits = collectHits(finderInput.value);
    if (finderIndex >= finderHits.length) finderIndex = 0;
    finderResults.innerHTML = '';
    const q = finderInput.value.trim();
    if (!q) {
        finderResults.innerHTML = '<p class="hit-path">输入后搜索。默认连正文一起找，也可以只看标题。</p>';
        return;
    }
    if (!finderHits.length) {
        finderResults.innerHTML = '<p class="hit-path">没有匹配的页面</p>';
        return;
    }
    finderHits.forEach((hit, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hit' + (index === finderIndex ? ' active' : '');
        const path = pathOf(hit.page);
        const snips = hit.snippets.map((text) => `<div class="hit-snip">${highlight(text, q)}</div>`).join('');
        const titleHtml = hit.titleHit ? highlight(hit.page.title || '未命名', q) : escapeHtml(hit.page.title || '未命名');
        btn.innerHTML = `<div class="hit-title">${titleHtml}</div>` +
            (path ? `<div class="hit-path">${escapeHtml(path)}</div>` : '') + snips;
        btn.addEventListener('click', () => chooseFinder(index));
        finderResults.appendChild(btn);
    });
    const active = finderResults.querySelector('.hit.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
}

function openFinder() {
    finderEl.classList.remove('hidden');
    finderInput.focus();
    finderInput.select();
    renderFinder();
}

function closeFinder() {
    finderEl.classList.add('hidden');
}

function chooseFinder(index) {
    const hit = finderHits[index];
    if (!hit) return;
    closeFinder();
    openPage(hit.page.id);
}

function closeMenu() {
    menuEl.classList.add('hidden');
    menuPageId = null;
    document.querySelectorAll('.row.menu-target').forEach((node) => node.classList.remove('menu-target'));
}

function setSide(open) {
    document.body.classList.toggle('side-collapsed', !open);
    localStorage.setItem('rbw-side', open ? 'open' : 'closed');
}

function locateCurrent() {
    const page = pages.find((p) => p.id === currentId);
    if (!page) return;
    setSide(true);
    let id = page.parentId;
    const seen = new Set();
    while (id && !seen.has(id)) {
        seen.add(id);
        collapsed.delete(id);
        const parent = pages.find((p) => p.id === id);
        id = parent && parent.parentId;
    }
    persistCollapsed();
    renderTree();
    const rowEl = treeEl.querySelector('[data-id="' + currentId + '"]');
    if (!rowEl) return;
    rowEl.scrollIntoView({ block: 'center' });
    rowEl.classList.add('located');
    setTimeout(() => rowEl.classList.remove('located'), 1600);
}

function foldAll() {
    pages.forEach((page) => {
        if (childrenOf(page.id).length) collapsed.add(page.id);
    });
    persistCollapsed();
    renderTree();
}

function currentHomePath() {
    return decodeURIComponent(location.pathname).replace(/^\/+|\/+$/g, '') || 'rbWiki';
}

function randomHomePath() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function openSettings() {
    document.getElementById('settings').classList.remove('hidden');
    document.getElementById('home-path').value = currentHomePath();
    return refreshAuth().then((data) => {
        const locked = !data.canWrite;
        document.getElementById('settings-tools').classList.toggle('hidden', locked);
        document.getElementById('pw-login').classList.toggle('hidden', !data.hasPassword || data.canWrite);
        document.getElementById('pw-set').classList.toggle('hidden', locked);
        document.getElementById('pw-logout').classList.toggle('hidden', !data.hasPassword || locked);
        document.getElementById('auth-hint').textContent = data.hasPassword
            ? (data.canWrite ? '已解锁。' : '输入密码后才能改设置。')
            : '还没有密码。设一个之后，不输入密码就不能改。';
        return data;
    });
}

function closeSettings() {
    document.getElementById('settings').classList.add('hidden');
}

document.getElementById('add-root').addEventListener('click', () => createPage(null));
document.getElementById('empty-add').addEventListener('click', () => createPage(null));
titleEl.addEventListener('input', scheduleSave);
editorEl.addEventListener('input', scheduleSave);
editorEl.addEventListener('keyup', rememberRange);
editorEl.addEventListener('mouseup', rememberRange);
window.addEventListener('beforeunload', () => { if (saveTimer) flushSave(); });

document.getElementById('copy-link').addEventListener('click', (event) => {
    event.stopPropagation();
    if (!currentId) return;
    showFloatMenu(event.clientX, event.clientY, [
        { label: '分享当前链接', onClick: shareCurrentLink },
        { label: '生成只读链接', onClick: shareReadLink },
        { label: '分享为富文本', onClick: shareRichText },
        { label: '分享为 HTML', onClick: shareHtmlFile },
        { label: '分享为 PDF', onClick: sharePdf }
    ]);
});

function currentPageLink() {
    return location.origin + location.pathname + location.search + '#' + currentId;
}

async function shareCurrentLink() {
    await copyText(currentPageLink());
    statusEl.textContent = '已复制当前链接';
}

async function shareReadLink() {
    const res = await fetch('/api/pages/' + currentId + '/share', { method: 'POST' });
    if (!res.ok) {
        statusEl.textContent = '只读链接没有生成';
        return;
    }
    const data = await res.json();
    await copyText(location.origin + data.path);
    statusEl.textContent = '已复制只读链接';
}

function exportRoot() {
    const clone = editorEl.cloneNode(true);
    clone.querySelectorAll('.heading-copy').forEach((node) => node.remove());
    clone.querySelectorAll('[data-hid], [data-cursor-ref]').forEach((node) => {
        node.removeAttribute('data-hid');
        node.removeAttribute('data-cursor-ref');
    });
    clone.querySelectorAll('.context-target').forEach((node) => node.classList.remove('context-target'));
    clone.querySelectorAll('img, a').forEach((node) => {
        const attr = node.tagName === 'IMG' ? 'src' : 'href';
        const value = stripUploadCache(node.getAttribute(attr) || '');
        if (value.startsWith('/')) node.setAttribute(attr, location.origin + value);
    });
    return clone;
}

function shareDocument(title, bodyHtml) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;max-width:760px;margin:0 auto;padding:32px 24px 64px;line-height:1.7;color:#1c1915;}h1{font-size:28px;line-height:1.3;}h2{font-size:22px;}h3{font-size:18px;}img{max-width:100%;height:auto;}a{color:#c4552a;}pre{white-space:pre-wrap;background:#f3eee6;padding:10px 12px;border-radius:8px;}</style></head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`;
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function inlineExportImages(root) {
    const images = [...root.querySelectorAll('img')];
    await Promise.all(images.map(async (img) => {
        try {
            const res = await fetch(img.src);
            if (!res.ok) return;
            img.src = await blobToDataUrl(await res.blob());
        } catch (e) {}
    }));
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportFileName(title, ext) {
    const safe = String(title || '未命名').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || '未命名';
    return safe + '.' + ext;
}

function prepareRichRoot() {
    const root = exportRoot();
    root.querySelectorAll('a').forEach((anchor) => {
        const pageId = anchor.getAttribute('data-page');
        let href = stripUploadCache(anchor.getAttribute('href') || '');
        if (pageId) href = location.origin + location.pathname + location.search + '#' + pageId;
        else if (href.startsWith('/')) href = location.origin + href;
        if (href && href !== '#') anchor.setAttribute('href', href);
        else anchor.replaceWith(document.createTextNode(anchor.textContent || ''));
        anchor.removeAttribute('data-page');
        anchor.removeAttribute('class');
    });
    return root;
}

function inlineBits(node) {
    let html = '';
    let plain = '';
    node.childNodes.forEach((child) => {
        if (child.nodeType === 3) {
            html += escapeHtml(child.textContent);
            plain += child.textContent;
            return;
        }
        if (child.nodeType !== 1) return;
        const tag = child.tagName;
        if (tag === 'BR') {
            html += '<br>';
            plain += '\n';
            return;
        }
        if (tag === 'IMG') {
            const src = child.getAttribute('src') || '';
            const alt = child.getAttribute('alt') || '';
            const style = child.getAttribute('style') || 'max-width:100%;height:auto;';
            html += `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" style="${escapeHtml(style)}">`;
            plain += alt || '[图片]';
            return;
        }
        if (tag === 'A') {
            const href = child.getAttribute('href') || '';
            const inner = inlineBits(child);
            html += href ? `<a href="${escapeHtml(href)}">${inner.html}</a>` : inner.html;
            plain += inner.plain + (href ? ' (' + href + ')' : '');
            return;
        }
        if (tag === 'B' || tag === 'STRONG' || tag === 'I' || tag === 'EM' || tag === 'U') {
            const inner = inlineBits(child);
            html += `<${tag.toLowerCase()}>${inner.html}</${tag.toLowerCase()}>`;
            plain += inner.plain;
            return;
        }
        const color = child.style && child.style.color;
        const inner = inlineBits(child);
        html += color ? `<span style="color:${escapeHtml(color)}">${inner.html}</span>` : inner.html;
        plain += inner.plain;
    });
    return { html, plain };
}

function renderRich(root) {
    const htmlParts = [];
    const plainParts = [];
    [...root.childNodes].forEach((node) => {
        if (node.nodeType === 3) {
            const text = node.textContent.replace(/\u00a0/g, ' ');
            if (!text.trim()) return;
            htmlParts.push(`<p>${escapeHtml(text)}</p>`);
            plainParts.push(text);
            return;
        }
        if (node.nodeType !== 1) return;
        if (node.tagName === 'IMG') {
            const holder = document.createElement('div');
            holder.appendChild(node.cloneNode(true));
            const inline = inlineBits(holder);
            htmlParts.push(`<p>${inline.html}</p>`);
            plainParts.push(inline.plain);
            return;
        }
        if (node.classList.contains('code-block') || node.tagName === 'PRE') {
            const text = (node.querySelector('pre') || node).textContent || '';
            htmlParts.push(`<pre>${escapeHtml(text)}</pre>`);
            plainParts.push(text);
            return;
        }
        const tag = /^H[1-4]$/.test(node.tagName) ? node.tagName.toLowerCase() : 'p';
        const inline = inlineBits(node);
        htmlParts.push(`<${tag}>${inline.html || '<br>'}</${tag}>`);
        plainParts.push(inline.plain.replace(/\u00a0/g, ' ').trim() ? inline.plain : '');
    });
    const title = (titleEl.value || '').trim();
    let html = htmlParts.join('');
    let plain = plainParts.join('\n');
    if (title) {
        html = `<h1>${escapeHtml(title)}</h1>` + html;
        plain = title + '\n\n' + plain;
    }
    return {
        html: `<html><body><!--StartFragment-->${html}<!--EndFragment--></body></html>`,
        plain
    };
}

async function buildRichClipboard() {
    const root = prepareRichRoot();
    await inlineExportImages(root);
    return renderRich(root);
}

function copyHtmlBySelection(html) {
    const holder = document.createElement('div');
    holder.contentEditable = 'true';
    holder.style.cssText = 'position:fixed;left:-9999px;top:0;';
    holder.innerHTML = html;
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    sel.removeAllRanges();
    holder.remove();
    return ok;
}

function shareRichText() {
    const job = buildRichClipboard();
    let pending;
    try {
        pending = navigator.clipboard.write([new ClipboardItem({
            'text/html': job.then(({ html }) => new Blob([html], { type: 'text/html' })),
            'text/plain': job.then(({ plain }) => new Blob([plain], { type: 'text/plain' }))
        })]);
    } catch (e) {
        pending = Promise.reject(e);
    }
    return pending.then(() => {
        statusEl.textContent = '已复制富文本';
    }).catch(async () => {
        const { html, plain } = await job;
        if (copyHtmlBySelection(html)) statusEl.textContent = '已复制富文本';
        else {
            await copyText(plain);
            statusEl.textContent = '富文本没复制成，已改为带换行的纯文本';
        }
    });
}

async function shareHtmlFile() {
    const title = titleEl.value || '未命名';
    const root = exportRoot();
    await inlineExportImages(root);
    const blob = new Blob([shareDocument(title, root.innerHTML)], { type: 'text/html;charset=utf-8' });
    downloadBlob(blob, exportFileName(title, 'html'));
    statusEl.textContent = '已下载 HTML';
}

async function sharePdf() {
    const title = titleEl.value || '未命名';
    const root = exportRoot();
    await inlineExportImages(root);
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:0;top:0;width:794px;height:100vh;border:0;opacity:0;pointer-events:none;';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write(shareDocument(title, root.innerHTML));
    doc.close();
    const style = doc.createElement('style');
    style.textContent = '@page{size:A4;margin:14mm;}';
    doc.head.appendChild(style);
    doc.title = title;
    await Promise.all([...doc.images].map((img) => (img.complete ? null : new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve;
    }))));
    const cleanup = () => { try { frame.remove(); } catch (e) {} };
    frame.contentWindow.addEventListener('afterprint', cleanup);
    setTimeout(cleanup, 60000);
    frame.contentWindow.focus();
    frame.contentWindow.print();
    statusEl.textContent = '已打开打印，可另存为 PDF';
}

document.getElementById('trash-page').addEventListener('click', async () => {
    const page = pages.find((p) => p.id === currentId);
    if (!page || !canWrite) return;
    if (!confirm('把「' + (page.title || '未命名') + '」移入回收站？可以再恢复。')) return;
    const parentId = page.parentId;
    await api('/api/pages/' + page.id + '/trash', { method: 'POST' });
    await load(parentId);
    statusEl.textContent = '已放入回收站。搜索下面可以切过去。';
});

let viewMode = 'lib';
let fileRows = [];

async function setView(mode) {
    if (viewMode === mode && mode !== 'files') return;
    viewMode = mode;
    trashMode = mode === 'trash';
    document.getElementById('mode-lib').classList.toggle('on', mode === 'lib');
    document.getElementById('mode-trash').classList.toggle('on', mode === 'trash');
    document.getElementById('mode-files').classList.toggle('on', mode === 'files');
    document.body.classList.toggle('files-mode', mode === 'files');
    document.getElementById('files').classList.toggle('hidden', mode !== 'files');
    applyLock();
    if (mode === 'files') {
        await loadFiles();
        return;
    }
    if (mode === 'trash') trashFolded = false;
    currentId = null;
    await load(null);
}

function visibleFiles() {
    const zeroOnly = document.getElementById('files-zero').checked;
    return fileRows.filter((row) => !zeroOnly || row.refs === 0);
}

function isImageFile(name) {
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name || '');
}

function renderFiles() {
    const rows = visibleFiles();
    const body = document.getElementById('files-body');
    const zeroOnly = document.getElementById('files-zero').checked;
    const del = document.getElementById('files-delete-zero');
    del.classList.toggle('hidden', !zeroOnly);
    del.disabled = rows.length === 0;
    if (!fileRows.length) {
        body.innerHTML = '';
        document.getElementById('files-msg').textContent = '还没有附件。';
        return;
    }
    document.getElementById('files-msg').textContent = zeroOnly
        ? (rows.length ? rows.length + ' 个没有被引用，可以一次删掉。' : '没有零引用的附件。')
        : '共 ' + fileRows.length + ' 个附件。引用算上回收站里的页面。';
    body.innerHTML = rows.map((row) => {
        const thumb = isImageFile(row.name)
            ? `<button type="button" class="file-thumb" data-preview="${escapeHtml(row.url)}" title="查看大图"><img src="${escapeHtml(row.url)}" alt=""></button>`
            : '';
        return `
        <tr class="${row.refs === 0 ? 'zero' : ''}" data-name="${escapeHtml(row.name)}">
            <td class="thumb">${thumb}</td>
            <td class="name"><a href="${escapeHtml(row.url)}" target="_blank" rel="noopener">${escapeHtml(row.label || row.name)}</a></td>
            <td class="num">${escapeHtml(formatSize(row.size))}</td>
            <td class="num refs">${row.refs}</td>
            <td class="num"><button type="button" class="danger" data-del="${escapeHtml(row.name)}">删除</button></td>
        </tr>`;
    }).join('');
}

async function loadFiles() {
    const res = await fetch('/api/uploads');
    if (res.status === 401) {
        fileRows = [];
        document.getElementById('files-body').innerHTML = '';
        document.getElementById('files-delete-zero').classList.add('hidden');
        document.getElementById('files-msg').textContent = '先在设置里解锁，才能查看和删除附件。';
        return;
    }
    fileRows = await res.json();
    renderFiles();
}

async function deleteUploadNames(names, message) {
    if (!names.length) return;
    if (!confirm(message)) return;
    const res = await api('/api/uploads/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    statusEl.textContent = '已删除 ' + (data.count || 0) + ' 个附件';
    await loadFiles();
}

document.getElementById('mode-lib').addEventListener('click', () => setView('lib'));
document.getElementById('mode-trash').addEventListener('click', () => setView('trash'));
document.getElementById('mode-files').addEventListener('click', () => setView('files'));
document.getElementById('files-zero').addEventListener('change', renderFiles);
document.getElementById('files-delete-zero').addEventListener('click', () => {
    const names = visibleFiles().map((row) => row.name);
    deleteUploadNames(names, '删除这 ' + names.length + ' 个没有被引用的附件？文件会从服务器去掉。');
});
document.getElementById('files-body').addEventListener('click', (event) => {
    const preview = event.target.closest('[data-preview]');
    if (preview) {
        showLightbox(preview.dataset.preview);
        return;
    }
    const btn = event.target.closest('[data-del]');
    if (!btn) return;
    const row = fileRows.find((item) => item.name === btn.dataset.del);
    if (!row) return;
    const warn = row.refs > 0 ? '它还被引用了 ' + row.refs + ' 次。' : '';
    deleteUploadNames([row.name], '删除「' + (row.label || row.name) + '」？' + warn + '文件会从服务器去掉。');
});

document.getElementById('locate').addEventListener('click', locateCurrent);
document.getElementById('fold-all').addEventListener('click', foldAll);
document.getElementById('fold-side').addEventListener('click', () => setSide(false));
document.getElementById('unfold').addEventListener('click', () => setSide(true));
document.querySelectorAll('.theme-switch, .look').forEach((box) => {
    box.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-theme]');
        if (!btn) return;
        chooseTheme(btn.dataset.theme);
    });
});

document.getElementById('settings-btn').addEventListener('click', () => {
    document.getElementById('settings-msg').textContent = '';
    openSettings();
});
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings').addEventListener('click', (event) => {
    if (event.target.id === 'settings') closeSettings();
});
document.getElementById('home-random').addEventListener('click', () => {
    document.getElementById('home-path').value = randomHomePath();
});
document.getElementById('home-save').addEventListener('click', async () => {
    const msg = document.getElementById('settings-msg');
    const pathName = document.getElementById('home-path').value.trim();
    const res = await api('/api/auth/home', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pathName })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        msg.textContent = data.error || '没有保存';
        return;
    }
    location.replace('/' + data.path);
});

document.getElementById('pw-login').addEventListener('click', async () => {
    const msg = document.getElementById('settings-msg');
    const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('pw').value })
    });
    const data = await res.json();
    msg.textContent = res.ok ? '已解锁' : (data.error || '解锁失败');
    if (res.ok) {
        document.getElementById('pw').value = '';
        await refreshAuth();
        openSettings();
    }
});

document.getElementById('pw-set').addEventListener('click', async () => {
    const msg = document.getElementById('settings-msg');
    const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('pw').value })
    });
    const data = await res.json().catch(() => ({}));
    msg.textContent = res.ok ? '密码已保存' : (data.error || '没有保存');
    if (res.ok) {
        document.getElementById('pw').value = '';
        await refreshAuth();
    }
});

document.getElementById('pw-logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    await refreshAuth();
    document.getElementById('settings-msg').textContent = '已锁定';
    openSettings();
});

document.getElementById('export-lib').addEventListener('click', async () => {
    const res = await api('/api/library/export');
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rbwiki.zip';
    a.click();
    URL.revokeObjectURL(url);
});

document.getElementById('import-lib').addEventListener('click', () => {
    document.getElementById('lib-file').click();
});
document.getElementById('lib-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('导入会用压缩包里的页面替换现在的库。密码不会变。继续？')) return;
    const body = new FormData();
    body.append('file', file);
    const res = await api('/api/library/import', { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    document.getElementById('settings-msg').textContent = res.ok
        ? `已导入 ${data.pages} 个页面`
        : (data.error || '导入失败');
    if (res.ok) await load(null);
});

document.getElementById('clear-all').addEventListener('click', async () => {
    const msg = document.getElementById('settings-msg');
    if (!confirm('把库里的全部页面移入回收站？切到回收站还能恢复。')) return;
    const listed = await fetch('/api/pages');
    const all = await listed.json();
    if (!all.length) {
        msg.textContent = '库里已经是空的';
        return;
    }
    const res = await api('/api/library/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: all.map((page) => page.id) })
    });
    if (!res.ok) return;
    const data = await res.json();
    trashMode = false;
    await setTrashMode(true);
    msg.textContent = `已把 ${data.count} 页放进回收站`;
});

document.getElementById('empty-trash').addEventListener('click', async () => {
    const msg = document.getElementById('settings-msg');
    if (!confirm('清空回收站？里面的页面会永久删除，不能恢复。')) return;
    const res = await api('/api/library/empty-trash', { method: 'POST' });
    if (!res.ok) return;
    const data = await res.json();
    if (trashMode) await load(null);
    msg.textContent = data.count ? `已永久删除 ${data.count} 页` : '回收站本来就是空的';
});

document.getElementById('menu-copy').addEventListener('click', async () => {
    const page = pages.find((p) => p.id === menuPageId);
    closeMenu();
    if (!page || !canWrite || trashMode) return;
    const copyId = await copyBranch(page);
    if (!copyId) {
        statusEl.textContent = '没有复制成';
        return;
    }
    await load(copyId);
    statusEl.textContent = '已复制为「' + ((page.title || '未命名') + '-copy') + '」';
});

async function copyBranch(page) {
    const sources = [page, ...descendantIds(page.id).map((id) => pages.find((item) => item.id === id)).filter(Boolean)];
    const idMap = new Map();
    for (const source of sources) {
        const parentId = source.id === page.id ? (page.parentId || null) : idMap.get(source.parentId);
        const title = source.id === page.id ? (source.title || '未命名') + '-copy' : (source.title || '未命名');
        const res = await api('/api/pages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, parentId, content: '' })
        });
        if (!res.ok) return '';
        const created = await res.json();
        idMap.set(source.id, created.id);
    }
    for (const source of sources) {
        const content = retargetCopiedHtml(source.content || '', idMap);
        if (!content) continue;
        const res = await api('/api/pages/' + idMap.get(source.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        if (!res.ok) return '';
    }
    const copyId = idMap.get(page.id);
    await load(copyId);
    await placeCopyBeside(page.id, copyId);
    return copyId;
}

function retargetCopiedHtml(html, idMap) {
    let next = String(html || '');
    idMap.forEach((newId, oldId) => {
        next = next.split(oldId).join(newId);
    });
    return next;
}

async function placeCopyBeside(sourceId, copyId) {
    const source = pages.find((item) => item.id === sourceId);
    const copy = pages.find((item) => item.id === copyId);
    if (!source || !copy) return;
    const siblings = childrenOf(source.parentId || null).filter((item) => item.id !== copyId);
    const at = siblings.findIndex((item) => item.id === sourceId);
    siblings.splice(Math.max(0, at + 1), 0, copy);
    for (let i = 0; i < siblings.length; i++) {
        if ((siblings[i].order || 0) === i) continue;
        const res = await api('/api/pages/' + siblings[i].id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: i })
        });
        if (res.ok) siblings[i].order = i;
    }
    renderTree();
}

document.getElementById('menu-trash').addEventListener('click', async () => {
    const page = pages.find((p) => p.id === menuPageId);
    closeMenu();
    if (!page) return;
    const kids = descendantIds(page.id).length;
    const extra = kids ? '，以及里面的 ' + kids + ' 页' : '';
    if (!confirm('把「' + (page.title || '未命名') + '」' + extra + '移入回收站？')) return;
    await api('/api/library/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [page.id] })
    });
    await load(page.parentId);
});

document.getElementById('menu-restore').addEventListener('click', async () => {
    const page = pages.find((p) => p.id === menuPageId);
    closeMenu();
    if (!page) return;
    const res = await api('/api/pages/' + page.id + '/restore', { method: 'POST' });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    trashMode = false;
    viewMode = 'lib';
    document.getElementById('mode-lib').classList.add('on');
    document.getElementById('mode-trash').classList.remove('on');
    document.getElementById('mode-files').classList.remove('on');
    document.body.classList.remove('files-mode');
    document.getElementById('files').classList.add('hidden');
    await load(page.id);
    const count = data.count || 1;
    statusEl.textContent = count > 1
        ? '已恢复「' + (page.title || '未命名') + '」，一共 ' + count + ' 页'
        : '已恢复「' + (page.title || '未命名') + '」';
});

document.getElementById('menu-purge').addEventListener('click', async () => {
    const page = pages.find((p) => p.id === menuPageId);
    closeMenu();
    if (!page) return;
    const kids = descendantIds(page.id).length;
    const extra = kids ? '，以及里面的 ' + kids + ' 页' : '';
    if (!confirm('彻底删除「' + (page.title || '未命名') + '」' + extra + '？不能恢复。')) return;
    const res = await api('/api/pages/' + page.id, { method: 'DELETE' });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    await load(null);
    statusEl.textContent = '已彻底删除 ' + (data.count || 1) + ' 页';
});

document.addEventListener('click', (e) => {
    if (!menuEl.contains(e.target)) closeMenu();
});

document.getElementById('search').addEventListener('focus', openFinder);
document.getElementById('search').addEventListener('click', openFinder);
document.getElementById('mode-all').addEventListener('click', () => {
    finderMode = 'all';
    document.getElementById('mode-all').classList.add('on');
    document.getElementById('mode-title').classList.remove('on');
    finderIndex = 0;
    renderFinder();
});
document.getElementById('mode-title').addEventListener('click', () => {
    finderMode = 'title';
    document.getElementById('mode-title').classList.add('on');
    document.getElementById('mode-all').classList.remove('on');
    finderIndex = 0;
    renderFinder();
});
finderInput.addEventListener('input', () => {
    finderIndex = 0;
    renderFinder();
});
finderEl.addEventListener('mousedown', (e) => {
    if (e.target === finderEl) closeFinder();
});

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openFinder();
        return;
    }
    if (e.key === 'Escape') {
        closeFinder();
        closeMenu();
        closeLinkBar(false);
        closeFloatMenus();
        closeLightbox();
        return;
    }
    if (finderEl.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (finderHits.length) finderIndex = (finderIndex + 1) % finderHits.length;
        renderFinder();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (finderHits.length) finderIndex = (finderIndex - 1 + finderHits.length) % finderHits.length;
        renderFinder();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        chooseFinder(finderIndex);
    }
});

let pickedVault = null;

function vaultSkip(rel) {
    return String(rel || '').split('/').some((part) => part === '.obsidian' || part === '.trash' || part === '.git' || part === 'node_modules');
}

function describeVaultPick() {
    const picked = document.getElementById('vault-picked');
    if (!pickedVault) {
        picked.textContent = '';
        return;
    }
    picked.textContent = pickedVault.kind === 'zip'
        ? '已选压缩包 ' + pickedVault.file.name
        : '已选本机库「' + pickedVault.label + '」，' + pickedVault.files.length + ' 个文件';
}

document.getElementById('open-obsidian').addEventListener('click', async () => {
    const dialog = document.getElementById('import-dialog');
    dialog.classList.remove('hidden');
    pickedVault = null;
    describeVaultPick();
    document.getElementById('import-msg').textContent = '正在查找服务器上的库…';
    const res = await fetch('/api/obsidian/vaults');
    const vaults = await res.json();
    const list = document.getElementById('vault-list');
    list.innerHTML = '';
    vaults.forEach((vault) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = vault;
        btn.addEventListener('click', () => {
            document.getElementById('vault-path').value = vault;
            pickedVault = null;
            describeVaultPick();
        });
        list.appendChild(btn);
    });
    document.getElementById('import-msg').textContent = vaults.length ? '上面是服务器磁盘上的库。本机的库请用选择按钮。' : '服务器上没有找到库。请从这台电脑选择文件夹或压缩包。';
});

document.getElementById('vault-pick').addEventListener('click', () => {
    document.getElementById('vault-folder').click();
});
document.getElementById('vault-folder').addEventListener('change', (event) => {
    const files = [...(event.target.files || [])].filter((file) => !vaultSkip(file.webkitRelativePath || file.name));
    event.target.value = '';
    if (!files.length) {
        pickedVault = null;
        describeVaultPick();
        document.getElementById('import-msg').textContent = '这个文件夹里没有可导入的文件';
        return;
    }
    const rel = files[0].webkitRelativePath || files[0].name;
    pickedVault = { kind: 'dir', files, label: rel.split('/')[0] || '库' };
    describeVaultPick();
});
document.getElementById('vault-zip').addEventListener('click', () => {
    document.getElementById('vault-zip-file').click();
});
document.getElementById('vault-zip-file').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    pickedVault = { kind: 'zip', file };
    describeVaultPick();
});

function uploadForm(url, body, onProgress) {
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total);
        };
        xhr.onload = () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
            resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
        };
        xhr.onerror = () => resolve({ ok: false, status: 0, data: {} });
        xhr.send(body);
    });
}

async function downloadObsidian(rootId) {
    const page = rootId ? pages.find((item) => item.id === rootId) : null;
    const res = await api('/api/obsidian/export' + (rootId ? '?root=' + encodeURIComponent(rootId) : ''));
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const title = (page && page.title) || 'rbwiki';
    a.href = url;
    a.download = title.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) + '-obsidian.zip';
    a.click();
    URL.revokeObjectURL(url);
    const msg = '已导出「' + (title || '未命名') + '」';
    if (rootId) statusEl.textContent = msg;
    else document.getElementById('settings-msg').textContent = '已导出 Obsidian 库';
}

document.getElementById('export-obsidian').addEventListener('click', () => downloadObsidian(''));
document.getElementById('menu-export').addEventListener('click', () => {
    const id = menuPageId;
    closeMenu();
    downloadObsidian(id);
});

document.getElementById('import-cancel').addEventListener('click', () => {
    document.getElementById('import-dialog').classList.add('hidden');
});

function obsidianStatus(data) {
    return `新增 ${data.added || 0} 篇，更新 ${data.changed || 0} 篇，跳过 ${data.skipped || 0} 篇，新附件 ${data.images || 0} 个`;
}

document.getElementById('import-go').addEventListener('click', async () => {
    const msg = document.getElementById('import-msg');
    if (pickedVault) {
        const body = new FormData();
        if (pickedVault.kind === 'zip') {
            body.append('file', pickedVault.file, pickedVault.file.name);
        } else {
            const paths = pickedVault.files.map((file) => file.webkitRelativePath || file.name);
            body.append('paths', JSON.stringify(paths));
            pickedVault.files.forEach((file) => body.append('files', file, file.name));
        }
        msg.textContent = '正在上传…';
        const sent = await uploadForm(pickedVault.kind === 'zip' ? '/api/obsidian/zip' : '/api/obsidian/upload', body, (loaded, total) => {
            msg.textContent = '正在上传 ' + Math.min(100, Math.round(loaded / total * 100)) + '%';
        });
        if (sent.status === 401) {
            canWrite = false;
            document.body.classList.add('locked');
            applyLock();
            openSettings();
            msg.textContent = '需要密码才能导入';
            return;
        }
        if (!sent.ok) { msg.textContent = sent.data.error || '导入失败'; return; }
        document.getElementById('import-dialog').classList.add('hidden');
        pickedVault = null;
        trashMode = false;
        await load(null);
        statusEl.textContent = obsidianStatus(sent.data);
        return;
    }
    const vault = document.getElementById('vault-path').value.trim();
    if (!vault) { msg.textContent = '先选择本机库，或填写服务器上的路径'; return; }
    msg.textContent = '正在导入，笔记多的话会等一会儿…';
    const res = await api('/api/obsidian/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: vault })
    });
    const data = await res.json();
    if (!res.ok) { msg.textContent = data.error || '导入失败'; return; }
    document.getElementById('import-dialog').classList.add('hidden');
    trashMode = false;
    await load(null);
    statusEl.textContent = obsidianStatus(data);
});

const DEFAULT_EMOJIS = ['😀','😂','🥲','😊','😍','🤔','😴','😭','😡','🥳','🤯','😎','🤝','👍','👎','👏','🙏','💪','✌️','🫡','❤️','💔','🔥','✨','⭐','🎉','🎁','💡','⚡','✅','❌','⚠️','📌','📝','📅','📞','📧','💻','🖥️','📱','☕','🍕','🍔','🍣','🍺','🚀','🏃','🐶','🐱','🌈','🌞','🌙','⛅','☔','🎵','📷','🔔','💰','🛒'];
let imgDefaultWidth = Number(localStorage.getItem('rbw-img-width')) || 0;
let compressionEnabled = localStorage.getItem('rbw-img-compress') === '1';
let resizeImg = null;
let linkSavedRange = null;

function editorWritable() {
    return canWrite && !trashMode;
}

function closeFloatMenus() {
    document.querySelectorAll('.float-menu, .emoji-panel').forEach((node) => node.remove());
    document.querySelectorAll('.context-target').forEach((node) => node.classList.remove('context-target'));
}

function closeLightbox() {
    const box = document.getElementById('lightbox');
    box.classList.add('hidden');
    box.innerHTML = '';
}

function uploadNameFromSrc(src) {
    try {
        const url = new URL(src, location.origin);
        if (url.origin !== location.origin) return '';
        const match = url.pathname.match(/^\/uploads\/([^/]+)$/);
        return match ? decodeURIComponent(match[1]) : '';
    } catch (e) {
        return '';
    }
}

function swapUploadRef(html, fromName, toName) {
    const from = '/uploads/' + fromName;
    const to = '/uploads/' + toName;
    const text = String(html || '');
    let out = '';
    let i = 0;
    while (i < text.length) {
        const at = text.indexOf(from, i);
        if (at < 0) {
            out += text.slice(i);
            break;
        }
        const next = text[at + from.length] || '';
        out += text.slice(i, at);
        out += /[A-Za-z0-9._-]/.test(next) ? from : to;
        i = at + from.length;
    }
    return out;
}

function retargetUpload(fromName, toName) {
    const from = '/uploads/' + fromName;
    const to = '/uploads/' + toName;
    const shown = to + '?v=' + Date.now();
    const nextAttr = (value) => {
        const clean = String(value || '').split('?')[0];
        if (clean !== from && clean !== to) return '';
        return shown;
    };
    editorEl.querySelectorAll('img, a').forEach((node) => {
        const attr = node.tagName === 'A' ? 'href' : 'src';
        const next = nextAttr(node.getAttribute(attr));
        if (next) node.setAttribute(attr, next);
    });
    if (fromName === toName) return;
    pages.forEach((page) => {
        if (!page.content || !page.content.includes(from)) return;
        page.content = swapUploadRef(page.content, fromName, toName);
    });
}

function stripUploadCache(html) {
    return String(html || '').replace(/(\/uploads\/[^"'?\s]+)\?v=\d+/g, '$1');
}

function editorContent() {
    const clone = editorEl.cloneNode(true);
    clone.querySelectorAll('.heading-copy').forEach((node) => node.remove());
    clone.querySelectorAll('h1, h2, h3, h4').forEach((heading) => heading.removeAttribute('data-hid'));
    return stripUploadCache(clone.innerHTML);
}

function headingSlug(text) {
    const slug = String(text || '')
        .replace(/\u00a0/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}\-_]+/gu, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
    return slug || 'section';
}

function headingText(el) {
    if (!el || el.nodeType !== 1) return stripInvisible(el && el.textContent || '').replace(/\u00a0/g, ' ').replace(/\n/g, '').trim();
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.heading-copy').forEach((node) => node.remove());
    return stripInvisible(clone.innerText || '').replace(/\u00a0/g, ' ').replace(/\n/g, '').trim();
}

function stripInvisible(text) {
    return String(text || '').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u00ad\u180e]/g, '');
}

function stripInvisibleIn(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
        if (node.parentElement && node.parentElement.closest('.heading-copy')) return;
        const next = stripInvisible(node.textContent);
        if (next !== node.textContent) node.textContent = next;
    });
}

function caretAtBlockStart(line, sel) {
    if (!line || !sel.rangeCount) return false;
    const range = document.createRange();
    range.setStart(line, 0);
    range.setEnd(sel.anchorNode, sel.anchorOffset);
    return stripInvisible(range.toString()).replace(/\u00a0/g, '').trim() === '';
}

function decorateHeadings() {
    if (editorComposing) return;
    editorEl.querySelectorAll('.heading-copy').forEach((node) => node.remove());
    const used = new Map();
    editorEl.querySelectorAll('h1, h2, h3, h4').forEach((heading) => {
        let slug = headingSlug(headingText(heading));
        const seen = used.get(slug) || 0;
        used.set(slug, seen + 1);
        if (seen) slug += '-' + (seen + 1);
        stripInvisibleIn(heading);
        heading.dataset.hid = slug;
    });
    renderToc();
}

function replaceBlock(line, html) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNode(line);
    editorEl.focus();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertHTML', false, html);
}

function deleteNodesUndo(nodes) {
    if (!nodes.length) return;
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStartBefore(nodes[0]);
    range.setEndAfter(nodes[nodes.length - 1]);
    editorEl.focus();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete');
    if (!editorEl.firstChild) document.execCommand('insertHTML', false, '<div><br></div>');
    decorateHeadings();
    scheduleSave();
}

let tocOpen = false;
let tocPageId = null;

function renderToc() {
    const box = document.getElementById('toc');
    const list = document.getElementById('toc-list');
    if (!box || !list) return;
    const headings = [...editorEl.querySelectorAll('h1, h2, h3, h4')];
    if (!headings.length) {
        box.classList.add('hidden');
        list.innerHTML = '';
        return;
    }
    if (tocPageId !== currentId) {
        tocPageId = currentId;
        tocOpen = false;
    }
    box.classList.remove('hidden');
    box.classList.toggle('collapsed', !tocOpen);
    list.innerHTML = '';
    headings.forEach((heading) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'l' + heading.tagName.slice(1);
        const mark = document.createElement('span');
        mark.className = 'toc-level';
        mark.textContent = '#' + heading.tagName.slice(1);
        const label = document.createElement('span');
        label.textContent = headingText(heading) || '无标题';
        item.append(mark, label);
        item.addEventListener('click', () => scrollToHeading(heading.dataset.hid));
        list.appendChild(item);
    });
}

document.getElementById('toc-toggle').addEventListener('click', () => {
    tocOpen = !tocOpen;
    document.getElementById('toc').classList.toggle('collapsed', !tocOpen);
});

function showHeadingMenu(x, y, heading) {
    if (!heading) return;
    const items = [
        { label: '复制标题链接', onClick: () => {
            const url = headingLink(heading);
            if (!url) return;
            copyText(url);
            statusEl.textContent = '已复制标题链接';
        } }
    ];
    if (editorWritable()) {
        items.push(
            { label: '改为正文', onClick: () => headingToText(heading) },
            { label: '删除标题', danger: true, onClick: () => removeHeading(heading, false) },
            { label: '删除本节内容', danger: true, onClick: () => removeHeading(heading, true) }
        );
    } else {
        items.push({ label: '先解锁才能改', onClick: () => { statusEl.textContent = '先解锁才能改'; } });
    }
    showFloatMenu(x, y, items, heading);
}

function headingToText(heading) {
    const clone = heading.cloneNode(true);
    clone.querySelectorAll('.heading-copy').forEach((node) => node.remove());
    const inner = stripInvisible(clone.innerText || '').replace(/\u00a0/g, ' ').trim() ? clone.innerHTML : '<br>';
    replaceBlock(heading, `<div>${inner}</div>`);
    decorateHeadings();
    scheduleSave();
    statusEl.textContent = '已改为正文';
}

function removeHeading(heading, section) {
    const level = Number(heading.tagName.slice(1));
    const drop = [heading];
    if (section) {
        let node = heading.nextSibling;
        while (node) {
            if (node.nodeType === 1 && /^H[1-4]$/.test(node.tagName) && Number(node.tagName.slice(1)) <= level) break;
            drop.push(node);
            node = node.nextSibling;
        }
    }
    deleteNodesUndo(drop);
    statusEl.textContent = section ? '本节已删除' : '标题已删除';
}

function headingLink(heading) {
    const hid = heading && heading.dataset.hid;
    if (!hid || !currentId) return '';
    return location.origin + location.pathname + location.search + '#' + currentId + '/' + encodeURIComponent(hid);
}

function scrollToHeading(hid) {
    const heading = [...editorEl.querySelectorAll('h1, h2, h3, h4')].find((node) => node.dataset.hid === hid);
    if (!heading) return;
    heading.scrollIntoView({ block: 'center' });
    heading.classList.add('heading-target');
    setTimeout(() => heading.classList.remove('heading-target'), 1600);
}

async function followHeadingLink() {
    const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
    const slash = raw.indexOf('/');
    if (slash < 0) return;
    const id = raw.slice(0, slash);
    const hid = raw.slice(slash + 1);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return;
    if (currentId !== id) await openPage(id);
    else decorateHeadings();
    scrollToHeading(hid);
}

function placeCaret(el) {
    const sel = window.getSelection();
    const range = document.createRange();
    const target = [...el.childNodes].find((node) => !(node.nodeType === 1 && node.classList.contains('heading-copy'))) || el;
    range.setStart(target, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
}

function retagHeading(line, level) {
    const clone = line.cloneNode(true);
    clone.querySelectorAll('.heading-copy').forEach((node) => node.remove());
    const text = clone.querySelector('h1, h2, h3, h4') ? null : document.createTreeWalker(clone, NodeFilter.SHOW_TEXT).nextNode();
    if (text) text.textContent = text.textContent.replace(/^#{1,4}/, '');
    const inner = stripInvisible(clone.innerText || '').replace(/\u00a0/g, ' ').trim() ? clone.innerHTML : '<br>';
    replaceBlock(line, `<h${level}>${inner}</h${level}>`);
    decorateHeadings();
    scheduleSave();
}

function applyHeadingLevel(level) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const lines = linesOfSelection(sel).filter((line) => line && line !== editorEl && !(line.classList && line.classList.contains('code-block')));
    if (!lines.length) return;
    lines.forEach((line) => {
        const text = headingText(line);
        replaceBlock(line, `<h${level}>${text ? escapeHtml(text) : '<br>'}</h${level}>`);
    });
    decorateHeadings();
    scheduleSave();
}

async function readShownSize(src, img, meta) {
    let bytes = null;
    try {
        const res = await fetch(src, { method: 'HEAD', cache: 'no-store' });
        const len = Number(res.headers.get('content-length'));
        if (res.ok && len) bytes = len;
    } catch (e) {}
    if (bytes == null) {
        try {
            const res = await fetch(src, { cache: 'no-store' });
            if (res.ok) bytes = (await res.blob()).size;
        } catch (e) {}
    }
    const paint = () => {
        const parts = [];
        if (bytes != null) parts.push(formatSize(bytes));
        if (img.naturalWidth) parts.push(img.naturalWidth + '×' + img.naturalHeight);
        meta.textContent = parts.join(' · ') || '大小未知';
    };
    if (img.complete) paint();
    else img.addEventListener('load', paint, { once: true });
    return bytes;
}

async function compressShownImage(img, meta, btn) {
    const name = uploadNameFromSrc(img.src);
    if (!name) return;
    if (!canWrite) {
        statusEl.textContent = '先在设置里解锁';
        return;
    }
    btn.disabled = true;
    btn.textContent = '正在压缩…';
    try {
        const res = await fetch(img.src, { cache: 'no-store' });
        if (!res.ok) throw new Error('fetch');
        const blob = await res.blob();
        const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
        const compressed = await compressImage(file);
        if (compressed.size >= blob.size) {
            meta.textContent = formatSize(blob.size) + ' · 压完是 ' + formatSize(compressed.size) + '，没有更小，原图还在';
            btn.textContent = '压缩图片';
            btn.disabled = false;
            return;
        }
        const body = new FormData();
        body.append('file', compressed, compressed.name);
        const put = await api('/api/uploads/' + encodeURIComponent(name), { method: 'PUT', body });
        const data = await put.json().catch(() => ({}));
        if (!put.ok) {
            meta.textContent = data.error || '没有替换成功';
            btn.textContent = '压缩图片';
            btn.disabled = false;
            return;
        }
        retargetUpload(name, data.name);
        img.src = data.url + '?v=' + Date.now();
        meta.textContent = formatSize(blob.size) + ' → ' + formatSize(data.size);
        if (img.naturalWidth) meta.textContent += ' · ' + img.naturalWidth + '×' + img.naturalHeight;
        img.addEventListener('load', () => {
            meta.textContent = formatSize(blob.size) + ' → ' + formatSize(data.size);
            if (img.naturalWidth) meta.textContent += ' · ' + img.naturalWidth + '×' + img.naturalHeight;
        }, { once: true });
        statusEl.textContent = '已压缩并替换原图';
        if (viewMode === 'files') loadFiles();
    } catch (e) {
        meta.textContent = '压缩失败';
    }
    btn.textContent = '压缩图片';
    btn.disabled = false;
}

function showLightbox(src) {
    const box = document.getElementById('lightbox');
    box.innerHTML = '';
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    const bar = document.createElement('div');
    bar.className = 'lightbox-bar';
    bar.addEventListener('click', (event) => event.stopPropagation());
    const meta = document.createElement('span');
    meta.textContent = '大小读取中…';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '压缩图片';
    if (!uploadNameFromSrc(src)) btn.classList.add('hidden');
    btn.addEventListener('click', () => compressShownImage(img, meta, btn));
    bar.append(meta, btn);
    box.append(img, bar);
    box.classList.remove('hidden');
    readShownSize(src, img, meta);
}

function showFloatMenu(x, y, items, target) {
    closeFloatMenus();
    if (target) target.classList.add('context-target');
    const menu = document.createElement('div');
    menu.className = 'float-menu';
    const dismiss = () => {
        menu.remove();
        if (target) target.classList.remove('context-target');
    };
    items.forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.label;
        if (item.danger) btn.className = 'danger';
        btn.addEventListener('click', () => {
            dismiss();
            item.onClick();
        });
        menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    setTimeout(() => {
        document.addEventListener('mousedown', function close(event) {
            if (!menu.contains(event.target)) {
                dismiss();
                document.removeEventListener('mousedown', close);
            }
        });
    }, 0);
}

function isBlockLine(node) {
    if (!node || node.nodeType !== 1 || node.parentNode !== editorEl) return false;
    if (node.classList.contains('code-block')) return true;
    return /^(DIV|P|H[1-6]|UL|OL|LI|PRE|BLOCKQUOTE|TABLE|HR)$/.test(node.tagName);
}

function isInlinePiece(node) {
    if (!node || node.parentNode !== editorEl) return false;
    if (node.nodeType === 3) return true;
    if (node.nodeType !== 1) return false;
    return !isBlockLine(node) && node.tagName !== 'BR';
}

function wrapLooseLine(node) {
    if (!node || node === editorEl || node.parentNode !== editorEl || isBlockLine(node)) return node;
    let start = node;
    while (isInlinePiece(start.previousSibling)) start = start.previousSibling;
    const div = document.createElement('div');
    start.parentNode.insertBefore(div, start);
    while (isInlinePiece(div.nextSibling)) div.appendChild(div.nextSibling);
    if (!div.firstChild) div.appendChild(document.createElement('br'));
    return div;
}

function normalizeLooseLines() {
    let node = editorEl.firstChild;
    while (node) {
        if (isBlockLine(node)) {
            node = node.nextSibling;
            continue;
        }
        if (node.nodeType === 1 && node.tagName === 'BR' && isBlockLine(node.previousSibling)) {
            const next = node.nextSibling;
            node.remove();
            node = next;
            continue;
        }
        if (node.nodeType === 1 && node.tagName === 'BR') {
            node = node.nextSibling;
            continue;
        }
        const div = wrapLooseLine(node);
        node = div && div.nextSibling;
    }
}

function getLineNode(sel) {
    let node = sel.anchorNode;
    if (!node) return null;
    if (node === editorEl) node = editorEl.childNodes[sel.anchorOffset] || editorEl.lastChild;
    if (!node || node === editorEl) return node || editorEl;
    while (node.parentNode && node.parentNode !== editorEl) node = node.parentNode;
    if (node !== editorEl) node = wrapLooseLine(node);
    return node;
}

function linesOfSelection(sel) {
    const range = sel.getRangeAt(0);
    if (range.collapsed) {
        const line = getLineNode(sel);
        return line ? [line] : [];
    }
    let start = range.startContainer;
    let end = range.endContainer;
    while (start && start !== editorEl && start.parentNode !== editorEl) start = start.parentNode;
    while (end && end !== editorEl && end.parentNode !== editorEl) end = end.parentNode;
    if (!start || !end || start === editorEl || end === editorEl) return [];
    const lines = [];
    let cur = start;
    while (cur) {
        lines.push(cur);
        if (cur === end) break;
        cur = cur.nextSibling;
    }
    return lines;
}

function plainLines(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('.code-block').forEach((block) => {
        const pre = document.createElement('pre');
        pre.textContent = block.querySelector('pre')?.innerText || '';
        block.replaceWith(pre);
    });
    clone.style.cssText = 'position:fixed;left:-9999px;white-space:pre-wrap;';
    document.body.appendChild(clone);
    const text = clone.innerText.replace(/\u00a0/g, ' ').replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, '');
    clone.remove();
    return text;
}

function linesToHtml(text) {
    return text.split('\n').map((line) => `<div>${escapeHtml(line) || '<br>'}</div>`).join('');
}

function safeUrl(url) {
    const trimmed = String(url || '').trim();
    if (!trimmed || /^\s*javascript:/i.test(trimmed)) return '';
    return trimmed;
}

function closeLinkBar(restore) {
    const bar = document.getElementById('link-input-bar');
    if (bar) bar.remove();
    if (!restore) return;
    editorEl.focus();
    if (linkSavedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(linkSavedRange);
    }
}

function linkTargetText(anchor) {
    const id = wikiIdFromLink(anchor);
    if (id) {
        const page = pages.find((item) => item.id === id);
        return page ? (page.title || '未命名') : id;
    }
    return anchor.getAttribute('href') || '';
}

function followEditorLink(link) {
    const href = link.getAttribute('href') || '';
    if (link.classList.contains('file-link') || href.startsWith('/uploads/')) {
        window.open(link.href, '_blank', 'noopener');
        return;
    }
    const id = wikiIdFromLink(link);
    if (id) {
        openPage(id);
        return;
    }
    if (href && href !== '#') window.open(link.href, '_blank', 'noopener');
}

function editLink(anchor) {
    if (!editorWritable() || !anchor) return;
    const existing = document.getElementById('link-input-bar');
    if (existing) existing.remove();
    const bar = document.createElement('div');
    bar.id = 'link-input-bar';
    bar.className = 'link-bar';
    bar.innerHTML = '<span>修改链接</span><input id="link-url-input" type="text" placeholder="页面名或 https://"><button type="button" id="link-ok">确定</button>';
    editorEl.before(bar);
    const input = bar.querySelector('input');
    input.value = linkTargetText(anchor);
    input.focus();
    input.select();
    const finish = () => {
        const value = input.value.trim();
        bar.remove();
        if (!value || !anchor.isConnected) return;
        const page = pages.find((item) => item.id === value || (item.title || '未命名') === value);
        if (page) {
            anchor.setAttribute('data-page', page.id);
            anchor.classList.add('wikilink');
            anchor.setAttribute('href', '#');
        } else {
            const url = safeUrl(value);
            if (!url) return;
            anchor.setAttribute('href', url);
            anchor.removeAttribute('data-page');
            anchor.classList.remove('wikilink');
        }
        scheduleSave();
        statusEl.textContent = '链接已修改';
    };
    bar.querySelector('#link-ok').addEventListener('click', finish);
    input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
            event.preventDefault();
            finish();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            bar.remove();
        }
    });
}

function insertLink() {
    if (!editorWritable()) return;
    const existing = document.getElementById('link-input-bar');
    if (existing) {
        existing.remove();
        return;
    }
    const sel = window.getSelection();
    if (!editorEl.contains(sel.anchorNode)) editorEl.focus();
    linkSavedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : savedRange;
    const selectedText = linkSavedRange ? linkSavedRange.toString() : '';
    const bar = document.createElement('div');
    bar.id = 'link-input-bar';
    bar.className = 'link-bar';
    bar.innerHTML = '<span>链接</span><input id="link-url-input" type="text" placeholder="https://"><button type="button" id="link-ok">确定</button>';
    editorEl.before(bar);
    const input = bar.querySelector('input');
    input.focus();
    const finish = () => {
        const url = safeUrl(input.value);
        bar.remove();
        if (!url) {
            closeLinkBar(true);
            return;
        }
        editorEl.focus();
        const live = window.getSelection();
        if (linkSavedRange) {
            live.removeAllRanges();
            live.addRange(linkSavedRange);
        }
        if (selectedText) document.execCommand('createLink', false, url);
        else document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
        scheduleSave();
    };
    bar.querySelector('#link-ok').addEventListener('click', finish);
    input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
            event.preventDefault();
            finish();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            closeLinkBar(true);
        }
    });
}

function updateCompressBtn() {
    const btn = document.getElementById('tb-compress');
    btn.classList.toggle('off', !compressionEnabled);
    btn.title = compressionEnabled ? '图片压缩：开' : '图片压缩：关';
}

function compressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => {
            const img = new Image();
            img.onerror = reject;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const maxWidth = 1600;
                if (width > maxWidth) {
                    height = (maxWidth / width) * height;
                    width = maxWidth;
                }
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error('compress failed'));
                        return;
                    }
                    resolve(new File([blob], file.name.replace(/\.[^/.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
                }, 'image/jpeg', 0.72);
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

async function prepareImage(file) {
    if (compressionEnabled && file.type.startsWith('image/')) {
        try { return await compressImage(file); } catch (e) {}
    }
    return file;
}

function imageHtml(url) {
    const width = imgDefaultWidth > 0 ? ` style="width:${imgDefaultWidth}px;height:auto;"` : '';
    return `<img src="${escapeHtml(url)}" alt=""${width}>`;
}

function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    const kb = n / 1024;
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB';
    const mb = kb / 1024;
    if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
    return (mb / 1024).toFixed(2) + ' GB';
}

let uploadJob = { index: 1, total: 1, name: '' };

function showUploadProgress(loaded, total) {
    const box = document.getElementById('upload-progress');
    box.classList.remove('hidden');
    const pct = total ? Math.min(100, Math.round(loaded / total * 100)) : 0;
    document.getElementById('upload-progress-bar').style.width = pct + '%';
    const which = uploadJob.total > 1 ? uploadJob.index + '/' + uploadJob.total + ' ' : '';
    document.getElementById('upload-progress-label').textContent = '正在上传 ' + which + uploadJob.name + ' ' + pct + '%';
}

function hideUploadProgress() {
    const box = document.getElementById('upload-progress');
    box.classList.add('hidden');
    document.getElementById('upload-progress-bar').style.width = '0';
    document.getElementById('upload-progress-label').textContent = '';
}

function uploadBlob(file) {
    uploadJob.name = file.name || uploadJob.name || '文件';
    return new Promise((resolve) => {
        const body = new FormData();
        body.append('file', file, file.name || 'file');
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) showUploadProgress(event.loaded, event.total);
        };
        xhr.onload = () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText); } catch (e) {}
            if (xhr.status < 200 || xhr.status >= 300 || !data.url) {
                statusEl.textContent = data.error || '上传失败';
                resolve(null);
                return;
            }
            showUploadProgress(1, 1);
            resolve(data);
        };
        xhr.onerror = () => {
            statusEl.textContent = '上传失败';
            resolve(null);
        };
        xhr.send(body);
    });
}

async function insertImageFile(file) {
    const prepared = await prepareImage(file);
    const data = await uploadBlob(prepared);
    if (!data) return;
    restoreRange();
    document.execCommand('insertHTML', false, imageHtml(data.url));
    scheduleSave();
    statusEl.textContent = '已插入图片';
}

function looksLikeImage(file) {
    if ((file.type || '').startsWith('image/')) return true;
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '');
}

async function insertAnyFile(file) {
    if (looksLikeImage(file)) return insertImageFile(file);
    const data = await uploadBlob(file);
    if (!data) return;
    restoreRange();
    const name = data.name || file.name || '文件';
    const label = name + ' (' + formatSize(data.size || file.size) + ')';
    document.execCommand('insertHTML', false, `<a class="file-link" href="${escapeHtml(data.url)}">${escapeHtml(label)}</a>`);
    scheduleSave();
    statusEl.textContent = '已插入 ' + name;
}

async function insertFiles(files) {
    uploadJob.total = files.length || 1;
    const ready = [];
    try {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            uploadJob.index = i + 1;
            uploadJob.name = file.name || '文件';
            if (looksLikeImage(file)) {
                const prepared = await prepareImage(file);
                const data = await uploadBlob(prepared);
                if (data) ready.push(imageHtml(data.url));
            } else {
                const data = await uploadBlob(file);
                if (!data) continue;
                const name = data.name || file.name || '文件';
                const label = name + ' (' + formatSize(data.size || file.size) + ')';
                ready.push(`<a class="file-link" href="${escapeHtml(data.url)}">${escapeHtml(label)}</a>`);
            }
        }
        if (!ready.length) return;
        restoreRange();
        const html = ready.length > 1 ? ready.map((item) => `<div>${item}</div>`).join('') : ready[0];
        document.execCommand('insertHTML', false, html);
        scheduleSave();
        statusEl.textContent = ready.length > 1 ? '已插入 ' + ready.length + ' 个，每个一行' : (ready[0].startsWith('<img') ? '已插入图片' : '已插入文件');
    } finally {
        hideUploadProgress();
    }
}

async function deleteUploaded(url) {
    const part = String(url || '').split('/uploads/')[1] || '';
    const name = decodeURIComponent(part.split(/[?#]/)[0]);
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return false;
    const res = await api('/api/uploads/' + encodeURIComponent(name), { method: 'DELETE' });
    return res.ok;
}

function filesFromClipboard(data) {
    if (!data) return [];
    const files = [];
    if (data.files && data.files.length) {
        for (const file of data.files) if (file) files.push(file);
    }
    if (!files.length && data.items) {
        for (const item of data.items) {
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
    }
    return files;
}

function deselectImage() {
    if (resizeImg) resizeImg.classList.remove('img-selected');
    resizeImg = null;
    document.getElementById('img-resize-handle').style.display = 'none';
}

function positionHandle(img) {
    const rect = img.getBoundingClientRect();
    const host = pageEl.getBoundingClientRect();
    const handle = document.getElementById('img-resize-handle');
    handle.style.left = (rect.right - host.left - 6) + 'px';
    handle.style.top = (rect.bottom - host.top - 6) + 'px';
    handle.style.display = 'block';
}

function selectImage(img) {
    if (!editorWritable()) return;
    if (resizeImg) resizeImg.classList.remove('img-selected');
    resizeImg = img;
    img.classList.add('img-selected');
    positionHandle(img);
}

function wikiIdFromLink(a) {
    const dataPage = a.getAttribute('data-page');
    if (dataPage) return dataPage;
    const match = (a.getAttribute('href') || '').match(/^\/p\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : '';
}

function wrapBareCheckboxes() {
    const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
        if (node.parentElement && node.parentElement.classList.contains('cb')) continue;
        if (/[🔲✅]/u.test(node.textContent)) nodes.push(node);
    }
    nodes.forEach((textNode) => {
        const frag = document.createDocumentFragment();
        textNode.textContent.split(/([🔲✅])/u).forEach((part) => {
            if (part === '🔲' || part === '✅') {
                const span = document.createElement('span');
                span.className = 'cb';
                span.textContent = part;
                frag.appendChild(span);
            } else if (part) frag.appendChild(document.createTextNode(part));
        });
        textNode.parentNode.replaceChild(frag, textNode);
    });
}

function openEmojiPicker() {
    const toolbar = document.querySelector('.toolbar');
    const existing = toolbar.querySelector('.emoji-panel');
    if (existing) {
        existing.remove();
        return;
    }
    closeFloatMenus();
    const panel = document.createElement('div');
    panel.className = 'emoji-panel';
    const grid = document.createElement('div');
    grid.className = 'emoji-grid';
    DEFAULT_EMOJIS.forEach((emoji) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = emoji;
        btn.addEventListener('mousedown', (event) => event.preventDefault());
        btn.addEventListener('click', () => {
            restoreRange();
            document.execCommand('insertText', false, emoji);
            rememberRange();
            scheduleSave();
        });
        grid.appendChild(btn);
    });
    panel.appendChild(grid);
    const btn = document.getElementById('tb-emoji');
    const rect = btn.getBoundingClientRect();
    const host = toolbar.getBoundingClientRect();
    let left = rect.left - host.left;
    if (left + 320 > host.width) left = Math.max(0, host.width - 328);
    panel.style.left = left + 'px';
    panel.style.top = (rect.bottom - host.top + 4) + 'px';
    toolbar.appendChild(panel);
    setTimeout(() => {
        document.addEventListener('mousedown', function close(event) {
            if (!panel.isConnected) {
                document.removeEventListener('mousedown', close);
                return;
            }
            if (panel.contains(event.target) || event.target === btn || btn.contains(event.target)) return;
            panel.remove();
            document.removeEventListener('mousedown', close);
        });
    }, 0);
}

function insertCodeBlock() {
    if (!editorWritable()) return;
    restoreRange();
    const sel = window.getSelection();
    const anchorEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const inside = anchorEl && anchorEl.closest('.code-block');
    if (inside && editorEl.contains(inside)) {
        const text = inside.querySelector('pre')?.innerText || '';
        inside.outerHTML = linesToHtml(text.replace(/\n$/, '')) || '<div><br></div>';
        scheduleSave();
        return;
    }
    const text = sel.toString();
    const block = document.createElement('div');
    block.className = 'code-block';
    block.contentEditable = 'false';
    block.innerHTML = '<div class="code-bar" contenteditable="false"><button type="button" data-act="copy">复制</button><button type="button" data-act="remove">删除</button></div><pre contenteditable="true"></pre>';
    block.querySelector('pre').textContent = text;
    if (sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(block);
        const after = document.createElement('div');
        after.appendChild(document.createElement('br'));
        block.after(after);
    } else {
        editorEl.appendChild(block);
    }
    block.querySelector('pre').focus();
    scheduleSave();
}

function clearFormatting(shift) {
    if (!editorWritable()) return;
    restoreRange();
    if (shift) {
        const clone = editorEl.cloneNode(true);
        const saved = [...clone.querySelectorAll('img')].map((img) => img.outerHTML);
        clone.querySelectorAll('img').forEach((img, i) => img.replaceWith(document.createTextNode(`\u0001IMG_${i}\u0001`)));
        const text = plainLines(clone);
        const html = text.split('\n').map((line) => {
            const restored = escapeHtml(line).replace(/\u0001IMG_(\d+)\u0001/g, (_, i) => saved[Number(i)] || '');
            return `<div>${restored || '<br>'}</div>`;
        }).join('');
        editorEl.innerHTML = html || '<div><br></div>';
        scheduleSave();
        return;
    }
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.getRangeAt(0).collapsed) return;
    const range = sel.getRangeAt(0);
    const tmp = document.createElement('div');
    tmp.appendChild(range.cloneContents());
    const html = linesToHtml(plainLines(tmp));
    range.deleteContents();
    document.execCommand('insertHTML', false, html);
    scheduleSave();
}

function insertCheckbox() {
    if (!editorWritable()) return;
    restoreRange();
    const sel = window.getSelection();
    const raw = sel.toString();
    const mark = '<span class="cb">🔲</span>&nbsp;';
    if (raw.includes('\n')) {
        document.execCommand('insertHTML', false, raw.split('\n').map((line) => `<div>${mark}${escapeHtml(line)}</div>`).join(''));
    } else if (raw) {
        document.execCommand('insertHTML', false, mark + escapeHtml(raw));
    } else {
        document.execCommand('insertHTML', false, mark);
    }
    scheduleSave();
}

function insertNumbered() {
    if (!editorWritable()) return;
    restoreRange();
    const raw = window.getSelection().toString();
    if (raw.includes('\n')) {
        document.execCommand('insertText', false, raw.split('\n').map((line, i) => `${i + 1}. ${line}`).join('\n'));
    } else if (raw) {
        document.execCommand('insertText', false, '1. ' + raw);
    } else {
        document.execCommand('insertText', false, '1. ');
    }
    scheduleSave();
}

function insertDateTime() {
    if (!editorWritable()) return;
    restoreRange();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const text = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    document.execCommand('insertText', false, text);
    scheduleSave();
}

document.querySelector('.toolbar').addEventListener('mousedown', (event) => {
    if (event.target.closest('#tb-color-label')) {
        rememberRange();
        return;
    }
    rememberRange();
    event.preventDefault();
});

const savedColor = localStorage.getItem('rbw-last-color');
if (savedColor) {
    document.getElementById('tb-color').value = savedColor;
    document.getElementById('tb-color-label').style.color = savedColor;
}
updateCompressBtn();

document.getElementById('tb-color').addEventListener('input', (event) => {
    if (!editorWritable()) return;
    restoreRange();
    document.execCommand('foreColor', false, event.target.value);
    document.getElementById('tb-color-label').style.color = event.target.value;
    localStorage.setItem('rbw-last-color', event.target.value);
    scheduleSave();
});
document.getElementById('tb-color-label').addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!editorWritable()) return;
    restoreRange();
    const color = document.getElementById('tb-color').value;
    document.execCommand('foreColor', false, color);
    document.getElementById('tb-color-label').style.color = color;
    scheduleSave();
});
document.getElementById('tb-clear-color').addEventListener('click', (event) => clearFormatting(event.shiftKey));
document.getElementById('tb-checkbox').addEventListener('click', insertCheckbox);
document.getElementById('tb-numlist').addEventListener('click', insertNumbered);
document.getElementById('tb-emoji').addEventListener('click', (event) => {
    event.stopPropagation();
    openEmojiPicker();
});
document.getElementById('tb-datetime').addEventListener('click', insertDateTime);
document.getElementById('tb-code').addEventListener('click', insertCodeBlock);
document.getElementById('tb-link').addEventListener('click', insertLink);
document.getElementById('tb-img').addEventListener('click', () => {
    if (!editorWritable()) return;
    document.getElementById('img-file').click();
});
document.getElementById('tb-file').addEventListener('click', () => {
    if (!editorWritable()) return;
    rememberRange();
    document.getElementById('any-file').click();
});
document.getElementById('tb-compress').addEventListener('click', () => {
    compressionEnabled = !compressionEnabled;
    localStorage.setItem('rbw-img-compress', compressionEnabled ? '1' : '0');
    updateCompressBtn();
});
document.getElementById('img-file').addEventListener('change', async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    rememberRange();
    await insertFiles(files);
});
document.getElementById('any-file').addEventListener('change', async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    rememberRange();
    await insertFiles(files);
});

document.getElementById('lightbox').addEventListener('click', closeLightbox);

editorEl.addEventListener('compositionstart', () => {
    editorComposing = true;
});
editorEl.addEventListener('compositionend', () => {
    editorComposing = false;
    normalizeLooseLines();
    wrapBareCheckboxes();
    decorateHeadings();
});
editorEl.addEventListener('input', (event) => {
    if (editorComposing || event.isComposing) return;
    normalizeLooseLines();
    wrapBareCheckboxes();
    decorateHeadings();
});
editorEl.addEventListener('click', (event) => {
    const marker = headingFromMarker(event);
    if (marker) {
        event.preventDefault();
        const url = headingLink(marker);
        if (!url) return;
        copyText(url);
        statusEl.textContent = '已复制标题链接';
        return;
    }
    const act = event.target.closest && event.target.closest('[data-act]');
    if (act && editorEl.contains(act)) {
        const block = act.closest('.code-block');
        if (act.dataset.act === 'copy') copyText(block.querySelector('pre').innerText);
        if (act.dataset.act === 'remove' && editorWritable()) {
            block.remove();
            scheduleSave();
        }
        statusEl.textContent = act.dataset.act === 'copy' ? '已复制代码' : statusEl.textContent;
        return;
    }
    const box = event.target.closest && event.target.closest('.cb');
    if (box && editorEl.contains(box) && editorWritable()) {
        const mark = box.textContent.trim();
        if (mark === '🔲' || mark === '✅') {
            box.textContent = mark === '🔲' ? '✅' : '🔲';
            scheduleSave();
            return;
        }
    }
    const img = event.target.closest && event.target.closest('img');
    if (img && editorEl.contains(img)) {
        if (event.metaKey || event.ctrlKey || event.detail === 2) {
            event.preventDefault();
            deselectImage();
            showLightbox(img.src);
            return;
        }
        if (event.detail === 1) selectImage(img);
        return;
    }
    if (!event.target.closest('.img-resize-handle')) deselectImage();
    const link = event.target.closest && event.target.closest('a');
    if (!link || !editorEl.contains(link)) return;
    const href = link.getAttribute('href') || '';
    if (link.classList.contains('file-link') || href.startsWith('/uploads/')) {
        event.preventDefault();
        if (!editorWritable() || event.metaKey || event.ctrlKey) window.open(link.href, '_blank', 'noopener');
        return;
    }
    const id = wikiIdFromLink(link);
    if (id) {
        event.preventDefault();
        openPage(id);
        return;
    }
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) window.open(link.href, '_blank', 'noopener');
});

editorEl.addEventListener('mousedown', (event) => {
    if (event.button !== 1) return;
    const link = event.target.closest && event.target.closest('a');
    if (link && editorEl.contains(link)) event.preventDefault();
});
editorEl.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    const link = event.target.closest && event.target.closest('a');
    if (!link || !editorEl.contains(link)) return;
    event.preventDefault();
    followEditorLink(link);
});

function headingFromMarker(event) {
    const heading = event.target.closest && event.target.closest('h1, h2, h3, h4');
    if (!heading || !editorEl.contains(heading)) return null;
    if (event.target.closest && event.target.closest('.heading-copy')) return heading;
    const rect = heading.getBoundingClientRect();
    if (event.clientX <= rect.left + 2) return heading;
    return null;
}

editorEl.addEventListener('contextmenu', (event) => {
    const marker = headingFromMarker(event);
    const heading = marker || (event.target.closest && event.target.closest('h1, h2, h3, h4'));
    if (heading && editorEl.contains(heading) && (marker || !headingText(heading))) {
        event.preventDefault();
        showHeadingMenu(event.clientX, event.clientY, heading);
        return;
    }
    if (!editorWritable()) return;
    const link = event.target.closest && event.target.closest('a');
    if (link && editorEl.contains(link)) {
        event.preventDefault();
        const href = link.getAttribute('href') || '';
        const items = [
            { label: '修改链接', onClick: () => editLink(link) },
            { label: '复制链接', onClick: () => copyText(linkTargetText(link)) },
            { label: '打开链接', onClick: () => followEditorLink(link) }
        ];
        if (link.classList.contains('file-link') || href.startsWith('/uploads/')) {
            items.push({
                label: '删除附件',
                danger: true,
                onClick: async () => {
                    const ok = await deleteUploaded(href);
                    if (!ok) {
                        statusEl.textContent = '附件没有删掉';
                        return;
                    }
                    link.remove();
                    scheduleSave();
                    statusEl.textContent = '附件已删除';
                }
            });
        }
        items.push({
            label: '只去掉链接',
            onClick: () => {
                link.replaceWith(document.createTextNode(link.textContent));
                scheduleSave();
                statusEl.textContent = '链接已去掉，文件还在';
            }
        });
        showFloatMenu(event.clientX, event.clientY, items, link);
        return;
    }
    const img = event.target.closest && event.target.closest('img');
    if (!img || !editorEl.contains(img)) return;
    event.preventDefault();
    const width = Math.round(img.getBoundingClientRect().width);
    const src = img.getAttribute('src') || '';
    const imageItems = [
        { label: `设为默认宽度（${width}px）`, onClick: () => { imgDefaultWidth = width; localStorage.setItem('rbw-img-width', String(width)); statusEl.textContent = `新图片默认 ${width}px`; } },
        { label: `全部调成 ${width}px`, onClick: () => { editorEl.querySelectorAll('img').forEach((node) => { node.style.width = width + 'px'; node.style.height = 'auto'; }); scheduleSave(); } },
        { label: '查看大图', onClick: () => showLightbox(img.src) },
        { label: '复制图片', onClick: async () => {
            try {
                const res = await fetch(img.src);
                const blob = await res.blob();
                await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
                statusEl.textContent = '已复制图片';
            } catch (e) {
                statusEl.textContent = '复制图片失败';
            }
        } },
        { label: '从正文去掉', onClick: () => {
            if (resizeImg === img) deselectImage();
            img.remove();
            scheduleSave();
            statusEl.textContent = '已从正文去掉，文件还在';
        } }
    ];
    if (src.includes('/uploads/')) {
        imageItems.push({
            label: '删除图片文件',
            danger: true,
            onClick: async () => {
                const ok = await deleteUploaded(src);
                if (!ok) {
                    statusEl.textContent = '图片文件没有删掉';
                    return;
                }
                if (resizeImg === img) deselectImage();
                img.remove();
                scheduleSave();
                statusEl.textContent = '图片文件已删除';
            }
        });
    }
    showFloatMenu(event.clientX, event.clientY, imageItems, img);
});

editorEl.addEventListener('paste', async (event) => {
    if (!editorWritable()) return;
    if (event.shiftKey) {
        event.preventDefault();
        const text = event.clipboardData?.getData('text/plain') || '';
        if (text) {
            document.execCommand('insertHTML', false, linesToHtml(text));
            scheduleSave();
        }
        return;
    }
    const files = filesFromClipboard(event.clipboardData);
    if (files.length && !event.shiftKey) {
        event.preventDefault();
        rememberRange();
        await insertFiles(files);
        return;
    }
    const text = event.clipboardData?.getData('text/plain') || '';
    if (/^https?:\/\/\S+$/i.test(text.trim())) {
        event.preventDefault();
        const url = safeUrl(text.trim());
        if (url) {
            document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
            scheduleSave();
        }
    }
});

editorEl.addEventListener('keydown', (event) => {
    if (!editorWritable() || event.isComposing || event.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key.toLowerCase() === 'l' || event.key.toLowerCase() === 'k') && !event.shiftKey) {
        event.preventDefault();
        insertLink();
        return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e' && !event.shiftKey) {
        event.preventDefault();
        rememberRange();
        openEmojiPicker();
        return;
    }
    if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const sel = window.getSelection();
        const line = sel && sel.isCollapsed ? getLineNode(sel) : null;
        if (line && line !== editorEl && /^H[1-4]$/.test(line.tagName) && !headingText(line)) {
            event.preventDefault();
            deleteNodesUndo([line]);
            return;
        }
        if (line && line !== editorEl && caretAtBlockStart(line, sel)) {
            const prev = line.previousElementSibling;
            if (prev && /^H[1-4]$/.test(prev.tagName) && !headingText(prev)) {
                event.preventDefault();
                deleteNodesUndo([prev]);
                return;
            }
        }
    }
    const headingDigit = /^Digit([1-4])$/.test(event.code) ? event.code.slice(5) : (/^[1-4]$/.test(event.key) ? event.key : '');
    if ((event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && headingDigit) {
        event.preventDefault();
        applyHeadingLevel(Number(headingDigit));
        return;
    }
    if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const sel = window.getSelection();
        const line = sel && sel.isCollapsed ? getLineNode(sel) : null;
        if (line && line !== editorEl && !(line.classList && line.classList.contains('code-block')) && sel.rangeCount) {
            const pre = document.createRange();
            pre.setStart(line, 0);
            pre.setEnd(sel.anchorNode, sel.anchorOffset);
            const marker = pre.toString().replace(/\u00a0/g, ' ');
            const level = marker.match(/^(#{1,4})$/);
            if (level) {
                event.preventDefault();
                retagHeading(line, level[1].length);
                return;
            }
        }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        const sel = window.getSelection();
        const line = sel && sel.rangeCount ? getLineNode(sel) : null;
        if (line && /^H[1-4]$/.test(line.tagName)) {
            event.preventDefault();
            const after = document.createElement('div');
            const tail = document.createRange();
            tail.setStart(sel.anchorNode, sel.anchorOffset);
            tail.setEnd(line, line.childNodes.length);
            after.appendChild(tail.extractContents());
            after.querySelectorAll('.heading-copy').forEach((node) => node.remove());
            if (!after.textContent) after.innerHTML = '<br>';
            if (!headingText(line)) line.appendChild(document.createElement('br'));
            line.after(after);
            const range = document.createRange();
            range.setStart(after, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            decorateHeadings();
            scheduleSave();
            return;
        }
        if (sel.isCollapsed) {
            const text = line ? line.textContent || '' : '';
            const match = text.match(/^(\d+)\.\s/);
            if (match && line) {
                if (text.trim() === match[0].trim()) {
                    event.preventDefault();
                    line.innerHTML = '<br>';
                    const range = document.createRange();
                    range.setStart(line, 0);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    scheduleSave();
                    return;
                }
                const next = parseInt(match[1], 10) + 1;
                requestAnimationFrame(() => document.execCommand('insertText', false, `${next}. `));
                return;
            }
        }
    }
    if (event.key === 'Tab') {
        event.preventDefault();
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const indent = '    ';
        if (!event.shiftKey && sel.getRangeAt(0).collapsed) {
            document.execCommand('insertText', false, indent);
        } else {
            linesOfSelection(sel).forEach((line) => {
                const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
                const first = walker.nextNode();
                if (event.shiftKey) {
                    if (first) first.textContent = first.textContent.replace(/^( {1,4}| {1,4}|\t)/, '');
                } else if (first) {
                    first.textContent = indent + first.textContent;
                } else {
                    line.insertBefore(document.createTextNode(indent), line.firstChild);
                }
            });
        }
        scheduleSave();
    }
});

document.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const key = event.key.toLowerCase();
    if (!((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && (key === 'l' || key === 'k'))) return;
    const sel = window.getSelection();
    const inEditor = document.activeElement === editorEl || editorEl.contains(document.activeElement) || (sel && sel.anchorNode && editorEl.contains(sel.anchorNode));
    if (!inEditor) return;
    event.preventDefault();
    event.stopPropagation();
    insertLink();
}, true);

(() => {
    const handle = document.getElementById('img-resize-handle');
    let startX = 0;
    let startWidth = 0;
    handle.addEventListener('mousedown', (event) => {
        if (!resizeImg || !editorWritable()) return;
        event.preventDefault();
        startX = event.clientX;
        startWidth = resizeImg.offsetWidth;
        document.addEventListener('mousemove', onResize);
        document.addEventListener('mouseup', onResizeEnd);
    });
    function onResize(event) {
        if (!resizeImg) return;
        const width = Math.max(40, startWidth + (event.clientX - startX));
        resizeImg.style.width = width + 'px';
        resizeImg.style.height = 'auto';
        positionHandle(resizeImg);
    }
    function onResizeEnd() {
        document.removeEventListener('mousemove', onResize);
        document.removeEventListener('mouseup', onResizeEnd);
        scheduleSave();
    }
    document.querySelector('.sheet').addEventListener('scroll', () => { if (resizeImg) positionHandle(resizeImg); });
    window.addEventListener('resize', () => { if (resizeImg) positionHandle(resizeImg); });
})();

treeHead.addEventListener('dragover', (e) => {
    e.preventDefault();
    treeHead.classList.add('drop');
});
treeHead.addEventListener('dragleave', () => treeHead.classList.remove('drop'));
treeHead.addEventListener('drop', (e) => {
    e.preventDefault();
    treeHead.classList.remove('drop');
    movePage(e.dataTransfer.getData('text/plain'), null);
});

if (localStorage.getItem('rbw-side') === 'closed') setSide(false);

refreshAuth().then(async () => {
    await load(currentId);
    await followHeadingLink();
});
window.addEventListener('hashchange', () => { followHeadingLink(); });
