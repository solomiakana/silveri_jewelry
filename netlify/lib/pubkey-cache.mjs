// Кешування публічного ключа Mono (для перевірки x-sign).
//   1. Пам'ять інстансу функції (переживає кілька викликів на "теплому" інстансі).
//   2. Firestore (config/mono_pubkey) — спільний кеш між інстансами й деплоями.
//   3. GET /api/merchant/pubkey — лише коли жодного з кешів немає, і не частіше ніж
//      раз на REFETCH_COOLDOWN_MS при невдалій перевірці підпису (архітектурний опис, 7.2, крок 3):
//      без цього обмеження підроблені запити з невалідним підписом змусили б нас щоразу
//      звертатися до Mono й ризикувати впертися в 429.
const REFETCH_COOLDOWN_MS = 5 * 60 * 1000;

let memKey = null;       // { key, at }
let lastRefetchAt = 0;

export function _resetPubkeyCacheForTests() {
    memKey = null;
    lastRefetchAt = 0;
}

async function loadFromFirestore(db) {
    const snap = await db.collection('config').doc('mono_pubkey').get();
    return snap.exists ? snap.data().key ?? null : null;
}

async function saveToFirestore(db, key) {
    await db.collection('config').doc('mono_pubkey').set(
        { key, updatedAt: new Date() },
        { merge: true },
    );
}

async function fetchAndStore(db, monoClient) {
    const key = await monoClient.getPublicKey();
    memKey = { key, at: Date.now() };
    lastRefetchAt = Date.now();
    // best-effort: якщо Firestore недоступний, працюємо далі лише з пам'яттю інстансу
    await saveToFirestore(db, key).catch(() => {});
    return key;
}

/**
 * Повертає поточний публічний ключ (не гарантує свіжості — для першого запиту).
 */
export async function getMonoPublicKey({ db, monoClient }) {
    if (memKey) return memKey.key;
    const stored = await loadFromFirestore(db).catch(() => null);
    if (stored) {
        memKey = { key: stored, at: Date.now() };
        return stored;
    }
    return fetchAndStore(db, monoClient);
}

/**
 * Викликається, коли перевірка підпису з поточним ключем провалилась. Ключ міг ротуватися.
 * Робить не більше одного реального запиту до Mono за REFETCH_COOLDOWN_MS; повертає новий
 * ключ або null, якщо перезапит зараз не дозволений (щоб виклик функції не чекав на Mono).
 */
export async function refetchMonoPublicKey({ db, monoClient }) {
    if (Date.now() - lastRefetchAt < REFETCH_COOLDOWN_MS) return null;
    return fetchAndStore(db, monoClient);
}
