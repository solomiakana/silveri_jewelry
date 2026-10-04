// POST /.netlify/functions/cancel-payment  { orderID, invoiceId, reason }
// Повне повернення коштів. Сума не приймається від клієнта — сервер бере її з
// payments/{invoiceId}.amountKop. Алгоритм — архітектурний опис, 7.4.
import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import firebaseAdminPkg from './_firebaseAdmin.js';
import { requireAdmin } from '../lib/admin-auth.mjs';
import { evaluateRefund } from '../lib/payment-engine.mjs';
import { getMonoClient } from '../lib/mono-env.mjs';
import { writeAudit } from '../lib/audit.mjs';
import { json, okJson, badRequest, notFound, conflict, forbidden, badGateway, readJsonBody } from '../lib/http.mjs';
import { ORDER_ID_RE, INVOICE_ID_RE } from '../lib/payment-constants.mjs';
import { MonoApiError } from '../lib/mono-client.mjs';

const { getDb } = firebaseAdminPkg;
const MAX_REASON_LEN = 300;
const DAILY_REFUND_LIMIT = 1; // аварійний запобіжник (розділ 8.1); точні бізнес-ліміти уточнюються окремо

export default async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'Метод не підтримується.' });

    const auth = await requireAdmin(req.headers.get('authorization'), { requireFreshAuth: true });
    if (auth.error === 'stale_auth') return json(401, { error: 'Увійдіть ще раз, щоб виконати цю дію.' });
    if (auth.error) return forbidden();

    const { value: body, error: bodyError } = await readJsonBody(req);
    if (bodyError) return badRequest();
    const { orderID, invoiceId, reason } = body;
    if (typeof orderID !== 'string' || !ORDER_ID_RE.test(orderID)) return badRequest();
    if (typeof invoiceId !== 'string' || !INVOICE_ID_RE.test(invoiceId)) return badRequest();
    const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, MAX_REASON_LEN) : '';
    if (!cleanReason) return badRequest('Вкажіть причину повернення.');

    const db = getDb();

    // Денний ліміт кількості повернень (аварійний запобіжник, не заміна ручного контролю).
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const recent = await db.collection('refunds').where('requestedAt', '>=', dayAgo).limit(DAILY_REFUND_LIMIT + 1).get();
    if (recent.size > DAILY_REFUND_LIMIT) return json(429, { error: 'Досягнуто денний ліміт повернень. Зверніться до розробника.' });

    const [orderSnap, paymentSnap] = await Promise.all([
        db.collection('orders').doc(orderID).get(),
        db.collection('payments').doc(invoiceId).get(),
    ]);
    if (!orderSnap.exists) return notFound();
    const order = { ...orderSnap.data(), orderID: orderSnap.id };
    const payment = paymentSnap.exists ? { ...paymentSnap.data(), invoiceId: paymentSnap.id } : null;

    const decision = evaluateRefund({ order, payment });
    if (!decision.ok) return conflict('Повернення для цього платежу зараз неможливе.', { code: decision.code });

    const extRef = randomUUID();
    const orderRef = db.collection('orders').doc(orderID);

    // Крок A: резервування суми (окрема транзакція, до виклику Mono).
    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(orderRef);
            const fresh = { ...snap.data(), orderID: snap.id };
            const recheck = evaluateRefund({ order: fresh, payment });
            if (!recheck.ok) { const err = new Error('precondition_changed'); err.code = recheck.code; throw err; }
            tx.set(db.collection('refunds').doc(extRef), {
                orderID, invoiceId, amountKop: decision.amountKop, reason: cleanReason,
                requestedBy: auth.uid, requestedAt: new Date(), status: 'requested', source: 'admin',
            });
            // Інкремент, а не "прочитати+додати руками": безпечно при повторі транзакції.
            const patch = { refundPendingKop: FieldValue.increment(decision.amountKop) };
            if (decision.scope === 'order') patch.paymentStatus = 'refunding';
            tx.set(orderRef, patch, { merge: true });
        });
    } catch (e) {
        return conflict('Повернення для цього платежу зараз неможливе.', { code: e.code ?? 'conflict' });
    }

    // Крок B: виклик Mono.
    const mono = getMonoClient();
    let monoStatus;
    try {
        const res = await mono.cancelInvoice({ invoiceId, extRef });
        monoStatus = res?.status ?? 'processing';
    } catch (e) {
        const unknown = e instanceof MonoApiError && e.outcomeUnknown;
        await db.collection('refunds').doc(extRef).set({ status: unknown ? 'unknown' : 'failure' }, { merge: true });
        if (!unknown) {
            // Точно не виконалось — знімаємо резерв і повертаємо попередній статус (paid/prepaid).
            await orderRef.set({
                refundPendingKop: FieldValue.increment(-decision.amountKop),
                ...(decision.scope === 'order' ? { paymentStatus: order.paymentStatus } : {}),
            }, { merge: true }).catch(() => {});
        }
        await writeAudit(db, { actorUid: auth.uid, actorEmail: auth.email, action: 'cancel_payment_failed', orderID, invoiceId, req, details: { extRef, unknown } });
        return badGateway(
            unknown ? 'Не вдалося підтвердити повернення. Стан буде перевірено автоматично.' : 'Не вдалося виконати повернення.',
            'mono_unavailable',
        );
    }

    await db.collection('refunds').doc(extRef).set({ status: monoStatus === 'success' ? 'processing' : monoStatus }, { merge: true });
    await writeAudit(db, { actorUid: auth.uid, actorEmail: auth.email, action: 'cancel_payment', orderID, invoiceId, req, details: { extRef, amountKop: decision.amountKop, reason: cleanReason } });

    return okJson({ extRef, status: monoStatus });
};

export const config = {
    rateLimit: { windowLimit: 3, windowSize: 60, aggregateBy: ['ip'] },
};
