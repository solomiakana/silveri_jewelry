// Логіка сторінки order-status.html. Лише ЧИТАЄ стан оплати — ніколи не створює
// платіж, тож перезавантаження й кнопка "Назад" тут завжди безпечні
// (архітектурний опис, 10.5).
import { checkPaymentStatus, createPayment, loadUnfinishedOrder, clearUnfinishedOrder, trackPurchaseOnce } from './payment.js';

const CART_KEY = 'silveri_cart';
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 60_000;

const escapeHTML = (str) => typeof str === 'string'
    ? str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[tag])
    : str;

const DELIVERY_TYPE_LABELS = { nova_poshta: 'Нова Пошта' };

function getParams() {
    const url = new URL(location.href);
    return { orderID: url.searchParams.get('orderID') || '' };
}

// Токен ми навмисно не кладемо в URL (щоб він не лишався в історії браузера й
// логах) — беремо його з того самого запису sessionStorage, що зберіг чекаут
// перед редіректом на monobank. Якщо клієнт відкрив посилання в ІНШОМУ браузері
// (наприклад, повернувся із застосунку банку), токена тут не буде — це очікувано,
// сторінка тоді показує нейтральне повідомлення без спроби прочитати статус.
function resolveToken(orderID) {
    const pending = loadUnfinishedOrder();
    return pending && pending.orderID === orderID ? pending.token : null;
}

function render(html) {
    const root = document.getElementById('order-status-root');
    if (root) root.innerHTML = html;
}

function messengerButtons(orderID, text) {
    const msg = text || `Добрий день! Питання щодо замовлення ${orderID}`;
    return `
        <div class="not-found-buttons">
            <a href="https://t.me/solomia_ka?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener noreferrer" class="modal-btn btn-tg">Telegram</a>
            <a href="viber://chat?number=%2B380680243337" target="_blank" rel="noopener noreferrer" class="modal-btn btn-vb">Viber</a>
        </div>
    `;
}

function renderInvalidLink() {
    render(`
        <div class="order-status-box order-status-neutral">
            <h1>Замовлення не знайдено</h1>
            <p>Перевірте посилання або напишіть нам, і ми все підкажемо.</p>
            ${messengerButtons('')}
            <a href="catalog.html" class="back-to-catalog">← Перейти в каталог</a>
        </div>
    `);
}

function renderNoTokenState(orderID) {
    render(`
        <div class="order-status-box order-status-neutral">
            <h1>Замовлення №${escapeHTML(orderID)}</h1>
            <p>Не вдалося прочитати статус оплати в цьому браузері. Якщо ви оформлювали замовлення на цьому пристрої, поверніться до вкладки з оплатою — статус оновиться там автоматично.</p>
            <p>Або напишіть нам номер замовлення, і ми підтвердимо оплату вручну:</p>
            ${messengerButtons(orderID, `Добрий день! Оплатив(-ла) замовлення ${orderID}, підтвердіть, будь ласка.`)}
        </div>
    `);
}

function itemsHtml(items) {
    return (items || []).map(item => `
        <div class="checkout-summary-line">
            <div class="checkout-summary-line-info">
                <span class="checkout-summary-line-title">${escapeHTML(item.title)} × ${item.qty}</span>
            </div>
            <span class="checkout-summary-line-price">${item.price * item.qty} грн</span>
        </div>
    `).join('');
}

function renderPaid(status) {
    const isPrepaid = status.paymentStatus === 'prepaid';
    const dueUah = status.dueOnDeliveryKop != null ? Math.round(status.dueOnDeliveryKop / 100) : 0;
    render(`
        <div class="order-status-box order-status-success">
            <i class="fa-solid fa-circle-check order-status-icon" aria-hidden="true"></i>
            <h1>${isPrepaid ? 'Передплату отримано' : 'Оплату отримано'}</h1>
            <p>Замовлення №${escapeHTML(status.orderID)} підтверджено. Ми зв'яжемося з вами для узгодження деталей.</p>
            ${isPrepaid && dueUah > 0 ? `<p class="order-status-due">При отриманні до сплати: <strong>${dueUah} грн</strong></p>` : ''}
            <div class="checkout-summary-items">${itemsHtml(status.items)}</div>
            <p class="checkout-alt-channel">Є питання — напишіть нам:</p>
            ${messengerButtons(status.orderID)}
            <a href="catalog.html" class="back-to-catalog">← Повернутись у каталог</a>
        </div>
    `);
}

function renderFailedOrExpired(status, { orderID, token }) {
    const expired = status.paymentStatus === 'expired';
    render(`
        <div class="order-status-box order-status-failed">
            <i class="fa-solid fa-circle-exclamation order-status-icon" aria-hidden="true"></i>
            <h1>${expired ? 'Час на оплату минув' : 'Оплата не пройшла'}</h1>
            <p>Замовлення №${escapeHTML(status.orderID)} збережено. Спробуйте ще раз або оберіть інший спосіб оплати.</p>
            <div class="checkout-retry-buttons">
                <button type="button" id="status-retry-btn" class="btn-main">Спробувати ще раз</button>
                <a href="checkout.html" class="btn-secondary">Обрати інший спосіб оплати</a>
            </div>
            <p class="checkout-alt-channel">Або напишіть нам напряму:</p>
            ${messengerButtons(status.orderID, `Добрий день! Не вдалося оплатити замовлення ${status.orderID}`)}
        </div>
    `);
    document.getElementById('status-retry-btn')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Готуємо оплату…';
        const payRes = await createPayment(orderID, token);
        if (payRes.ok && payRes.pageUrl) { location.assign(payRes.pageUrl); return; }
        e.target.disabled = false;
        e.target.textContent = 'Спробувати ще раз';
        alert(payRes.error || 'Не вдалося перейти до оплати. Спробуйте пізніше.');
    });
}

function renderTimeout(orderID) {
    render(`
        <div class="order-status-box order-status-neutral">
            <h1>Оплату обробляємо</h1>
            <p>Це триває довше, ніж зазвичай. Ми напишемо вам, щойно оплату буде підтверджено.</p>
            <p class="order-status-order-id">Номер замовлення: <strong id="order-id-copy">${escapeHTML(orderID)}</strong>
                <button type="button" id="copy-order-id-btn" class="checkout-unfinished-dismiss" aria-label="Скопіювати номер замовлення"><i class="fa-regular fa-copy"></i></button>
            </p>
            <button type="button" id="status-refresh-btn" class="btn-main">Перевірити ще раз</button>
        </div>
    `);
    document.getElementById('copy-order-id-btn')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(orderID).catch(() => {});
    });
    document.getElementById('status-refresh-btn')?.addEventListener('click', () => location.reload());
}

async function pollStatus(orderID, token) {
    const startedAt = Date.now();
    let settled = false;

    async function tick() {
        if (settled || document.hidden) return; // не опитуємо, поки вкладка прихована
        const status = await checkPaymentStatus(orderID, token);
        if (!status.ok) { settled = true; renderInvalidLink(); return; }

        if (['paid', 'prepaid'].includes(status.paymentStatus)) {
            settled = true;
            trackPurchaseOnce(orderID, status.items, status.items?.reduce((s, i) => s + i.price * i.qty, 0) ?? 0);
            try { localStorage.removeItem(CART_KEY); } catch { /* ignore */ }
            clearUnfinishedOrder();
            renderPaid(status);
            return;
        }
        if (['failed', 'expired'].includes(status.paymentStatus)) {
            settled = true;
            renderFailedOrExpired(status, { orderID, token });
            return;
        }
        // pending / processing / payment_error — продовжуємо опитувати до таймауту
        if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
            settled = true;
            renderTimeout(orderID);
            return;
        }
        setTimeout(tick, POLL_INTERVAL_MS);
    }

    tick();

    // Клієнт часто платить у застосунку банку й повертається на цю вкладку пізніше —
    // перевіряємо одразу, як тільки вкладка знову стає видимою, а не чекаємо наступний тік.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !settled) tick();
    });
}

async function init() {
    const { orderID } = getParams();
    if (!orderID) { renderInvalidLink(); return; }

    const token = resolveToken(orderID);
    if (!token) { renderNoTokenState(orderID); return; }

    await pollStatus(orderID, token);
}

init();
