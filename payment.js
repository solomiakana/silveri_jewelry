// Клієнтський шар онлайн-оплати monobank. Використовується з checkout.html (cart.js)
// і з order-status.html (order-status.js). Ніколи не рахує суми сам — лише передає
// orderID/statusToken серверним функціям і показує те, що вони повернули
// (архітектурний опис, розділи 6 і 10).

const UNFINISHED_ORDER_KEY = 'silveri_pending_order';
const PURCHASE_TRACKED_PREFIX = 'silveri_purchase_tracked_';

// --- Виклики платіжних функцій ---

async function callPaymentApi(path, { method = 'GET', orderID, token, body } = {}) {
    const url = method === 'GET' ? `/.netlify/functions/${path}?orderID=${encodeURIComponent(orderID)}` : `/.netlify/functions/${path}`;
    let response;
    try {
        response = await fetch(url, {
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch (e) {
        return { ok: false, networkError: true, error: 'Немає з’єднання з сервером.' };
    }
    let data = null;
    try { data = await response.json(); } catch { /* деякі відповіді (напр. 409 без тіла) можуть бути порожні */ }
    // httpStatus — код відповіді, окремо від бізнес-поля "status" (paymentStatus), яке
    // деякі ендпоінти повертають у тілі (напр. create-payment при вже оплаченому замовленні).
    return { ok: response.ok, httpStatus: response.status, ...data };
}

/** Створює (або повторно віддає) інвойс оплати для замовлення. */
export function createPayment(orderID, token) {
    return callPaymentApi('create-payment', { method: 'POST', orderID, token, body: { orderID } });
}

/** Змінює спосіб оплати ще не оплаченого замовлення. */
export function switchPaymentMethod(orderID, token, method) {
    return callPaymentApi('switch-payment-method', { method: 'POST', orderID, token, body: { orderID, method } });
}

/** Поточний статус оплати/замовлення (для order-status.html). */
export function checkPaymentStatus(orderID, token) {
    return callPaymentApi('check-payment-status', { method: 'GET', orderID, token });
}

// --- "Незавершене замовлення" (sessionStorage) ---
// Зберігається перед редіректом на сторінку оплати monobank, щоб якщо клієнт
// натисне "Назад" або закриє вкладку, чекаут міг запропонувати продовжити
// оплату замість створення дубліката замовлення (архітектурний опис, 10.4).

export function saveUnfinishedOrder(orderID, token, method) {
    try {
        sessionStorage.setItem(UNFINISHED_ORDER_KEY, JSON.stringify({ orderID, token, method, at: Date.now() }));
    } catch { /* sessionStorage може бути недоступний (приватний режим) — не критично */ }
}

export function loadUnfinishedOrder() {
    try {
        const raw = sessionStorage.getItem(UNFINISHED_ORDER_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function clearUnfinishedOrder() {
    try { sessionStorage.removeItem(UNFINISHED_ORDER_KEY); } catch { /* ignore */ }
}

// --- Оверлей "Переходимо на сторінку оплати" ---

export function showRedirectOverlay(text) {
    const overlay = document.getElementById('payment-redirect-overlay');
    const textEl = document.getElementById('payment-redirect-text');
    if (textEl && text) textEl.textContent = text;
    if (overlay) { overlay.hidden = false; overlay.setAttribute('aria-hidden', 'false'); }
}

export function hideRedirectOverlay() {
    const overlay = document.getElementById('payment-redirect-overlay');
    if (overlay) { overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true'); }
}

// iOS Safari може відновити сторінку з bfcache разом зі станом JS (кнопка й оверлей
// лишаються "замороженими" у стані "Переходимо…"), коли клієнт тисне "Назад" зі
// сторінки оплати monobank. pageshow з event.persisted ловить саме це повернення.
export function onBfcacheRestore(handler) {
    window.addEventListener('pageshow', (event) => { if (event.persisted) handler(); });
}

// --- Редірект на сторінку оплати ---

export function redirectToPayment(pageUrl) {
    location.assign(pageUrl);
}

// --- Аналітика покупки: один раз на orderID, незалежно від того, скільки разів ---
// клієнт відкриє/оновить order-status.html після оплати.
export function trackPurchaseOnce(orderID, items, total) {
    const key = PURCHASE_TRACKED_PREFIX + orderID;
    try {
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, '1');
    } catch { /* якщо localStorage недоступний, ризикуємо подвійним трекінгом — не критично */ }
    if (window.trackPurchase) window.trackPurchase(orderID, items, total);
}
