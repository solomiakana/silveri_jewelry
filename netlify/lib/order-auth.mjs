// Автентифікація клієнтських платіжних запитів за statusToken (не Firebase Auth —
// клієнт не має акаунта). Помилка завжди повертається як "не знайдено", щоб не
// підтверджувати існування orderID стороннім (архітектурний опис, 8.1: перебір).
import { parseBearer, verifyToken } from './tokens.mjs';
import { ORDER_ID_RE } from './payment-constants.mjs';

/**
 * @returns { order } при успіху, або { error: 'not_found' } при будь-якій невдачі.
 *          order — прочитаний документ Firestore (order.orderID заповнене з doc.id).
 */
export async function requireOrderToken({ db, orderID, authorizationHeader }) {
    const token = parseBearer(authorizationHeader);
    if (typeof orderID !== 'string' || !ORDER_ID_RE.test(orderID) || !token) {
        return { error: 'not_found' };
    }
    const snap = await db.collection('orders').doc(orderID).get();
    if (!snap.exists) return { error: 'not_found' };
    const order = { ...snap.data(), orderID: snap.id };
    if (!order.statusTokenHash || !verifyToken(token, order.statusTokenHash)) {
        return { error: 'not_found' };
    }
    return { order };
}
