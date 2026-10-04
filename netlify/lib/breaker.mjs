// Circuit breaker до Mono (архітектурний опис, 8.2, шар 3): після кількох поспіль
// збоїв (таймаут/мережа/5xx) на короткий час перестаємо викликати Mono і одразу
// віддаємо клієнту "оплата тимчасово недоступна". Стан спільний між інстансами
// через Firestore (config/breaker), бо функції не мають спільної пам'яті.
const FAILURE_THRESHOLD = 3;
const OPEN_MS = 45_000;

const REF = (db) => db.collection('config').doc('breaker');

// openUntil зберігається як epoch-мілісекунди (число), а не Date/Timestamp — так порівняння
// "чи ще відкрито" не залежить від того, як конкретний драйвер Firestore читає часові поля.
export async function isBreakerOpen(db) {
    const snap = await REF(db).get();
    if (!snap.exists) return false;
    const until = snap.data()?.openUntil ?? null;
    return typeof until === 'number' && until > Date.now();
}

// Викликати після невдалого запиту до Mono, де outcome невідомий (timeout/network/server).
export async function recordMonoFailure(db) {
    await db.runTransaction(async (tx) => {
        const ref = REF(db);
        const snap = await tx.get(ref);
        const count = (snap.exists ? snap.data()?.failureCount ?? 0 : 0) + 1;
        const patch = { failureCount: count, lastFailureAt: new Date() };
        if (count >= FAILURE_THRESHOLD) {
            patch.openUntil = Date.now() + OPEN_MS;
            patch.failureCount = 0;
        }
        tx.set(ref, patch, { merge: true });
    }).catch(() => {}); // best-effort: збій запису не повинен ламати основний запит
}

export async function recordMonoSuccess(db) {
    await REF(db).set({ failureCount: 0 }, { merge: true }).catch(() => {});
}
