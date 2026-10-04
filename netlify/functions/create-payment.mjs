// POST /.netlify/functions/create-payment
// Створює (або повторно віддає) інвойс monobank для замовлення. Викликається клієнтом
// за statusToken, отриманим від create-order. Алгоритм — архітектурний опис, розділ 7.1.
import firebaseAdminPkg from './_firebaseAdmin.js';
import { evaluateCreatePayment } from '../lib/payment-engine.mjs';
import { requireOrderToken } from '../lib/order-auth.mjs';
import { getMonoClient, redirectUrlFor, webHookUrl } from '../lib/mono-env.mjs';
import { isBreakerOpen, recordMonoFailure, recordMonoSuccess } from '../lib/breaker.mjs';
import { json, okJson, badRequest, notFound, conflict, tooMany, badGateway, originAllowed, readJsonBody } from '../lib/http.mjs';
import { ORDER_ID_RE, LOCK_TTL_MS } from '../lib/payment-constants.mjs';
import { MonoApiError } from '../lib/mono-client.mjs';

const { getDb } = firebaseAdminPkg;
const VALIDITY_SEC = 3600; // 1 година для клієнтського інвойсу (24 год — лише для адмінського посилання)

export default async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'Метод не підтримується.' });

    const siteUrl = process.env.SITE_URL;
    if (siteUrl && !originAllowed(req, siteUrl)) return json(403, { error: 'Заборонено.' });

    const { value: body, error: bodyError } = await readJsonBody(req);
    if (bodyError) return badRequest();
    const { orderID } = body;
    if (typeof orderID !== 'string' || !ORDER_ID_RE.test(orderID)) return badRequest();

    const db = getDb();
    const { order, error: authError } = await requireOrderToken({ db, orderID, authorizationHeader: req.headers.get('authorization') });
    if (authError) return notFound();

    // Живий інвойс беремо для перевірки reuse/invalidate ще до транзакції-замка — читання
    // документа payments не потребує блокування, воно лише впливає на рішення нижче.
    let payment = null;
    if (order.invoiceId) {
        const snap = await db.collection('payments').doc(order.invoiceId).get();
        if (snap.exists) payment = { ...snap.data(), invoiceId: snap.id };
    }

    const decision = evaluateCreatePayment({ order, payment, now: new Date() });

    if (decision.action === 'already_paid') return okJson({ status: order.paymentStatus });
    if (decision.action === 'reuse') return okJson({ pageUrl: decision.pageUrl, reused: true });
    if (decision.action === 'reject') {
        const map = {
            not_found: () => notFound(),
            locked: () => conflict('Триває інший запит на оплату цього замовлення.'),
            too_many_attempts: () => tooMany('Забагато спроб оплати. Зверніться до підтримки.'),
            too_soon: () => conflict('Зачекайте кілька секунд перед повторною спробою.'),
        };
        return (map[decision.code] || (() => conflict('Оплата для цього замовлення зараз недоступна.')))();
    }

    if (await isBreakerOpen(db)) {
        return badGateway('Оплата тимчасово недоступна. Спробуйте пізніше або оберіть інший спосіб оплати.', 'mono_unavailable');
    }

    // --- Крок A: замок (окрема легка транзакція, до звернення до Mono) ---
    const orderRef = db.collection('orders').doc(orderID);
    const lockUntil = new Date(Date.now() + LOCK_TTL_MS);
    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(orderRef);
            const fresh = { ...snap.data(), orderID: snap.id };
            const recheck = evaluateCreatePayment({ order: fresh, payment, now: new Date() });
            if (recheck.action !== 'create') {
                const err = new Error('precondition_changed');
                err.recheck = recheck;
                throw err;
            }
            tx.set(orderRef, { paymentLock: { until: lockUntil } }, { merge: true });
        });
    } catch (e) {
        if (e?.recheck?.action === 'already_paid') return okJson({ status: 'paid' });
        if (e?.recheck?.action === 'reuse') return okJson({ pageUrl: e.recheck.pageUrl, reused: true });
        return conflict('Оплата для цього замовлення зараз недоступна.');
    }

    // --- Крок B: старий інвойс, якщо є ---
    const mono = getMonoClient();
    if (decision.invalidateInvoiceId) {
        try {
            const status = await mono.getInvoiceStatus(decision.invalidateInvoiceId);
            if (status?.status === 'success') {
                // Гроші вже пройшли по старому інвойсу — новий створювати не можна.
                // Стан замовлення виправить вебхук або планова звірка.
                await orderRef.set({ paymentLock: null }, { merge: true });
                return okJson({ status: 'paid' });
            }
            await mono.removeInvoice(decision.invalidateInvoiceId).catch(() => {});
        } catch (e) {
            if (!(e instanceof MonoApiError) || e.outcomeUnknown) {
                // Невідомо, чи інвойс досі живий. Безпечніше зупинитись і дати клієнту повторити,
                // ніж ризикнути створити другий живий інвойс на ту саму суму.
                await orderRef.set({ paymentLock: null }, { merge: true });
                await recordMonoFailure(db);
                return badGateway('Оплата тимчасово недоступна. Спробуйте ще раз.', 'mono_unavailable');
            }
            // not_found — інвойс уже недійсний, продовжуємо створення нового.
        }
    }

    // --- Крок C: створення інвойсу ---
    let invoice;
    try {
        invoice = await mono.createInvoice({
            amountKop: order.onlineAmountKop,
            reference: orderID,
            destination: order.paymentMethod === 'cod'
                ? `Передплата за замовлення ${orderID}`
                : `Замовлення ${orderID}`,
            redirectUrl: redirectUrlFor(orderID),
            webHookUrl: webHookUrl(),
            validitySec: VALIDITY_SEC,
        });
        await recordMonoSuccess(db);
    } catch (e) {
        await orderRef.set({ paymentStatus: 'payment_error', paymentLock: null }, { merge: true });
        if (e instanceof MonoApiError) {
            if (e.kind === 'auth') console.error('create-payment: MONOBANK_MERCHANT_TOKEN недійсний (403 від Mono)');
            if (e.outcomeUnknown) await recordMonoFailure(db);
        }
        return badGateway('Не вдалося створити оплату. Спробуйте ще раз.', 'mono_unavailable');
    }

    // --- Крок D: фіксація (payments -> orders; лише після успішного запису повертаємо pageUrl) ---
    const purpose = order.paymentMethod === 'cod' ? 'prepayment' : 'full';
    try {
        await db.collection('payments').doc(invoice.invoiceId).create({
            invoiceId: invoice.invoiceId,
            orderID,
            provider: 'monobank',
            purpose,
            attempt: (order.attempts ?? 0) + 1,
            createdBy: 'client',
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
        // "Осиротілий" інвойс: Mono його створив, а зафіксувати в нас не вдалося.
        // pageUrl клієнту не віддаємо; інвойс сам згасне за validity, або спробуємо прибрати best-effort.
        console.error('create-payment: не вдалося зафіксувати платіж після успішного invoice/create', invoice.invoiceId, e);
        await orderRef.set({ paymentLock: null }, { merge: true }).catch(() => {});
        await mono.removeInvoice(invoice.invoiceId).catch(() => {});
        return badGateway('Не вдалося створити оплату. Спробуйте ще раз.', 'mono_unavailable');
    }

    return okJson({ pageUrl: invoice.pageUrl, reused: false });
};

export const config = {
    rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ['ip'] },
};
