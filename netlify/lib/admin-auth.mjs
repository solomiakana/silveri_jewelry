// Автентифікація адмінських платіжних функцій. Клієнт (адмінка) передає Firebase ID token
// у заголовку Authorization: Bearer <idToken>. Перевіряємо:
//   1. сам токен — з перевіркою ВІДКЛИКАННЯ (checkRevoked): якщо адміна відключили або
//      скинули йому пароль / сесії, його старий токен перестає діяти одразу, а не за годину;
//   2. що email підтверджений (захист від акаунтів із чужою/вигаданою поштою);
//   3. (опційно) що email входить до білого списку ADMIN_EMAILS;
//   4. (опційно) що вхід пройшов другий фактор — ADMIN_REQUIRE_MFA=true;
//   5. що існує документ /admins/{uid} (той самий критерій, що й у Firestore Rules);
//   6. для чутливих операцій (гроші) — "свіжість" входу (auth_time не старший за 5 хв).
//
// Змінні середовища (Netlify), усі необов'язкові:
//   ADMIN_EMAILS                      "a@x.com,b@x.com" — якщо задано, лише ці email пройдуть
//   ADMIN_REQUIRE_MFA                 "true" — вимагати другий фактор у токені
//   ADMIN_SKIP_EMAIL_VERIFIED_CHECK   "true" — АВАРІЙНО вимкнути п. 2 (див. примітку нижче)
//
// УВАГА: акаунти, створені вручну в Firebase Console, мають emailVerified=false.
// Перед деплоєм переконайтесь, що email адміна підтверджено, інакше він не зможе увійти
// в платіжні функції.
import firebaseAdminPkg from '../functions/_firebaseAdmin.js';
import adminPkg from 'firebase-admin';

const { getDb } = firebaseAdminPkg;
export const FRESH_AUTH_MAX_AGE_MS = 5 * 60 * 1000;

const isOn = (v) => ['true', '1', 'yes'].includes(String(v ?? '').trim().toLowerCase());

function parseEmailList(raw) {
    return String(raw ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * @param requireFreshAuth  Якщо true, відхиляє токен, виданий понад ~5 хв тому
 *                          (auth_time), навіть якщо сам ID-токен ще дійсний.
 * @param deps              Лише для тестів: { auth, db, env, now }.
 * @returns { uid, email } при успіху, або { error } при невдачі.
 *          error: unauthenticated | forbidden | mfa_required | stale_auth
 */
export async function requireAdmin(authorizationHeader, { requireFreshAuth = false, deps = {} } = {}) {
    const env = deps.env ?? process.env;
    const now = deps.now ?? Date.now;

    const m = /^Bearer\s+(\S+)$/i.exec(String(authorizationHeader || '').trim());
    if (!m) return { error: 'unauthenticated' };

    let decoded;
    try {
        // getDb() ініціалізує firebase-admin app, якщо це перший виклик у функції.
        const authClient = deps.auth ?? (getDb(), adminPkg.auth());
        // Другий аргумент true = checkRevoked: токен відкликаного/відключеного користувача відхиляється.
        decoded = await authClient.verifyIdToken(m[1], true);
    } catch {
        return { error: 'unauthenticated' };
    }

    if (!isOn(env.ADMIN_SKIP_EMAIL_VERIFIED_CHECK) && decoded.email_verified !== true) {
        return { error: 'forbidden' };
    }

    const allowed = parseEmailList(env.ADMIN_EMAILS);
    if (allowed.length > 0) {
        const email = String(decoded.email ?? '').toLowerCase();
        if (!email || !allowed.includes(email)) return { error: 'forbidden' };
    }

    // sign_in_second_factor присутній у токені лише якщо вхід пройшов через MFA.
    if (isOn(env.ADMIN_REQUIRE_MFA) && !decoded.firebase?.sign_in_second_factor) {
        return { error: 'mfa_required' };
    }

    let adminDoc;
    try {
        const db = deps.db ?? getDb();
        adminDoc = await db.collection('admins').doc(decoded.uid).get();
    } catch {
        return { error: 'unauthenticated' };
    }
    if (!adminDoc.exists) return { error: 'forbidden' };

    // Свіжість перевіряємо ПІСЛЯ підтвердження, що це адмін: сторонній (не-адмін) користувач
    // завжди отримує однакове "forbidden" і не дізнається нічого про стан сесій.
    if (requireFreshAuth) {
        const authTimeMs = Number(decoded.auth_time) * 1000;
        if (!Number.isFinite(authTimeMs) || now() - authTimeMs > FRESH_AUTH_MAX_AGE_MS) {
            return { error: 'stale_auth' };
        }
    }

    return { uid: decoded.uid, email: decoded.email ?? null };
}
