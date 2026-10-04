// Перевірка токена Firebase App Check на серверній функції.
// Клієнт (script.js) отримує токен через reCAPTCHA Enterprise і надсилає його в заголовку
// X-Firebase-AppCheck. Без нього запит не від нашого сайту (curl, бот-скрипт).
// Перевірка локальна (підпис JWT за публічними ключами Google), без запитів до Firestore.
//
// Увага: адмін-SDK має бути вже ініціалізований (виклик getDb() із _firebaseAdmin.js).

export const APP_CHECK_HEADER = 'x-firebase-appcheck';

// -> { ok: true } | { ok: false, reason: 'missing' | 'invalid' }
export async function checkAppCheck(req, admin) {
    const token = req.headers.get(APP_CHECK_HEADER);
    if (!token) return { ok: false, reason: 'missing' };
    try {
        await admin.appCheck().verifyToken(token);
        return { ok: true };
    } catch {
        return { ok: false, reason: 'invalid' };
    }
}

// Перемикач: APP_CHECK_ENFORCE=false у Netlify вимикає відмову (запит лише логується).
// За замовчуванням перевірка обов'язкова.
export function appCheckEnforced() {
    return process.env.APP_CHECK_ENFORCE !== 'false';
}
