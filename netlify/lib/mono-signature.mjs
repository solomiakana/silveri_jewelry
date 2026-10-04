import { createPublicKey, createVerify } from 'node:crypto';

// Mono віддає ключ як base64 від PEM (x.509 SubjectPublicKeyInfo, ECDSA).
// Приймаємо також голий PEM і base64 від DER — про всяк випадок.
export function parseMonoPublicKey(keyString) {
    if (typeof keyString !== 'string' || !keyString.trim()) {
        throw new TypeError('Порожній публічний ключ');
    }
    const s = keyString.trim();
    if (s.includes('BEGIN PUBLIC KEY')) {
        return createPublicKey(s);
    }
    const decoded = Buffer.from(s, 'base64');
    const asText = decoded.toString('utf8');
    if (asText.includes('BEGIN PUBLIC KEY')) {
        return createPublicKey(asText);
    }
    return createPublicKey({ key: decoded, format: 'der', type: 'spki' });
}

// Перевірка підпису вебхука.
//   rawBody   — точне тіло запиту (string або Buffer), НЕ результат JSON.stringify(JSON.parse(...))
//   signature — значення заголовка x-sign (base64, DER-підпис ECDSA)
//   publicKey — KeyObject або рядок ключа з /api/merchant/pubkey
// Повертає true/false, ніколи не кидає.
export function verifyMonoSignature({ rawBody, signature, publicKey }) {
    try {
        if (rawBody === undefined || rawBody === null) return false;
        if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
        const key = typeof publicKey === 'string' ? parseMonoPublicKey(publicKey) : publicKey;
        const sig = Buffer.from(signature, 'base64');
        if (sig.length === 0) return false;
        const verifier = createVerify('SHA256');
        verifier.update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody);
        verifier.end();
        return verifier.verify(key, sig);
    } catch {
        return false;
    }
}
