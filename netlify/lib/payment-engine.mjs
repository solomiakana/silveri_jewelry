// Чиста логіка платіжних станів: без Firestore, без мережі, без годинника (now передається ззовні).
// Обгортки-функції лише читають документи, викликають ці функції в транзакції й записують результат.

import {
    PAYMENT_STATUS as S, SETTLED_STATUSES, UNPAID_STATUSES, PURPOSE, MONO_STATUSES,
    CANCEL_ITEM_STATUSES, ATTENTION, CCY_UAH, INVOICE_ID_RE, EXT_REF_RE,
    ORDER_STATUS_AWAITING_PAYMENT, ORDER_STATUS_NEW, ORDER_STATUS_CANCELLED,
    MAX_INVOICE_ATTEMPTS, MIN_INVOICE_GAP_MS, REUSE_MARGIN_MS, PAYMENT_METHODS,
} from './payment-constants.mjs';
import { isCodAllowed, onlineAmountKop } from './money.mjs';

/* ---------- утиліти ---------- */

function parseTs(v) {
    if (v === null || v === undefined) return null;
    const t = v instanceof Date ? v.getTime() : (typeof v?.toMillis === 'function' ? v.toMillis() : Date.parse(v));
    return Number.isFinite(t) ? t : null;
}

function compact(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function purposeForMethod(method) {
    if (method === 'online') return PURPOSE.FULL;
    if (method === 'cod') return PURPOSE.PREPAYMENT;
    return null;
}

// Статус "оплачено" для цього платежу: повна оплата -> paid; передоплата -> prepaid
// (або paid, якщо менеджер уже підтвердив отримання залишку).
export function settledStatusFor(order, payment) {
    if (payment.purpose === PURPOSE.FULL) return S.PAID;
    return order.paidAt ? S.PAID : S.PREPAID;
}

/* ---------- cancelList ---------- */

// Нормалізація списку скасувань Mono. Формат елемента в документації описаний неповно,
// тому парсимо захисно: невідоме -> null/'unknown'.
export function normalizeCancelList(list, invoiceId = '') {
    if (!Array.isArray(list)) return [];
    return list.map((it, i) => {
        const status = CANCEL_ITEM_STATUSES.includes(it?.status) ? it.status : 'unknown';
        const amountKop = Number.isInteger(it?.amount) ? it.amount : null;
        const okRef = typeof it?.extRef === 'string' && EXT_REF_RE.test(it.extRef);
        const stamp = String(it?.createdDate ?? i).replace(/[^A-Za-z0-9]/g, '');
        return {
            key: okRef ? it.extRef : `mono_${invoiceId}_${stamp}`,
            extRef: okRef ? it.extRef : null,
            external: !okRef,
            status,
            amountKop,
            approvalCode: it?.approvalCode ?? null,
            rrn: it?.rrn ?? null,
            createdDate: it?.createdDate ?? null,
            modifiedDate: it?.modifiedDate ?? null,
        };
    });
}

function summarizeRefunds(items, paymentAmountKop, monoStatus) {
    let refundedKop = 0;
    let pendingKop = 0;
    for (const it of items) {
        const amount = it.amountKop ?? paymentAmountKop; // без суми = повне скасування
        if (it.status === 'success') refundedKop += amount;
        else if (it.status === 'processing') pendingKop += amount;
    }
    if (monoStatus === 'reversed') refundedKop = Math.max(refundedKop, paymentAmountKop);
    refundedKop = Math.min(refundedKop, paymentAmountKop);
    return { refundedKop, pendingKop };
}

/* ---------- застосування події Mono ---------- */

function validateEvent(e) {
    if (!e || typeof e !== 'object') return 'not_object';
    if (typeof e.invoiceId !== 'string' || !INVOICE_ID_RE.test(e.invoiceId)) return 'bad_invoice_id';
    if (!MONO_STATUSES.includes(e.status)) return 'bad_status';
    if (!Number.isInteger(e.amount) || e.amount <= 0) return 'bad_amount';
    if (e.finalAmount !== undefined && e.finalAmount !== null && !Number.isInteger(e.finalAmount)) return 'bad_final_amount';
    if (e.reference !== undefined && e.reference !== null && typeof e.reference !== 'string') return 'bad_reference';
    return null;
}

const NOOP = Object.freeze({ paymentPatch: null, orderPatch: null, attention: null, refundItems: [] });

/**
 * Обчислює, що треба записати, коли надійшов стан інвойсу (вебхук / опитування / cron).
 *
 * @param order   документ замовлення (з полем orderID)
 * @param payment документ payments/{invoiceId} або null
 * @param event   стан інвойсу від Mono (тіло вебхука або відповідь invoice/status)
 * @param now     Date
 * @returns { result, reason?, paymentPatch, orderPatch, attention, refundItems }
 *   result: applied | ignored_stale | ignored_duplicate | rejected_invalid |
 *           rejected_mismatch | unknown_invoice
 */
export function planInvoiceEvent({ order, payment, event, now = new Date() }) {
    const bad = validateEvent(event);
    if (bad) return { ...NOOP, result: 'rejected_invalid', reason: bad };
    if (!order) return { ...NOOP, result: 'rejected_invalid', reason: 'order_not_found' };
    if (!payment) return { ...NOOP, result: 'unknown_invoice' };

    // Звірка з тим, що ми самі зафіксували при створенні інвойсу.
    const referenceMismatch = event.reference != null && event.reference !== payment.orderID;
    const orderMismatch = order.orderID !== payment.orderID;
    const amountMismatch = event.amount !== payment.amountKop;
    const ccyMismatch = event.ccy !== CCY_UAH;
    if (referenceMismatch || orderMismatch || amountMismatch || ccyMismatch) {
        return {
            ...NOOP,
            result: 'rejected_mismatch',
            reason: [
                referenceMismatch && 'reference', orderMismatch && 'order',
                amountMismatch && 'amount', ccyMismatch && 'ccy',
            ].filter(Boolean).join(','),
            attention: { reason: ATTENTION.AMOUNT_MISMATCH, details: { invoiceId: event.invoiceId } },
        };
    }

    const items = normalizeCancelList(event.cancelList, event.invoiceId);
    const evTs = parseTs(event.modifiedDate);
    const curTs = parseTs(payment.modifiedDate);

    // Застарілі події не повинні відкочувати стан.
    if (evTs !== null && curTs !== null && evTs < curTs) {
        return { ...NOOP, result: 'ignored_stale' };
    }
    // Дублікат: той самий статус і той самий список скасувань без нової дати.
    const sameCancels = JSON.stringify(items) === JSON.stringify(normalizeCancelList(payment.cancelList, event.invoiceId));
    if (payment.status === event.status && sameCancels && (evTs === null || curTs === null || evTs === curTs)) {
        return { ...NOOP, result: 'ignored_duplicate', paymentPatch: { lastSyncAt: now } };
    }

    const paymentPatch = compact({
        status: event.status,
        modifiedDate: event.modifiedDate ?? payment.modifiedDate ?? null,
        finalAmount: event.finalAmount ?? null,
        errCode: event.errCode ?? null,
        failureReason: event.failureReason ?? null,
        paymentInfo: event.paymentInfo ?? undefined,
        cancelList: Array.isArray(event.cancelList) ? event.cancelList : [],
        lastSyncAt: now,
    });

    const isCurrent = order.invoiceId === payment.invoiceId;
    const orderIsSettledHere = isCurrent && SETTLED_STATUSES.has(order.paymentStatus);
    const orderPatch = {};
    let attention = null;
    let refundItems = [];

    // --- Повернення (cancelList / reversed) для платежу, який закрив це замовлення ---
    if (orderIsSettledHere) {
        const { refundedKop, pendingKop } = summarizeRefunds(items, payment.amountKop, event.status);
        const keepRefunding = items.length === 0 && order.paymentStatus === S.REFUNDING && (order.refundPendingKop ?? 0) > 0;
        if (!keepRefunding && (items.length > 0 || event.status === 'reversed')) {
            let next;
            if (refundedKop >= payment.amountKop) next = S.REFUNDED;
            else if (pendingKop > 0) next = S.REFUNDING;
            else if (refundedKop > 0) next = S.PARTIALLY_REFUNDED;
            else next = settledStatusFor(order, payment);
            Object.assign(orderPatch, { refundedKop, refundPendingKop: pendingKop, paymentStatus: next });
            refundItems = items;
        }
        return finish();
    }

    switch (event.status) {
        case 'created':
        case 'processing':
            if (isCurrent && [S.PENDING, S.PAYMENT_ERROR, S.FAILED, S.EXPIRED].includes(order.paymentStatus)) {
                orderPatch.paymentStatus = S.PROCESSING;
            }
            break;

        case 'failure':
            if (isCurrent && order.paymentStatus === S.PROCESSING) orderPatch.paymentStatus = S.FAILED;
            break;

        case 'expired':
            if (isCurrent && order.paymentStatus === S.PROCESSING) orderPatch.paymentStatus = S.EXPIRED;
            break;

        case 'success': {
            if (SETTLED_STATUSES.has(order.paymentStatus)) {
                // Замовлення вже закрите іншим платежем -> це дублікат оплати.
                attention = { reason: ATTENTION.DUPLICATE_PAYMENT, details: { invoiceId: payment.invoiceId } };
                refundItems = items;
                break;
            }
            const target = payment.purpose === PURPOSE.FULL ? S.PAID : S.PREPAID;
            const paidKop = payment.amountKop;
            Object.assign(orderPatch, compact({
                paymentStatus: target,
                invoiceId: payment.invoiceId,
                paidKop,
                dueOnDeliveryKop: Number.isInteger(order.totalKop) ? Math.max(0, order.totalKop - paidKop) : undefined,
                paidAt: target === S.PAID ? now : undefined,
                prepaidAt: target === S.PREPAID ? now : undefined,
            }));
            if (order.orderStatus === ORDER_STATUS_AWAITING_PAYMENT) {
                orderPatch.orderStatus = ORDER_STATUS_NEW;
            } else if (order.orderStatus === ORDER_STATUS_CANCELLED) {
                attention = { reason: ATTENTION.PAID_AFTER_CANCEL, details: { invoiceId: payment.invoiceId } };
            }
            if (!attention && purposeForMethod(order.paymentMethod) !== payment.purpose) {
                attention = { reason: ATTENTION.METHOD_MISMATCH, details: { method: order.paymentMethod, purpose: payment.purpose } };
            }
            refundItems = items;
            break;
        }

        case 'reversed':
        case 'hold':
        default:
            attention = { reason: ATTENTION.UNEXPECTED_STATUS, details: { status: event.status, invoiceId: payment.invoiceId } };
            break;
    }
    return finish();

    function finish() {
        return {
            result: 'applied',
            paymentPatch,
            orderPatch: Object.keys(orderPatch).length ? orderPatch : null,
            attention,
            refundItems,
        };
    }
}

/* ---------- guards для інших функцій ---------- */

// create-payment / create-admin-payment-link: що робити з запитом на інвойс.
// Повертає { action, code?, ... }:
//   already_paid | reuse (pageUrl) | create (invalidate: invoiceId|null) | reject (code)
export function evaluateCreatePayment({ order, payment = null, now = new Date(), maxAttempts = MAX_INVOICE_ATTEMPTS, minGapMs = MIN_INVOICE_GAP_MS, reuseMarginMs = REUSE_MARGIN_MS }) {
    if (!order) return { action: 'reject', code: 'not_found' };
    if (SETTLED_STATUSES.has(order.paymentStatus)) return { action: 'already_paid' };
    if (order.paymentMethod !== 'online' && order.paymentMethod !== 'cod') return { action: 'reject', code: 'method_not_payable' };
    if (order.orderStatus !== ORDER_STATUS_AWAITING_PAYMENT) return { action: 'reject', code: 'order_not_payable' };
    if (!UNPAID_STATUSES.has(order.paymentStatus)) return { action: 'reject', code: 'status_not_payable' };

    const nowMs = now.getTime();
    const lockUntil = parseTs(order.paymentLock?.until);
    if (lockUntil !== null && lockUntil > nowMs) return { action: 'reject', code: 'locked' };

    // Ідемпотентність: живий інвойс віддаємо повторно.
    if (order.paymentStatus === S.PROCESSING && payment && payment.invoiceId === order.invoiceId
        && ['created', 'processing'].includes(payment.status) && !payment.invalidatedAt) {
        const validUntil = parseTs(payment.validUntil);
        if (validUntil !== null && validUntil - reuseMarginMs > nowMs && typeof payment.pageUrl === 'string') {
            return { action: 'reuse', pageUrl: payment.pageUrl, invoiceId: payment.invoiceId };
        }
    }

    if ((order.attempts ?? 0) >= maxAttempts) return { action: 'reject', code: 'too_many_attempts' };
    const last = parseTs(order.lastInvoiceCreatedAt);
    if (last !== null && nowMs - last < minGapMs) return { action: 'reject', code: 'too_soon' };

    return { action: 'create', invalidateInvoiceId: order.invoiceId ?? null };
}

// switch-payment-method: чи можна змінити спосіб і які поля виставити.
export function evaluateSwitchMethod({ order, targetMethod, prepaymentKop }) {
    if (!order) return { ok: false, code: 'not_found' };
    if (!PAYMENT_METHODS.includes(targetMethod)) return { ok: false, code: 'bad_method' };
    if (SETTLED_STATUSES.has(order.paymentStatus)) return { ok: false, code: 'already_paid' };
    if (!UNPAID_STATUSES.has(order.paymentStatus)) return { ok: false, code: 'status_not_switchable' };
    if (order.orderStatus === ORDER_STATUS_CANCELLED) return { ok: false, code: 'order_cancelled' };
    if (targetMethod === order.paymentMethod) return { ok: false, code: 'same_method' };
    if (targetMethod === 'cod' && !isCodAllowed(order.totalKop, prepaymentKop)) return { ok: false, code: 'cod_not_allowed' };

    return {
        ok: true,
        invalidateInvoiceId: order.invoiceId ?? null,
        patch: {
            paymentMethod: targetMethod,
            paymentProvider: targetMethod === 'fop' ? null : 'monobank',
            paymentStatus: S.PENDING,
            orderStatus: targetMethod === 'fop' ? ORDER_STATUS_NEW : ORDER_STATUS_AWAITING_PAYMENT,
            onlineAmountKop: onlineAmountKop({ method: targetMethod, totalKop: order.totalKop, prepaymentKop }),
            invoiceId: null,
        },
    };
}

// mark-paid: тільки fop (pending -> paid) і cod (prepaid -> paid).
export function evaluateMarkPaid({ order }) {
    if (!order) return { ok: false, code: 'not_found' };
    if (order.paymentMethod === 'fop' && order.paymentStatus === S.PENDING) return { ok: true, to: S.PAID };
    if (order.paymentMethod === 'cod' && order.paymentStatus === S.PREPAID) return { ok: true, to: S.PAID };
    return { ok: false, code: 'transition_not_allowed' };
}

// cancel-payment: повне повернення конкретного платежу. Суму визначає сервер.
export function evaluateRefund({ order, payment }) {
    if (!order || !payment) return { ok: false, code: 'not_found' };
    if (payment.orderID !== order.orderID) return { ok: false, code: 'payment_mismatch' };
    if (payment.status !== 'success') return { ok: false, code: 'payment_not_successful' };
    if ((order.refundPendingKop ?? 0) > 0) return { ok: false, code: 'refund_in_progress' };

    const isOrderInvoice = order.invoiceId === payment.invoiceId;
    if (isOrderInvoice) {
        if (order.paymentStatus !== S.PAID && order.paymentStatus !== S.PREPAID) return { ok: false, code: 'status_not_refundable' };
        return { ok: true, scope: 'order', amountKop: payment.amountKop };
    }
    // Не основний платіж замовлення: повернення дубліката оплати.
    if (!SETTLED_STATUSES.has(order.paymentStatus)) return { ok: false, code: 'status_not_refundable' };
    return { ok: true, scope: 'duplicate', amountKop: payment.amountKop };
}
