// POST /.netlify/functions/switch-payment-method  { orderID, method }
// Зміна способу оплати ще не оплаченого замовлення. Алгоритм — архітектурний опис, 6.4/7.5.
import firebaseAdminPkg from './_firebaseAdmin.js';
import { evaluateSwitchMethod } from '../lib/payment-engine.mjs';
import { requireOrderToken } from '../lib/order-auth.mjs';
import { getMonoClient } from '../lib/mono-env.mjs';
import { prepaymentKopFromEnv } from '../lib/money.mjs';
import { MonoApiError } from '../lib/mono-client.mjs';
import { json, okJson, badRequest, notFound, conflict, badGateway, originAllowed, readJsonBody } from '../lib/http.mjs';
import { ORDER_ID_RE, PAYMENT_METHODS } from '../lib/payment-constants.mjs';

const { getDb } = firebaseAdminPkg;

const REJECT_MESSAGES = {
    not_found: 'Не знайдено.',
    bad_method: 'Невідомий спосіб оплати.',
    already_paid: 'Замовлення вже оплачене.',
    status_not_switchable: 'Змінити спосіб оплати зараз не можна.',
    order_cancelled: 'Замовлення скасоване.',
    same_method: 'Цей спосіб оплати вже обрано.',
    cod_not_allowed: 'Накладений платіж недоступний для цієї суми замовлення.',
};

export default async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'Метод не підтримується.' });

    const siteUrl = process.env.SITE_URL;
    if (siteUrl && !originAllowed(req, siteUrl)) return json(403, { error: 'Заборонено.' });

    const { value: body, error: bodyError } = await readJsonBody(req);
    if (bodyError) return badRequest();
    const { orderID, method } = body;
    if (typeof orderID !== 'string' || !ORDER_ID_RE.test(orderID)) return badRequest();
    if (typeof method !== 'string' || !PAYMENT_METHODS.includes(method)) return badRequest();

    const db = getDb();
    const { order, error: authError } = await requireOrderToken({ db, orderID, authorizationHeader: req.headers.get('authorization') });
    if (authError) return notFound();

    const orderRef = db.collection('orders').doc(orderID);
    const mono = getMonoClient();

    // Перед перемиканням перевіряємо статус активного інвойсу в Mono: якщо там уже success,
    // перемикання заборонене — інакше можна було б "втратити" вже оплачений інвойс.
    if (order.invoiceId) {
        try {
            const status = await mono.getInvoiceStatus(order.invoiceId);
            if (status?.status === 'success') return conflict('Замовлення вже оплачене.');
        } catch (e) {
            if (!(e instanceof MonoApiError) || e.outcomeUnknown) {
                return badGateway('Не вдалося перевірити стан оплати. Спробуйте ще раз.', 'mono_unavailable');
            }
            // not_found — інвойс недійсний, продовжуємо.
        }
    }

    const prepaymentKop = prepaymentKopFromEnv();
    let outcome;
    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(orderRef);
            const fresh = { ...snap.data(), orderID: snap.id };
            const decision = evaluateSwitchMethod({ order: fresh, targetMethod: method, prepaymentKop });
            outcome = decision;
            if (!decision.ok) return;
            tx.set(orderRef, decision.patch, { merge: true });
        });
    } catch (e) {
        console.error('switch-payment-method: помилка транзакції', e);
        return conflict('Не вдалося змінити спосіб оплати. Спробуйте ще раз.');
    }

    if (!outcome.ok) return conflict(REJECT_MESSAGES[outcome.code] || 'Не вдалося змінити спосіб оплати.');

    if (outcome.invalidateInvoiceId) {
        await mono.removeInvoice(outcome.invalidateInvoiceId).catch(() => {});
    }

    return okJson({ paymentMethod: method, orderStatus: outcome.patch.orderStatus });
};

export const config = {
    rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ['ip'] },
};
