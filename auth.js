import fs from 'fs/promises';
import path from 'path';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCb);
const file = path.resolve('wiki-data', 'auth.json');
const sessionFile = path.resolve('wiki-data', 'sessions.json');
const sessions = new Map();

async function save(auth) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(auth, null, 2), 'utf-8');
}

export async function loadAuth() {
    try {
        const auth = JSON.parse(await fs.readFile(file, 'utf-8'));
        if (!auth.shareSpace) {
            auth.shareSpace = randomBytes(12).toString('base64url');
            await save(auth);
        }
        return auth;
    } catch {
        const auth = { shareSpace: randomBytes(12).toString('base64url'), password: null };
        await save(auth);
        return auth;
    }
}

export async function loadSessions() {
    try {
        const saved = JSON.parse(await fs.readFile(sessionFile, 'utf-8'));
        const now = Date.now();
        for (const [token, exp] of Object.entries(saved)) {
            if (exp > now) sessions.set(token, exp);
        }
    } catch { /* none yet */ }
}

async function persistSessions() {
    const data = Object.fromEntries(sessions);
    await fs.writeFile(sessionFile, JSON.stringify(data), 'utf-8');
}

export async function setPassword(password) {
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 32);
    const auth = await loadAuth();
    auth.password = { salt: salt.toString('base64'), hash: hash.toString('base64') };
    await save(auth);
    return auth;
}

export async function checkPassword(password, auth) {
    if (!auth.password) return false;
    const salt = Buffer.from(auth.password.salt, 'base64');
    const expected = Buffer.from(auth.password.hash, 'base64');
    const hash = await scrypt(String(password || ''), salt, 32);
    if (hash.length !== expected.length) return false;
    return timingSafeEqual(hash, expected);
}

export async function createSession() {
    const token = randomBytes(24).toString('base64url');
    sessions.set(token, Date.now() + 30 * 24 * 3600 * 1000);
    await persistSessions();
    return token;
}

export async function dropSession(token) {
    sessions.delete(token);
    await persistSessions();
}

export function validSession(token) {
    if (!token || !sessions.has(token)) return false;
    if (sessions.get(token) < Date.now()) {
        sessions.delete(token);
        return false;
    }
    return true;
}
