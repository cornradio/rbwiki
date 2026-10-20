import fs from 'fs/promises';
import path from 'path';
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
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

export async function setHomePath(homePath) {
    const auth = await loadAuth();
    auth.homePath = homePath;
    await save(auth);
    return auth;
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

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encodeBase32(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out;
}

export function decodeBase32(text) {
    const clean = String(text || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = BASE32.indexOf(ch);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

export function totpCode(secret, at = Date.now(), step = 30) {
    const counter = Math.floor(at / 1000 / step);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const hmac = createHmac('sha1', decodeBase32(secret)).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 15;
    const bin = ((hmac[offset] & 127) << 24)
        | (hmac[offset + 1] << 16)
        | (hmac[offset + 2] << 8)
        | hmac[offset + 3];
    return String(bin % 1000000).padStart(6, '0');
}

export function verifyTotp(secret, code, skew = 1) {
    const digits = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(digits)) return false;
    const now = Date.now();
    const given = Buffer.from(digits);
    for (let i = -skew; i <= skew; i += 1) {
        const expect = Buffer.from(totpCode(secret, now + i * 30000));
        if (expect.length === given.length && timingSafeEqual(expect, given)) return true;
    }
    return false;
}

export function totpEnabled(auth) {
    return !!(auth && auth.totp && auth.totp.enabled && auth.totp.secret);
}

export async function setBrowseLocked(locked) {
    const auth = await loadAuth();
    auth.browseLocked = !!locked;
    await save(auth);
    return auth;
}

export async function beginTotp() {
    const auth = await loadAuth();
    const secret = encodeBase32(randomBytes(20));
    auth.totpPending = { secret, exp: Date.now() + 10 * 60 * 1000 };
    await save(auth);
    return { auth, secret };
}

export async function confirmTotp(code) {
    const auth = await loadAuth();
    const pending = auth.totpPending;
    if (!pending || pending.exp < Date.now()) return { auth, ok: false, error: '配对已过期，重新扫一次' };
    if (!verifyTotp(pending.secret, code)) return { auth, ok: false, error: '验证码不对' };
    auth.totp = { enabled: true, secret: pending.secret };
    delete auth.totpPending;
    await save(auth);
    return { auth, ok: true };
}

export async function disableTotp(code) {
    const auth = await loadAuth();
    if (!totpEnabled(auth)) return { auth, ok: true };
    if (!verifyTotp(auth.totp.secret, code)) return { auth, ok: false, error: '验证码不对' };
    delete auth.totp;
    delete auth.totpPending;
    await save(auth);
    return { auth, ok: true };
}
