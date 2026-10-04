// Спільні константи платіжної підсистеми (monobank acquiring).
// Файл лежить поза netlify/functions, щоб Netlify не публікував його як окрему функцію.

export const PAYMENT_METHODS = Object.freeze(['online', 'cod', 'fop']);

export const PAYMENT_STATUS = Object.freeze({
    PENDING: 'pending',
    PROCESSING: 'processing',
    PAID: 'paid',
    PREPAID: 'prepaid',
    FAILED: 'failed',
    EXPIRED: 'expired',
    PAYMENT_ERROR: 'payment_error',
    REFUNDING: 'refunding',
    PARTIALLY_REFUNDED: 'partially_refunded', // лише для зовнішніх (з кабінету Mono) часткових повернень
    REFUNDED: 'refunded',
});

// Статуси, у яких гроші вже отримані (повністю чи як передоплата) або повертаються.
export const SETTLED_STATUSES = Object.freeze(new Set([
    PAYMENT_STATUS.PAID,
    PAYMENT_STATUS.PREPAID,
    PAYMENT_STATUS.REFUNDING,
    PAYMENT_STATUS.PARTIALLY_REFUNDED,
    PAYMENT_STATUS.REFUNDED,
]));

// Статуси, з яких ще можна (пере)створювати інвойс або змінювати спосіб оплати.
export const UNPAID_STATUSES = Object.freeze(new Set([
    PAYMENT_STATUS.PENDING,
    PAYMENT_STATUS.PROCESSING,
    PAYMENT_STATUS.FAILED,
    PAYMENT_STATUS.EXPIRED,
    PAYMENT_STATUS.PAYMENT_ERROR,
]));

export const ORDER_STATUS_AWAITING_PAYMENT = 'awaiting_payment';
export const ORDER_STATUS_NEW = 'new';
export const ORDER_STATUS_CANCELLED = 'cancelled';

export const PURPOSE = Object.freeze({ FULL: 'full', PREPAYMENT: 'prepayment' });

// Статуси інвойсу за документацією Mono.
export const MONO_STATUSES = Object.freeze([
    'created', 'processing', 'hold', 'success', 'failure', 'reversed', 'expired',
]);

export const CANCEL_ITEM_STATUSES = Object.freeze(['processing', 'success', 'failure']);

// Причини, з яких замовлення отримує прапор needsAttention.
export const ATTENTION = Object.freeze({
    DUPLICATE_PAYMENT: 'duplicate_payment',
    PAID_AFTER_CANCEL: 'paid_after_cancel',
    AMOUNT_MISMATCH: 'amount_mismatch',
    UNKNOWN_INVOICE: 'unknown_invoice',
    REFUND_UNKNOWN: 'refund_unknown',
    METHOD_MISMATCH: 'method_mismatch',
    UNEXPECTED_STATUS: 'unexpected_status',
});

export const CCY_UAH = 980;

// Формат ідентифікатора замовлення: SIL- + 10 символів Crockford base32.
export const ORDER_ID_RE = /^SIL-[0-9A-HJKMNP-TV-Z]{10}$/;
// invoiceId у Mono виглядає як "p2_9ZgpZVsl3".
export const INVOICE_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
// Наш референс скасування (UUID або подібне).
export const EXT_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Ліміти створення інвойсів.
export const MAX_INVOICE_ATTEMPTS = 5;
export const MIN_INVOICE_GAP_MS = 5_000;
export const LOCK_TTL_MS = 30_000;
export const REUSE_MARGIN_MS = 120_000;
