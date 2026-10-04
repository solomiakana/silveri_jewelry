import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// Токен замовлення: 128 біт випадковості, base64url -> 22 символи.
// Клієнту віддаємо сам токен, у базі зберігаємо лише SHA-256.
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export function generateStatusToken() {
    return randomBytes(16).toString('base64url');
}

export function hashToken(token) {
    return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// Порівняння у постійний час. Будь-яка некоректність -> false.
export function verifyToken(token, storedHash) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
    if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
    const a = Buffer.from(hashToken(token), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
}

// "Authorization: Bearer <token>" -> token або null.
export function parseBearer(headerValue) {
    if (typeof headerValue !== 'string') return null;
    const m = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
    return m ? m[1] : null;
}

// Ідентифікатор замовлення: SIL- + 10 символів Crockford base32 (50 біт).
// Кожен байт маскуємо до 5 біт (256 кратне 32), тому розподіл рівномірний.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateOrderId() {
    const bytes = randomBytes(10);
    let out = 'SIL-';
    for (const b of bytes) out += ALPHABET[b & 31];
    return out;
}
