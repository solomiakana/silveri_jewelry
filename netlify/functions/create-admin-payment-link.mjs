// POST /.netlify/functions/create-admin-payment-link  { orderID }
// Генерація посилання на оплату для клієнта, коли треба надіслати його повторно
// (наприклад, попередній інвойс прострочений). Сума береться з методу оплати
// замовлення — адмін її не вводить (архітектурний опис, 6.5).
import firebaseAdminPkg from './_firebaseAdmin.js';
import { requireAdmin } from '../lib/admin-auth.mjs';
import { evaluateCreatePayment } from '../lib/payment-engine.mjs';
import { getMonoClient, redirectUrlFor, webHookUrl } from '../lib/mono-env.mjs';
import { writeAudit } from '../lib/audit.mjs';
import { isBreakerOpen, recordMonoFailure, recordMonoSuccess } from '../lib/breaker.mjs';
import { json, okJson, badRequest, notFound, conflict, forbidden, badGateway, readJsonBody } from '../lib/http.mjs';
import { ORDER_ID_RE, LOCK_TTL_MS } from '../lib/payment-constants.mjs';
import { MonoApiError } from '../lib/mono-client.mjs';

const { getDb } = firebaseAdminPkg;
const VALIDITY_SEC = 24 * 3600; // довший термін для посилання, яке надсилає менеджер

export default async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'Метод не підтримується.' });

    const auth = await requireAdmin(req.headers.get('authorization'), { requireFreshAuth: true });
    if (auth.error === 'stale_auth') return json(401, { error: 'Увійдіть ще раз, щоб виконати цю дію.' });
    if (auth.error) return forbidden();

    const { value: body, error: bodyError } = await readJsonBody(req);
    if (bodyError) return badRequest();
    const { orderID } = body;
    if (typeof orderID !== 'string' || !ORDER_ID_RE.test(orderID)) return badRequest();

    const db = getDb();
    const orderRef = db.collection('orders').doc(orderID);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return notFound();
    const order = { ...orderSnap.data(), orderID: orderSnap.id };

    if (order.paymentMethod === 'fop') return conflict('Оплата на рахунок ФОП не потребує посилання.');

    let payment = null;
    if (order.invoiceId) {
        const snap = await db.collection('payments').doc(order.invoiceId).get();
        if (snap.exists) payment = { ...snap.data(), invoiceId: snap.id };
    }
    const decision = evaluateCreatePayment({ order, payment, now: new Date(), maxAttempts: Infinity });
    if (decision.action === 'already_paid') return conflict('Замовлення вже оплачене.');
    if (decision.action === 'reuse') return okJson({ pageUrl: decision.pageUrl, reused: true });
    if (decision.action === 'reject' && decision.code !== 'locked') {
        return conflict('Створити посилання на оплату для цього замовлення зараз не можна.');
    }
    if (decision.action === 'reject') return conflict('Триває інший запит на оплату цього замовлення.');

    if (await isBreakerOpen(db)) return badGateway('Mono тимчасово недоступний. Спробуйте пізніше.', 'mono_unavailable');

    const lockUntil = new Date(Date.now() + LOCK_TTL_MS);
    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(orderRef);
            const fresh = { ...snap.data(), orderID: snap.id };
            const recheck = evaluateCreatePayment({ order: fresh, payment, now: new Date(), maxAttempts: Infinity });
            if (recheck.action !== 'create') {
                const err = new Error('precondition_changed');
                err.recheck = recheck;
                throw err;
            }
            tx.set(orderRef, { paymentLock: { until: lockUntil } }, { merge: true });
        });
    } catch (e) {
        if (e?.recheck?.action === 'reuse') return okJson({ pageUrl: e.recheck.pageUrl, reused: true });
        return conflict('Триває інший запит на оплату цього замовлення.');
    }

    const mono = getMonoClient();
    if (decision.invalidateInvoiceId) {
        try {
            const status = await mono.getInvoiceStatus(decision.invalidateInvoiceId);
            if (status?.status === 'success') {
                await orderRef.set({ paymentLock: null }, { merge: true });
                return conflict('Замовлення вже оплачене.');
            }
            await mono.removeInvoice(decision.invalidateInvoiceId).catch(() => {});
        } catch (e) {
            if (!(e instanceof MonoApiError) || e.outcomeUnknown) {
                await orderRef.set({ paymentLock: null }, { merge: true });
                await recordMonoFailure(db);
                return badGateway('Оплата тимчасово недоступна. Спробуйте ще раз.', 'mono_unavailable');
            }
        }
    }

    let invoice;
    try {
        invoice = await mono.createInvoice({
            amountKop: order.onlineAmountKop,
            reference: orderID,
            destination: order.paymentMethod === 'cod' ? `Передплата за замовлення ${orderID}` : `Замовлення ${orderID}`,
            redirectUrl: redirectUrlFor(orderID),
            webHookUrl: webHookUrl(),
            validitySec: VALIDITY_SEC,
        });
        await recordMonoSuccess(db);
    } catch (e) {
        await orderRef.set({ paymentStatus: 'payment_error', paymentLock: null }, { merge: true });
        if (e instanceof MonoApiError && e.outcomeUnknown) await recordMonoFailure(db);
        return badGateway('Не вдалося створити посилання на оплату.', 'mono_unavailable');
    }

    try {
        await db.collection('payments').doc(invoice.invoiceId).create({
            invoiceId: invoice.invoiceId,
            orderID,
            provider: 'monobank',
            purpose: order.paymentMethod === 'cod' ? 'prepayment' : 'full',
            attempt: (order.attempts ?? 0) + 1,
            createdBy: auth.uid,
            status: 'created',
            amountKop: order.onlineAmountKop,
            ccy: 980,
            pageUrl: invoice.pageUrl,
            createdAt: new Date(),
            validUntil: new Date(Date.now() + VALIDITY_SEC * 1000),
            modifiedDate: null,
            cancelList: [],
        });
        await orderRef.set({
            paymentStatus: 'processing',
            invoiceId: invoice.invoiceId,
            attempts: (order.attempts ?? 0) + 1,
            lastInvoiceCreatedAt: new Date(),
            paymentLock: null,
        }, { merge: true });
    } catch (e) {
        console.error('create-admin-payment-link: не вдалося зафіксувати платіж', invoice.invoiceId, e);
        await orderRef.set({ paymentLock: null }, { merge: true }).catch(() => {});
        await mono.removeInvoice(invoice.invoiceId).catch(() => {});
        return badGateway('Не вдалося створити посилання на оплату.', 'mono_unavailable');
    }

    await writeAudit(db, { actorUid: auth.uid, actorEmail: auth.email, action: 'create_payment_link', orderID, invoiceId: invoice.invoiceId, req });
    return okJson({ pageUrl: invoice.pageUrl, reused: false });
};

export const config = {
    rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ['ip'] },
};
