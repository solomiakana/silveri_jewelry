// Спільне застосування стану інвойсу Mono. Використовується вебхуком,
// check-payment-status (звірка на вимогу) і плановою функцією reconcile-payments —
// саме це гарантує, що всі три джерела поводяться однаково (архітектурний опис, 7.3).
import { planInvoiceEvent } from './payment-engine.mjs';
import metaCapiPkg from '../functions/_metaCapi.js';

const { sendPurchase } = metaCapiPkg;
const PAYMENT_EVENTS_MAX_BODY = 8000; // символів rawBody, які лишаємо в логу події

function tsToIso(v) {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof v.toDate === 'function') return v.toDate().toISOString();
    return null;
}

// Приводить документ payments/{invoiceId} із Firestore до плоского об'єкта з рядковими датами,
// які очікує planInvoiceEvent (порівняння виконується через Date.parse).
function readPayment(snap) {
    if (!snap.exists) return null;
    const d = snap.data();
    return { ...d, invoiceId: snap.id, modifiedDate: tsToIso(d.modifiedDate), validUntil: tsToIso(d.validUntil) };
}
function readOrder(snap) {
    if (!snap.exists) return null;
    return { ...snap.data(), orderID: snap.id };
}

/**
 * Застосовує одну подію стану інвойсу (тіло вебхука або відповідь invoice/status) у транзакції.
 *
 * @param db      Firestore (Admin SDK)
 * @param event   { invoiceId, status, amount, ccy, finalAmount?, reference?, modifiedDate?, cancelList?, errCode?, failureReason?, paymentInfo? }
 * @param source  'webhook' | 'status_poll' | 'cron' — лише для логування
 * @param eventId Ідентифікатор запису payment_events (SHA-256 сирого тіла для вебхука).
 *                Якщо не передано (status_poll/cron), дедуплікація payment_events пропускається:
 *                там немає "сирого тіла" для хешування, а джерело й так ідемпотентне саме по собі.
 */
export async function applyInvoiceState({ db, event, source, eventId = null, rawBodyForLog = null, ip = null }) {
    const now = new Date();
    let outcome;
    // Заповнюється всередині транзакції, лише якщо ця подія ВПЕРШЕ переводить
    // замовлення (online/cod) у paid/prepaid — саме цей момент є конверсією для
    // онлайн-оплати (на відміну від fop, де CAPI Purchase шле create-order.mjs одразу
    // при створенні замовлення). Викликаємо sendPurchase після коміту транзакції:
    // це мережевий запит, йому не місце всередині tx.runTransaction.
    let capiTrigger = null;

    await db.runTransaction(async (tx) => {
        // Дедуплікація за сирим тілом — лише коли є eventId (вебхук).
        let eventRef = null;
        if (eventId) {
            eventRef = db.collection('payment_events').doc(eventId);
            const existing = await tx.get(eventRef);
            if (existing.exists) {
                outcome = { result: 'ignored_duplicate', dedup: true };
                return;
            }
        }

        const paymentRef = db.collection('payments').doc(event.invoiceId);
        const paymentSnap = await tx.get(paymentRef);
        const payment = readPayment(paymentSnap);

        let order = null;
        let orderRef = null;
        if (payment) {
            orderRef = db.collection('orders').doc(payment.orderID);
            order = readOrder(await tx.get(orderRef));
        } else if (event.reference) {
            // Осиротілий інвойс: платежу в нас ще немає, але reference вказує на наше замовлення.
            orderRef = db.collection('orders').doc(event.reference);
            order = readOrder(await tx.get(orderRef));
        }

        const plan = planInvoiceEvent({ order, payment, event, now });
        outcome = { result: plan.result, reason: plan.reason };

        if (eventRef) {
            tx.set(eventRef, {
                receivedAt: now,
                source,
                invoiceId: event.invoiceId ?? null,
                reference: event.reference ?? null,
                status: event.status ?? null,
                modifiedDate: event.modifiedDate ?? null,
                signatureValid: true, // подія сюди потрапляє лише після успішної перевірки підпису
                rawBody: typeof rawBodyForLog === 'string' ? rawBodyForLog.slice(0, PAYMENT_EVENTS_MAX_BODY) : null,
                ip,
                result: plan.result,
                reason: plan.reason ?? null,
            });
        }

        if (plan.result === 'unknown_invoice') {
            // payments-документа немає: створювати його тут не можна (бракує повних даних
            // про створення інвойсу — amountKop, purpose, createdBy). create-payment.mjs
            // пише payments/{invoiceId} до того, як віддає pageUrl клієнту (крок D), тож
            // цей запис зазвичай наздоганяє вебхук протягом секунд. Якщо ні — це справжній
            // осиротілий інвойс, і звірка (reconcile-payments) позначить order needsAttention.
            return;
        }
        if (plan.result !== 'applied') return;

        if (plan.paymentPatch) tx.set(paymentRef, plan.paymentPatch, { merge: true });
        if (order && orderRef) {
            const patch = { ...plan.orderPatch };
            if (plan.attention) {
                patch.needsAttention = { ...plan.attention, at: now };
            }
            if (Object.keys(patch).length) tx.set(orderRef, patch, { merge: true });

            // Онлайн/cod: замовлення щойно вперше стало paid/prepaid у цій події —
            // саме зараз (а не при створенні замовлення) стався "продаж" для CAPI.
            if (['paid', 'prepaid'].includes(plan.orderPatch?.paymentStatus)) {
                capiTrigger = {
                    orderID: order.orderID,
                    items: order.items || [],
                    total: Number.isInteger(order.totalKop) ? order.totalKop / 100 : 0,
                    customer: { name: order.customerName, phone: order.customerPhone },
                    tracking: order.tracking || {},
                };
            }

            for (const item of plan.refundItems) {
                if (!item.extRef) continue; // зовнішні повернення без extRef не мають окремого запиту на повернення
                const refundRef = db.collection('refunds').doc(item.extRef);
                const refundSnap = await tx.get(refundRef);
                const statusMap = { success: 'success', processing: 'processing', failure: 'failure' };
                const patchRefund = {
                    orderID: order.orderID,
                    invoiceId: event.invoiceId,
                    amountKop: item.amountKop ?? payment.amountKop,
                    status: statusMap[item.status] ?? 'unknown',
                    approvalCode: item.approvalCode ?? null,
                    rrn: item.rrn ?? null,
                    updatedAt: now,
                };
                if (!refundSnap.exists) {
                    patchRefund.source = item.external ? 'external' : 'admin';
                    patchRefund.requestedAt = now;
                }
                tx.set(refundRef, patchRefund, { merge: true });
            }
        }
    });

    // Поза транзакцією, best-effort: збій CAPI не повинен ламати обробку вебхука/звірки.
    if (capiTrigger) {
        try {
            const capi = await sendPurchase({
                ...capiTrigger,
                ip: capiTrigger.tracking.ip || ip, // IP замовника з create-order; IP вебхука — лише запасний варіант
                userAgent: capiTrigger.tracking.clientUserAgent,
            });
            await db.collection('orders').doc(capiTrigger.orderID).set({
                tracking: { capi: { ...capi, sentAt: new Date() } },
            }, { merge: true });
        } catch (e) {
            console.error('applyInvoiceState: не вдалося надіслати CAPI Purchase:', e?.message || e);
        }
    }

    return outcome;
}
