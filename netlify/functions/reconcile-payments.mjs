// Netlify Scheduled Function: кожні ~10 хв.
// 1) звіряє завислі payments (created/processing довше 5 хв) через invoice/status —
//    саме так ловимо статус "expired", який вебхуком не приходить;
// 2) скасовує замовлення awaiting_payment без живого інвойсу старші за 24 год.
// Архітектурний опис, 7.3. Запускається лише на production-деплої (обмеження Netlify);
// на preview викликається вручну.
import firebaseAdminPkg from './_firebaseAdmin.js';
import { applyInvoiceState } from '../lib/apply-invoice-state.mjs';
import { getMonoClient } from '../lib/mono-env.mjs';
import { MonoApiError } from '../lib/mono-client.mjs';
import { ORDER_STATUS_AWAITING_PAYMENT, ORDER_STATUS_CANCELLED, ATTENTION } from '../lib/payment-constants.mjs';

const { getDb } = firebaseAdminPkg;
const STALE_PAYMENT_AFTER_MS = 5 * 60 * 1000;
const BATCH_SIZE = 20;
const ABANDONED_ORDER_AFTER_MS = 24 * 3600 * 1000;

export default async (req) => {
    const db = getDb();
    const mono = getMonoClient();
    const now = Date.now();

    // --- 1) завислі платежі ---
    const cutoff = new Date(now - STALE_PAYMENT_AFTER_MS);
    const stale = await db.collection('payments')
        .where('status', 'in', ['created', 'processing'])
        .where('createdAt', '<=', cutoff)
        .limit(BATCH_SIZE)
        .get();

    let checked = 0;
    for (const doc of stale.docs) {
        const payment = doc.data();
        try {
            const status = await mono.getInvoiceStatus(doc.id);
            await applyInvoiceState({ db, event: status, source: 'cron' });
            checked++;
        } catch (e) {
            if (e instanceof MonoApiError && e.kind === 'not_found') {
                // Інвойс невідомий Mono (наприклад, дуже старий) — позначаємо для ручного розбору,
                // саму подію застосувати нічим.
                await db.collection('orders').doc(payment.orderID).set({
                    needsAttention: { reason: ATTENTION.UNKNOWN_INVOICE, details: { invoiceId: doc.id }, at: new Date() },
                }, { merge: true }).catch(() => {});
            } else {
                console.error('reconcile-payments: не вдалося перевірити інвойс', doc.id, e);
            }
        }
    }

    // --- 2) покинуті замовлення без живого інвойсу ---
    const abandonedCutoff = new Date(now - ABANDONED_ORDER_AFTER_MS);
    const abandoned = await db.collection('orders')
        .where('orderStatus', '==', ORDER_STATUS_AWAITING_PAYMENT)
        .where('createdAt', '<=', abandonedCutoff)
        .limit(BATCH_SIZE)
        .get();

    let cancelled = 0;
    for (const doc of abandoned.docs) {
        const order = doc.data();
        if (['paid', 'prepaid', 'processing'].includes(order.paymentStatus)) continue; // хай доганяє звірка/вебхук
        await doc.ref.set({ orderStatus: ORDER_STATUS_CANCELLED, paymentStatus: 'expired' }, { merge: true });
        cancelled++;
    }

    console.log(`reconcile-payments: перевірено ${checked}/${stale.size} платежів, скасовано ${cancelled}/${abandoned.size} замовлень`);
    return new Response(null, { status: 200 });
};

export const config = {
    schedule: '*/10 * * * *',
};
