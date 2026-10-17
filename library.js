import fs from 'fs/promises';
import path from 'path';
import archiver from 'archiver';
import AdmZip from 'adm-zip';

const pagesDir = path.resolve('wiki-data', 'pages');
const uploadsDir = path.resolve('wiki-data', 'uploads');

export async function archiveLibrary() {
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.mkdir(uploadsDir, { recursive: true });
    const archive = archiver('zip', { store: true });
    archive.directory(pagesDir, 'pages');
    archive.directory(uploadsDir, 'uploads');
    archive.finalize();
    return archive;
}

export async function importLibrary(zipPath) {
    const zip = new AdmZip(zipPath);
    const pageEntries = [];
    const uploadEntries = [];
    for (const entry of zip.getEntries()) {
        const name = entry.entryName.replace(/\\/g, '/');
        if (name.includes('..') || name.startsWith('/')) throw new Error('压缩包路径不合法');
        if (entry.isDirectory) continue;
        if (name.startsWith('pages/') && name.endsWith('.json')) pageEntries.push(entry);
        else if (name.startsWith('uploads/')) uploadEntries.push(entry);
    }
    if (!pageEntries.length) throw new Error('压缩包里没有页面');

    await fs.mkdir(pagesDir, { recursive: true });
    await fs.mkdir(uploadsDir, { recursive: true });
    for (const file of await fs.readdir(pagesDir)) {
        if (file.endsWith('.json')) await fs.unlink(path.join(pagesDir, file));
    }
    for (const entry of pageEntries) {
        const base = path.basename(entry.entryName);
        if (!/^[\w.-]+\.json$/.test(base)) continue;
        await fs.writeFile(path.join(pagesDir, base), entry.getData());
    }
    for (const entry of uploadEntries) {
        const base = path.basename(entry.entryName);
        if (!base || base.includes('..')) continue;
        await fs.writeFile(path.join(uploadsDir, base), entry.getData());
    }
    return { pages: pageEntries.length, uploads: uploadEntries.length };
}
