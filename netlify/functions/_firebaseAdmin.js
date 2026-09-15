// Спільна ініціалізація Firebase Admin SDK для всіх Netlify Functions.
// Сервісний акаунт береться зі змінної середовища FIREBASE_SERVICE_ACCOUNT
// (весь вміст JSON-файлу ключа, одним рядком) — ніколи не потрапляє в код чи на клієнт.
const admin = require('firebase-admin');

let db = null;

function getDb() {
    if (db) return db;

    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        throw new Error('Змінна середовища FIREBASE_SERVICE_ACCOUNT не налаштована в Netlify.');
    }

    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
    }

    db = admin.firestore();
    return db;
}

module.exports = { getDb };
