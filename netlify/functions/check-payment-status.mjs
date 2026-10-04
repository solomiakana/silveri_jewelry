// GET /.netlify/functions/check-payment-status?orderID=...
// Статус для сторінки order-status.html. Читає лише нашу базу; якщо платіж давно не
// синхронізований, сама звіряється з Mono через invoice/status (архітектурний опис, 7.3,
// "на вимогу"). Відповідь навмисно мінімальна: без імені, телефону, адреси, email, деталей
// картки (лише orderID, статуси, суми й склад замовлення — потрібні, якщо клієнт повернувся
// в інший браузер після оплати в застосунку банку).
import firebaseAdminPkg from './_firebaseAdmin.js';
import { requireOrderToken } from '../lib/order-auth.mjs';
import { applyInvoiceState } from '../lib/apply-invoice-state.mjs';
import { getMonoClient } from '../lib/mono-env.mjs';
import { json, okJson, notFound, originAllowed } from '../lib/http.mjs';
import { MonoApiError } from '../lib/mono-client.mjs';

const { getDb } = firebaseAdminPkg;
const STALE_AFTER_MS = 15_000;

function tsToMs(v) {
    if (v == null) return null;
    if (typeof v.toMillis === 'function') return v.toMillis();
    return null;
}

export default async (req) => {
    if (req.method !== 'GET') return json(405, { error: 'Метод не підтримується.' });

    const siteUrl = process.env.SITE_URL;
    if (siteUrl && !originAllowed(req, siteUrl)) return json(403, { error: 'Заборонено.' });

    const url = new URL(req.url);
    const orderID = url.searchParams.get('orderID');
    const db = getDb();
    const { order, error } = await requireOrderToken({ db, orderID, authorizationHeader: req.headers.get('authorization') });
    if (error) return notFound();

    // Звірка на вимогу: платіж живий, але давно не синхронізований — можливо, вебхук загубився.
    if (order.invoiceId && ['processing', 'pending'].includes(order.paymentStatus)) {
        const paymentSnap = await db.collection('payments').doc(order.invoiceId).get();
        const payment = paymentSnap.exists ? paymentSnap.data() : null;
        const lastSync = tsToMs(payment?.lastSyncAt);
        const isLive = payment && ['created', 'processing'].includes(payment.status);
        if (isLive && (lastSync === null || Date.now() - lastSync > STALE_AFTER_MS)) {
            try {
                const status = await getMonoClient().getInvoiceStatus(order.invoiceId);
                await applyInvoiceState({ db, event: status, source: 'status_poll' });
                const fresh = await db.collection('orders').doc(order.orderID).get();
                Object.assign(order, fresh.data());
            } catch (e) {
                // Збій звірки не повинен ламати відповідь клієнту — просто віддаємо те, що маємо.
                if (!(e instanceof MonoApiError)) console.error('check-payment-status: звірка не вдалася', e);
            }
        }
    }

    return okJson({
        orderID: order.orderID,
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus,
        paymentMethod: order.paymentMethod,
        totalKop: order.totalKop,
        onlineAmountKop: order.onlineAmountKop,
        dueOnDeliveryKop: order.dueOnDeliveryKop,
        items: (order.items ?? []).map((it) => ({ id: it.id, title: it.title, price: it.price, qty: it.qty })),
        packaging: order.packaging ? { title: order.packaging.title } : null,
    });
};

export const config = {
    rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ['ip'] },
};
