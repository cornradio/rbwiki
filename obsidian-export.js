import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { getUploadsDir } from './data-manager.js';

function decode(text) {
    return String(text || '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

function attrs(raw) {
    const out = {};
    const re = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    let match;
    while ((match = re.exec(raw || ''))) out[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? '');
    return out;
}

function parseHtml(html) {
    const root = { tag: '#root', children: [] };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)>|<([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g;
    let match;
    while ((match = re.exec(String(html || '')))) {
        if (match[1]) {
            const tag = match[1].toLowerCase();
            while (stack.length > 1 && stack[stack.length - 1].tag !== tag) stack.pop();
            if (stack.length > 1) stack.pop();
            continue;
        }
        if (match[2]) {
            const node = { tag: match[2].toLowerCase(), attrs: attrs(match[3]), children: [] };
            stack[stack.length - 1].children.push(node);
            if (!match[4] && !['br', 'img', 'hr'].includes(node.tag)) stack.push(node);
            continue;
        }
        if (match[5]) stack[stack.length - 1].children.push({ text: decode(match[5]) });
    }
    return root;
}

function classHas(node, name) {
    return ` ${(node.attrs && node.attrs.class) || ''} `.includes(` ${name} `);
}

function uploadName(url) {
    const clean = String(url || '').split('?')[0];
    const match = clean.match(/\/uploads\/([^/]+)$/);
    if (!match) return '';
    const name = match[1];
    if (name.includes('..')) return '';
    return name;
}

function renderInline(node, ctx) {
    if (node.text != null) return node.text.replace(/\u00a0/g, ' ');
    const kids = () => (node.children || []).map((child) => renderInline(child, ctx)).join('');
    if (node.tag === 'br') return '\n';
    if (node.tag === 'img') {
        const name = uploadName(node.attrs.src);
        if (name) {
            ctx.uploads.add(name);
            return `![[attachments/${name}]]`;
        }
        const src = (node.attrs && node.attrs.src) || '';
        if (!src) return '';
        return `![${node.attrs.alt || ''}](${src})`;
    }
    if (node.tag === 'a') {
        const label = kids().replace(/\s*\([^)]*\)\s*$/, '').trim();
        const pageId = node.attrs['data-page'];
        if (classHas(node, 'wikilink') && pageId && ctx.linkFor(pageId)) {
            const target = ctx.linkFor(pageId);
            return label && label !== target ? `[[${target}|${label}]]` : `[[${target}]]`;
        }
        const file = uploadName(node.attrs.href);
        if (file) {
            ctx.uploads.add(file);
            return `[${label || file}](attachments/${file})`;
        }
        const href = node.attrs.href || '';
        if (!href || href === '#') return label;
        return `[${label || href}](${href})`;
    }
    if (node.tag === 'strong' || node.tag === 'b') return `**${kids()}**`;
    if (node.tag === 'em' || node.tag === 'i') return `*${kids()}*`;
    if (node.tag === 'code') return `\`${kids()}\``;
    if (classHas(node, 'heading-copy') || classHas(node, 'code-bar')) return '';
    return kids();
}

function renderBlocks(nodes, ctx) {
    const out = [];
    nodes.forEach((node) => {
        if (node.text != null) {
            const text = node.text.replace(/\u00a0/g, ' ').trim();
            if (text) out.push(text);
            return;
        }
        if (classHas(node, 'code-bar') || classHas(node, 'heading-copy')) return;
        if (classHas(node, 'code-block') || node.tag === 'pre') {
            const pre = classHas(node, 'code-block')
                ? (node.children || []).find((child) => child.tag === 'pre')
                : node;
            const text = pre ? renderInline(pre, ctx).replace(/\n$/, '') : '';
            out.push('```\n' + text + '\n```');
            return;
        }
        if (/^h[1-6]$/.test(node.tag)) {
            const level = Math.min(6, Number(node.tag.slice(1)));
            out.push('#'.repeat(level) + ' ' + renderInline(node, ctx).trim());
            return;
        }
        if (node.tag === 'ul' || node.tag === 'ol') {
            const items = (node.children || []).filter((child) => child.tag === 'li');
            out.push(items.map((item, index) => {
                const mark = node.tag === 'ol' ? `${index + 1}. ` : '- ';
                return mark + renderInline(item, ctx).trim();
            }).join('\n'));
            return;
        }
        if (node.tag === 'blockquote') {
            const text = renderBlocks(node.children || [], ctx);
            out.push(text.split('\n').map((line) => '> ' + line).join('\n'));
            return;
        }
        if (node.tag === 'p' || node.tag === 'div' || node.tag === 'li' || node.tag === 'img' || node.tag === 'a' || node.tag === 'span') {
            const text = renderInline(node, ctx).trim();
            if (text) out.push(text);
            return;
        }
        const nested = renderBlocks(node.children || [], ctx);
        if (nested) out.push(nested);
    });
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function safeSegment(title) {
    const name = String(title || '未命名').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '未命名';
    return name.slice(0, 80);
}

export function buildObsidianVault(pages) {
    const live = (pages || []).filter((page) => page && !page.deletedAt);
    const byId = new Map(live.map((page) => [page.id, page]));
    const childCount = new Map();
    live.forEach((page) => {
        if (page.parentId && byId.has(page.parentId)) childCount.set(page.parentId, (childCount.get(page.parentId) || 0) + 1);
    });
    const used = new Set();
    const pathFor = new Map();
    const ordered = [...live].sort((a, b) => (a.order || 0) - (b.order || 0));
    ordered.forEach((page) => {
        const chain = [];
        const seen = new Set();
        let cur = page;
        while (cur && !seen.has(cur.id)) {
            seen.add(cur.id);
            chain.unshift(cur);
            cur = cur.parentId ? byId.get(cur.parentId) : null;
        }
        const parts = [];
        chain.forEach((node, index) => {
            const name = safeSegment(node.title);
            const last = index === chain.length - 1;
            const hasKids = childCount.has(node.id);
            if (last && !hasKids) parts.push(name + '.md');
            else parts.push(name);
            if (last && hasKids) parts.push(name + '.md');
        });
        let rel = parts.join('/');
        if (used.has(rel)) {
            const stem = rel.replace(/\.md$/, '');
            let n = 2;
            while (used.has(`${stem} (${n}).md`)) n += 1;
            rel = `${stem} (${n}).md`;
        }
        used.add(rel);
        pathFor.set(page.id, rel);
    });
    const linkFor = (id) => {
        const rel = pathFor.get(id);
        return rel ? rel.replace(/\.md$/, '') : '';
    };
    const uploads = new Set();
    const notes = ordered.map((page) => {
        const tree = parseHtml(page.content || '');
        const markdown = renderBlocks(tree.children, { uploads, linkFor });
        return { path: pathFor.get(page.id), markdown };
    });
    return { notes, uploads: [...uploads] };
}

export function archiveObsidian(pages) {
    const built = buildObsidianVault(pages);
    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.append('{}\n', { name: '.obsidian/app.json' });
    for (const note of built.notes) archive.append(note.markdown + '\n', { name: note.path });
    const uploads = getUploadsDir();
    for (const name of built.uploads) {
        const full = path.join(uploads, path.basename(name));
        if (fs.existsSync(full)) archive.file(full, { name: 'attachments/' + path.basename(name) });
    }
    archive.finalize();
    return archive;
}
