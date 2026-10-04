// POST /.netlify/functions/mark-paid  { orderID }
// Ручне підтвердження оплати менеджером: fop (pending -> paid) і остаточна оплата
// cod (prepaid -> paid, після отримання залишку). Онлайн-замовлення не чіпає —
// їх переводить лише вебхук/звірка. Замінює прямий updateDoc з адмінки (архітектурний опис, 6.7).
import firebaseAdminPkg from './_firebaseAdmin.js';
import { requireAdmin } from '../lib/admin-auth.mjs';
import { evaluateMarkPaid } from '../lib/payment-engine.mjs';
import { writeAudit } from '../lib/audit.mjs';
import { json, okJson, badRequest, notFound, conflict, forbidden, readJsonBody } from '../lib/http.mjs';
import { ORDER_ID_RE } from '../lib/payment-constants.mjs';

const { getDb } = firebaseAdminPkg;

export default async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'Метод не підтримується.' });

    // Ручне підтвердження оплати — фінансова дія, тож вимагає "свіжого" входу так само,
    // як повернення коштів і створення посилань на оплату.
    const auth = await requireAdmin(req.headers.get('authorization'), { requireFreshAuth: true });
    if (auth.error === 'stale_auth') return json(401, { error: 'Увійдіть ще раз, щоб виконати цю дію.' });
    if (auth.error) return forbidden();

    const { value: body, error: bodyError } = await readJsonBody(req);
    if (bodyError) return badRequest();
    const { orderID } = body;
    if (typeof orderID !== 'string' || !ORDER_ID_RE.test(orderID)) return badRequest();

    const db = getDb();
    const orderRef = db.collection('orders').doc(orderID);
    let outcome;
    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(orderRef);
            if (!snap.exists) { outcome = { ok: false, code: 'not_found' }; return; }
            const order = { ...snap.data(), orderID: snap.id };
            const decision = evaluateMarkPaid({ order });
            outcome = decision;
            if (!decision.ok) return;
            tx.set(orderRef, { paymentStatus: decision.to, paidAt: new Date() }, { merge: true });
        });
    } catch (e) {
        console.error('mark-paid: помилка транзакції', e);
        return conflict('Не вдалося позначити замовлення оплаченим.');
    }

    if (!outcome.ok) {
        return outcome.code === 'not_found' ? notFound() : conflict('Цей перехід не дозволений для поточного стану замовлення.');
    }

    await writeAudit(db, { actorUid: auth.uid, actorEmail: auth.email, action: 'mark_paid', orderID, req });
    return okJson({ paymentStatus: outcome.to });
};

export const config = {
    rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ['ip'] },
};
