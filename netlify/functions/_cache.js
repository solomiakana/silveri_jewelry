// Проста обгортка "прочитати з кешу Firestore, або обчислити і зберегти".
const { getDb } = require('./_firebaseAdmin');

/**
 * @param {string} collection   Назва колекції Firestore (напр. "postal_cities")
 * @param {string} docId        Унікальний ключ запису (провайдер + запит/CityRef)
 * @param {number} ttlMs        Скільки мілісекунд кеш вважається свіжим
 * @param {() => Promise<any>} fetchFresh  Функція, яка робить реальний виклик зовнішнього API
 */
async function getCached(collection, docId, ttlMs, fetchFresh) {
    const db = getDb();
    const ref = db.collection(collection).doc(docId);
    const snap = await ref.get();

    if (snap.exists) {
        const data = snap.data();
        const age = Date.now() - (data.updatedAt || 0);
        if (age < ttlMs) {
            return { data: data.results, fromCache: true };
        }
    }

    const fresh = await fetchFresh();

    // Порожню відповідь не кешуємо: так випадкові запити (сміття у q, вигадані cityRef)
    // не розростають колекцію необмежено. Реальні міста/відділення порожніми не бувають.
    if (Array.isArray(fresh) && fresh.length === 0) {
        return { data: fresh, fromCache: false };
    }

    // expireAt — для політики TTL у Firestore (Firebase Console → Firestore → TTL):
    // документи, до яких не зверталися два TTL, видаляються автоматично.
    await ref.set({
        results: fresh,
        updatedAt: Date.now(),
        expireAt: new Date(Date.now() + ttlMs * 2),
    });
    return { data: fresh, fromCache: false };
}

module.exports = { getCached };
