// --- МІНІМАЛЬНИЙ КОШИК (localStorage, без бекенду) ---
// Підключається на всіх клієнтських сторінках (index.html, catalog.html, product.html, faq.html, checkout.html)
// Firestore тут більше не потрібен: замовлення тепер створює серверна
// функція /.netlify/functions/create-order (вона сама рахує ціни й пише в базу
// через Admin SDK). Кошик і раніше зберігався лише в localStorage.
import {
    createPayment, switchPaymentMethod, saveUnfinishedOrder, loadUnfinishedOrder, clearUnfinishedOrder,
    showRedirectOverlay, hideRedirectOverlay, onBfcacheRestore, redirectToPayment, trackPurchaseOnce, checkPaymentStatus,
} from './payment.js';

const CART_KEY = 'silveri_cart';
// Орієнтовна сума передплати для накладеного платежу — лише для тексту в UI до
// оформлення замовлення. Реальну суму завжди рахує й перевіряє сервер (PREPAYMENT_UAH
// у netlify/lib/money.mjs); якщо бізнес-правило зміниться, це значення теж треба оновити.
const PREPAYMENT_UAH_DISPLAY = 200;

// Аналітика: виклик ізольований — помилка трекінгу не має ламати кошик чи оформлення.
function track(fn) {
    try {
        if (window.SilveriAnalytics) fn(window.SilveriAnalytics);
    } catch (e) {
        console.warn('Аналітика:', e);
    }
}

const escapeHTML = (str) => typeof str === 'string'
    ? str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[tag])
    : str;

function getCart() {
    try {
        const raw = localStorage.getItem(CART_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        console.error('Не вдалося прочитати кошик:', e);
        return [];
    }
}

function saveCart(cart) {
    try {
        localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch (e) {
        console.error('Не вдалося зберегти кошик:', e);
    }
    renderCartPanel();
}

function addToCart(item, qty = 1) {
    if (!item || !item.id) return;
    const cart = getCart();
    const existing = cart.find(p => p.id === item.id);
    if (existing) {
        existing.qty += qty;
        if (!existing.category && item.category) existing.category = item.category;
    } else {
        cart.push({ id: item.id, title: item.title, price: item.price, image: item.image, category: item.category || '', qty });
    }
    saveCart(cart);
    track(a => a.addToCart({ id: item.id, title: item.title, price: item.price, category: item.category || (existing && existing.category) || '' }, qty));
    openCartPanel(); // одразу показуємо кошик, щоб було видно, що товар додався (view_cart тут не шлемо)
}

function removeFromCart(id) {
    const cart = getCart();
    const removed = cart.find(p => p.id === id);
    saveCart(cart.filter(p => p.id !== id));
    if (removed) track(a => a.removeFromCart(removed, removed.qty));
}

function setQty(id, qty) {
    const cart = getCart();
    const item = cart.find(p => p.id === id);
    if (!item) return;
    if (qty <= 0) {
        removeFromCart(id);
        return;
    }
    const delta = qty - item.qty;
    item.qty = qty;
    saveCart(cart);
    // Зміна кількості кнопками +/− у панелі — це теж додавання/видалення (у GA4 — на різницю)
    if (delta > 0) track(a => a.addToCart(item, delta));
    else if (delta < 0) track(a => a.removeFromCart(item, -delta));
}

function getTotal(cart) {
    return cart.reduce((sum, p) => sum + p.price * p.qty, 0);
}

function getCount(cart) {
    return cart.reduce((sum, p) => sum + p.qty, 0);
}

function renderCartPanel() {
    const cart = getCart();
    const countBadge = document.getElementById('cart-count');
    const itemsContainer = document.getElementById('cart-items');
    const totalEl = document.getElementById('cart-total');
    const checkoutBtn = document.getElementById('cart-checkout');

    const count = getCount(cart);
    if (countBadge) {
        countBadge.textContent = count;
        countBadge.hidden = count === 0;
    }

    if (!itemsContainer) return; // на цій сторінці панелі кошика немає — далі нічого малювати

    if (cart.length === 0) {
        itemsContainer.innerHTML = '<p class="cart-empty-msg">Кошик порожній</p>';
        if (totalEl) totalEl.textContent = '0';
        if (checkoutBtn) checkoutBtn.disabled = true;
        return;
    }

    itemsContainer.innerHTML = cart.map(item => `
        <div class="cart-item" data-id="${escapeHTML(item.id)}">
            <img src="${escapeHTML(item.image) || 'img/placeholder.jpg'}" alt="${escapeHTML(item.title)}" class="cart-item-img" loading="lazy">
            <div class="cart-item-info">
                <span class="cart-item-title">${escapeHTML(item.title)}</span>
                <span class="cart-item-price">${item.price} грн</span>
                <div class="cart-item-qty">
                    <button class="qty-btn qty-minus" aria-label="Зменшити кількість">−</button>
                    <span class="qty-value">${item.qty}</span>
                    <button class="qty-btn qty-plus" aria-label="Збільшити кількість">+</button>
                </div>
            </div>
            <button class="cart-item-remove" aria-label="Видалити товар">🗑</button>
        </div>
    `).join('');

    if (totalEl) totalEl.textContent = getTotal(cart);
    if (checkoutBtn) checkoutBtn.disabled = false;
}

function openCartPanel(shouldTrack = false) {
    if (shouldTrack === true) track(a => a.viewCart(getCart()));
    document.getElementById('cart-panel')?.setAttribute('aria-hidden', 'false');
    document.getElementById('cart-overlay')?.setAttribute('aria-hidden', 'false');
    document.getElementById('cart-panel')?.classList.add('open');
    document.getElementById('cart-overlay')?.classList.add('open');
}

function closeCartPanel() {
    document.getElementById('cart-panel')?.classList.remove('open');
    document.getElementById('cart-overlay')?.classList.remove('open');
    document.getElementById('cart-panel')?.setAttribute('aria-hidden', 'true');
    document.getElementById('cart-overlay')?.setAttribute('aria-hidden', 'true');
}

// Автопідказка міста (Нова Пошта) — з дебаунсом, щоб не смикати функцію на кожну літеру
let citySearchTimeout = null;
let citySuggestionsCache = [];

function initCityAutocomplete() {
    const cityInput = document.getElementById('city');
    const suggestionsList = document.getElementById('citySuggestions');
    const cityRefInput = document.getElementById('cityRef');
    if (!cityInput || !suggestionsList) return;

    cityInput.addEventListener('input', () => {
        cityRefInput.value = ''; // місто ще не підтверджене вибором зі списку
        resetWarehouseSelect();

        clearTimeout(citySearchTimeout);
        const q = cityInput.value.trim();
        if (q.length < 2) {
            suggestionsList.hidden = true;
            return;
        }

        citySearchTimeout = setTimeout(async () => {
            try {
                const res = await fetch(`/.netlify/functions/postal-cities?q=${encodeURIComponent(q)}`);
                const cities = await res.json();
                citySuggestionsCache = cities;
                renderCitySuggestions(cities);
            } catch (e) {
                console.error('Не вдалося завантажити список міст:', e);
            }
        }, 300);
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.autocomplete-wrapper')) suggestionsList.hidden = true;
    });

    suggestionsList.addEventListener('click', (e) => {
        const li = e.target.closest('li[data-ref]');
        if (!li) return;
        cityInput.value = li.textContent;
        cityRefInput.value = li.dataset.ref;
        suggestionsList.hidden = true;
        loadWarehouses(li.dataset.ref);
        validateStep('delivery', { showErrors: false }); // місто обрано — оновлюємо статус/summary кроку "Доставка"
    });
}

function renderCitySuggestions(cities) {
    const suggestionsList = document.getElementById('citySuggestions');
    if (cities.length === 0) {
        suggestionsList.innerHTML = '<li class="no-results">Місто не знайдено</li>';
    } else {
        suggestionsList.innerHTML = cities.map(c => `<li data-ref="${c.ref}">${escapeHTML(c.name)}</li>`).join('');
    }
    suggestionsList.hidden = false;
}

function resetWarehouseSelect() {
    const select = document.getElementById('warehouse');
    const warehouseRefInput = document.getElementById('warehouseRef');
    const wrapper = document.getElementById('warehouseFieldWrapper');
    if (!select) return;
    select.innerHTML = '<option value="">Оберіть...</option>';
    if (warehouseRefInput) warehouseRefInput.value = '';
    if (wrapper) wrapper.hidden = true; // ховаємо поле знову, якщо місто змінили/стерли
}

let lastFetchedWarehouses = [];

async function loadWarehouses(cityRef) {
    const select = document.getElementById('warehouse');
    const wrapper = document.getElementById('warehouseFieldWrapper');
    if (!select) return;

    // Місто підтверджене (обрано зі списку підказок) — саме час показати поле
    // вибору відділення/поштомату; до цього моменту воно приховане повністю (п. ТЗ).
    if (wrapper) wrapper.hidden = false;
    select.innerHTML = '<option value="">Завантаження...</option>';
    select.disabled = true;

    try {
        const format = document.querySelector('input[name="deliveryFormat"]:checked')?.value || 'branch';
        const res = await fetch(`/.netlify/functions/postal-warehouses?cityRef=${encodeURIComponent(cityRef)}`);
        const warehouses = await res.json();
        lastFetchedWarehouses = warehouses;
        renderWarehouseOptions(warehouses, format);
    } catch (e) {
        console.error('Не вдалося завантажити список відділень:', e);
        select.innerHTML = '<option value="">Не вдалося завантажити — спробуйте ще раз</option>';
    }
}

function renderWarehouseOptions(warehouses, format) {
    const select = document.getElementById('warehouse');
    const filtered = warehouses.filter(w => w.type === format);

    if (filtered.length === 0) {
        select.innerHTML = `<option value="">Немає ${format === 'postomat' ? 'поштоматів' : 'відділень'} у цьому місті</option>`;
        select.disabled = true;
        return;
    }

    select.innerHTML = '<option value="">Оберіть...</option>' +
        filtered.map(w => `<option value="${w.ref}">${escapeHTML(w.name)}</option>`).join('');
    select.disabled = false;
}


function goToCheckout() {
    if (getCart().length === 0) return;
    window.location.href = 'checkout.html';
}

// Людський, короткий ID замовлення на кшталт "SIL-482913" — використовується як
// сам ID документа в Firestore, тому стає центральним ідентифікатором усюди в адмінці.
function generateOrderId() {
    return 'SIL-' + Date.now().toString().slice(-6);
}

// --- Акордеон кроків чекауту (checkout.html) ---
// Кожен крок валідується незалежно; стан "розгорнуто/згорнуто" тримаємо
// лише в пам'яті (сесійний JS-об'єкт), без localStorage.

const CHECKOUT_STEP_KEYS = ['contact', 'packaging', 'delivery', 'comment', 'payment'];

// Коли на сторінку повернулися з незавершеного замовлення (банер "У вас є неоплачене
// замовлення…") і клієнт обрав "Змінити спосіб оплати", сюди записуємо { orderID, token }.
// Поки це значення не null, кнопка форми не створює нове замовлення, а лише змінює
// спосіб оплати для orderID і одразу створює інвойс (архітектурний опис, 10.4).
let unfinishedContext = null;
const accordionState = {};

// --- Телефон: маска +380 XX XXX XX XX ---
// Префікс "+380" — окремий нередагований бейдж поза полем вводу (не частина value),
// тому вимогу ТЗ "заборонити видалення префікса" виконано конструктивно, без ручного
// відстеження позиції курсора в одному полі. Поле <input> містить лише 9 цифр номера,
// відформатованих групами; нормалізоване значення для сервера збирається окремо.
const PHONE_DIGITS_LEN = 9;

// Розпізнає вставку в поширених форматах: 0671234567 / 380671234567 / +380671234567,
// а також уже відформатований ввід — завжди повертає лише "чисті" цифри номера (без 380/0).
function extractPhoneDigits(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('380')) d = d.slice(3);
    else if (d.startsWith('0')) d = d.slice(1);
    return d.slice(0, PHONE_DIGITS_LEN);
}

function formatPhoneDigits(digits) {
    const parts = [];
    if (digits.length > 0) parts.push(digits.slice(0, 2));
    if (digits.length > 2) parts.push(digits.slice(2, 5));
    if (digits.length > 5) parts.push(digits.slice(5, 7));
    if (digits.length > 7) parts.push(digits.slice(7, 9));
    return parts.join(' ');
}

// +380XXXXXXXXX при повних 9 цифрах, інакше '' (невалідно/незаповнено)
function getNormalizedPhone(rawValue) {
    const digits = extractPhoneDigits(rawValue);
    return digits.length === PHONE_DIGITS_LEN ? '+380' + digits : '';
}

function updatePhoneValidIcon(input) {
    const icon = document.getElementById('customerPhoneValidIcon');
    if (!icon) return;
    icon.hidden = !getNormalizedPhone(input.value);
}

function initPhoneMask() {
    const input = document.getElementById('customerPhone');
    if (!input) return; // не на сторінці чекауту

    input.addEventListener('input', () => {
        input.value = formatPhoneDigits(extractPhoneDigits(input.value));
        updatePhoneValidIcon(input);
    });

    // Вставка (Ctrl+V / контекстне меню) — розпізнаємо формат вручну замість дефолтної вставки,
    // щоб одразу привести 0671234567 / 380671234567 / +380671234567 до єдиного вигляду.
    input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData)?.getData('text') || '';
        input.value = formatPhoneDigits(extractPhoneDigits(pasted));
        updatePhoneValidIcon(input);
        input.dispatchEvent(new Event('input', { bubbles: true })); // щоб спрацювала жива валідація кроку
    });
}

function validateContactStep(form) {
    const errors = {};
    if (!form.customerName.value.trim()) errors.customerName = "Вкажіть ім'я та прізвище";

    const rawPhone = form.customerPhone.value.trim();
    if (!getNormalizedPhone(rawPhone)) {
        errors.customerPhone = rawPhone ? 'Перевірте номер — має бути 9 цифр після +380' : 'Вкажіть номер телефону';
    }

    // Email необов'язковий: порожньо — валідно; заповнено — перевіряємо через нативний checkValidity()
    const emailInput = form.customerEmail;
    if (emailInput && emailInput.value.trim() && !emailInput.checkValidity()) {
        errors.customerEmail = 'Перевірте формат email';
    }

    return { valid: Object.keys(errors).length === 0, errors };
}
function summaryContactStep(form) {
    const parts = [form.customerName.value.trim()];
    const normalizedPhone = getNormalizedPhone(form.customerPhone.value);
    if (normalizedPhone) parts.push('+380 ' + formatPhoneDigits(extractPhoneDigits(form.customerPhone.value)));
    return parts.filter(Boolean).join(', ');
}

// Крок "Упакування" (розділ 5 ТЗ). Дані (активні варіанти з Firestore) вантажить
// script.js і передає сюди через window.renderPackagingOptions — рендер карток,
// вибір і перерахунок підсумку живуть тут же, поруч із рештою акордеону.
let packagingOptionsCache = [];

function validatePackagingStep(form) {
    // Немає жодного активного варіанта (порожня адмінка або мережева помилка) —
    // крок нейтральний, замовлення оформлюється без пакування.
    if (packagingOptionsCache.length === 0) return { valid: true, errors: {}, optional: true };
    const selected = form.packagingId ? form.packagingId.value : '';
    // Помилки тут не текстові (це не поле вводу, а картки вибору) — досить статус-іконки кроку.
    return selected ? { valid: true, errors: {} } : { valid: false, errors: {} };
}
function summaryPackagingStep(form) {
    if (packagingOptionsCache.length === 0) return 'Без додаткового пакування';
    const checked = form.querySelector('input[name="packagingId"]:checked');
    if (!checked) return '';
    const price = Number(checked.dataset.price) || 0;
    return `${checked.dataset.title} — ${price > 0 ? '+' + price + ' грн' : 'безкоштовно'}`;
}

// Викликається з script.js (там ініціалізовано Firestore) після одноразового getDocs
// активних варіантів пакування — рендерить картки вибору в кроці акордеону.
window.renderPackagingOptions = function (options) {
    packagingOptionsCache = Array.isArray(options) ? options : [];
    const container = document.getElementById('packagingOptionsList');
    if (!container) return; // не сторінка чекауту

    if (packagingOptionsCache.length === 0) {
        container.innerHTML = '<p class="checkout-placeholder-note">Наразі немає доступних варіантів пакування — замовлення буде оформлено без додаткового вибору.</p>';
    } else {
        const defaultOption = packagingOptionsCache.find(o => o.isDefault) || packagingOptionsCache[0];
        container.innerHTML = packagingOptionsCache.map(opt => `
            <label class="packaging-card">
                <input type="radio" name="packagingId" value="${escapeHTML(opt.id)}"
                       data-price="${opt.price}" data-title="${escapeHTML(opt.title)}" data-image="${escapeHTML(opt.image) || ''}"
                       ${opt.id === defaultOption.id ? 'checked' : ''}>
                <span class="packaging-card-check" aria-hidden="true"></span>
                <span class="packaging-card-thumb-wrap">
                    <img src="${escapeHTML(opt.image) || 'img/placeholder.jpg'}" alt="" class="packaging-card-thumb" loading="lazy">
                </span>
                <span class="packaging-card-title" title="${escapeHTML(opt.title)}">${escapeHTML(opt.title)}</span>
                <span class="packaging-card-price">${opt.price > 0 ? `+${opt.price} грн` : 'Безкоштовно'}</span>
                ${opt.description ? `<span class="packaging-card-desc" title="${escapeHTML(opt.description)}">${escapeHTML(opt.description)}</span>` : ''}
            </label>
        `).join('');
    }

    validateStep('packaging', { showErrors: false });
    renderCheckoutSummary(); // сума в підсумку має враховувати дефолтний варіант одразу після завантаження
    updatePackagingCarouselNav(); // перерахувати стан стрілок під новий вміст
};

// --- Стрілки прокрутки каруселі пакування ---
// Скролимо контейнер на ширину ~2.5 картки за клік і вимикаємо стрілку
// на тому краю, де прокручувати вже нікуди (звичайна поведінка каруселі).
function scrollPackagingCarousel(direction) {
    const list = document.getElementById('packagingOptionsList');
    if (!list) return;
    list.scrollBy({ left: direction * 260, behavior: 'smooth' });
}

function updatePackagingCarouselNav() {
    const list = document.getElementById('packagingOptionsList');
    const prevBtn = document.querySelector('.packaging-carousel-prev');
    const nextBtn = document.querySelector('.packaging-carousel-next');
    if (!list || !prevBtn || !nextBtn) return;

    const maxScroll = list.scrollWidth - list.clientWidth;
    prevBtn.disabled = list.scrollLeft <= 1;
    nextBtn.disabled = list.scrollLeft >= maxScroll - 1;
}

function initPackagingCarousel() {
    const list = document.getElementById('packagingOptionsList');
    if (!list) return; // не на сторінці чекауту

    document.querySelector('.packaging-carousel-prev')?.addEventListener('click', () => scrollPackagingCarousel(-1));
    document.querySelector('.packaging-carousel-next')?.addEventListener('click', () => scrollPackagingCarousel(1));
    list.addEventListener('scroll', updatePackagingCarouselNav);
    window.addEventListener('resize', updatePackagingCarouselNav);
    updatePackagingCarouselNav();
}

// Ціна обраного зараз варіанта пакування (0, якщо нічого не обрано/недоступно)
function getSelectedPackagingPrice() {
    const checked = document.querySelector('input[name="packagingId"]:checked');
    return checked ? Number(checked.dataset.price) || 0 : 0;
}

function validateDeliveryStep(form) {
    const errors = {};
    if (!form.city.value.trim() || !form.cityRef.value) errors.city = 'Оберіть місто зі списку підказок';
    if (!form.warehouse.value) errors.warehouse = 'Оберіть відділення або поштомат';
    return { valid: Object.keys(errors).length === 0, errors };
}
function summaryDeliveryStep(form) {
    const city = form.city.value.trim();
    if (!city) return '';
    const warehouseSelect = form.warehouse;
    const warehouseText = warehouseSelect.value ? warehouseSelect.options[warehouseSelect.selectedIndex].text : '';
    const formatLabel = form.deliveryFormat.value === 'postomat' ? 'поштомат' : 'відділення';
    return warehouseText ? `${city}, ${formatLabel} ${warehouseText}` : city;
}

function validateCommentStep() {
    return { valid: true, errors: {}, optional: true };
}
function summaryCommentStep(form) {
    const comment = form.comment.value.trim();
    if (!comment) return 'Без коментаря';
    return comment.length > 40 ? comment.slice(0, 40) + '…' : comment;
}

const PAYMENT_METHOD_LABELS = { online: 'Оплата карткою', cod: 'Накладений платіж', fop: 'Оплата на рахунок ФОП' };
function validatePaymentStep() {
    return { valid: true, errors: {} }; // завжди є значення за замовчуванням (радіо-кнопка checked)
}
function summaryPaymentStep(form) {
    return PAYMENT_METHOD_LABELS[form.paymentMethod.value] || '';
}

// Накладений платіж вимикаємо, якщо сума замовлення не більша за передплату —
// інакше передплата покривала б усю суму (сервер про всяк випадок перевіряє це
// самостійно й відхилив би таке замовлення — money.mjs, isCodAllowed).
function updateCodAvailability(totalUah) {
    const codInput = document.getElementById('pay-cod');
    const codOption = document.getElementById('pay-cod-option');
    const codDesc = document.getElementById('pay-cod-desc');
    if (!codInput || !codOption) return;
    const allowed = totalUah > PREPAYMENT_UAH_DISPLAY;
    codInput.disabled = !allowed;
    codOption.classList.toggle('payment-option-disabled', !allowed);
    if (codDesc) {
        codDesc.textContent = allowed
            ? `Передплата ${PREPAYMENT_UAH_DISPLAY} грн карткою зараз, решта — при отриманні`
            : 'Недоступно для замовлень такої суми';
    }
    if (!allowed && codInput.checked) {
        const onlineInput = document.getElementById('pay-online');
        if (onlineInput) onlineInput.checked = true;
    }
}

// Рядки "До сплати зараз / При отриманні" під підсумком (крок 5 архітектурного опису, 10.2).
function renderPaymentDueRows(totalUah) {
    const container = document.getElementById('checkout-due-rows');
    if (!container) return;
    const form = document.getElementById('checkout-form');
    const method = form?.paymentMethod?.value || 'online';

    if (method === 'cod') {
        const dueNow = Math.min(PREPAYMENT_UAH_DISPLAY, totalUah);
        const dueOnDelivery = Math.max(0, totalUah - dueNow);
        container.innerHTML = `
            <div class="checkout-due-row"><span>До сплати зараз:</span><strong>${dueNow} грн</strong></div>
            <div class="checkout-due-row"><span>При отриманні:</span><strong>${dueOnDelivery} грн</strong></div>
        `;
    } else {
        container.innerHTML = `<div class="checkout-due-row"><span>До сплати зараз:</span><strong>${totalUah} грн</strong></div>`;
    }
}

// Текст і іконка кнопки залежать від обраного способу оплати.
function updateSubmitButtonForMethod() {
    const form = document.getElementById('checkout-form');
    const label = document.getElementById('checkout-submit-label');
    const icon = document.getElementById('checkout-submit-icon');
    if (!form || !label) return;
    const method = form.paymentMethod?.value || 'online';
    if (method === 'fop') {
        label.textContent = 'Підтвердити замовлення';
        if (icon) icon.hidden = true;
    } else {
        label.textContent = unfinishedContext ? 'Оновити спосіб оплати та перейти до оплати' : 'Оформити та перейти до оплати';
        if (icon) icon.hidden = false;
    }
}

const CHECKOUT_STEP_CONFIG = {
    contact: { validate: validateContactStep, summary: summaryContactStep },
    packaging: { validate: validatePackagingStep, summary: summaryPackagingStep },
    delivery: { validate: validateDeliveryStep, summary: summaryDeliveryStep },
    comment: { validate: validateCommentStep, summary: summaryCommentStep },
    payment: { validate: validatePaymentStep, summary: summaryPaymentStep },
};

function setFieldError(fieldId, message) {
    const input = document.getElementById(fieldId);
    const errorEl = document.getElementById(`err-${fieldId}`);
    // Поле телефону — рамка валідності візуально на обгортці .phone-field, бо в самого
    // <input> рамку прибрано стилями (щоб бейдж +380 і поле виглядали одним контролом).
    const target = input?.closest('.phone-field') || input;
    if (target) target.classList.toggle('invalid', Boolean(message));
    if (errorEl) errorEl.textContent = message || '';
}

function clearStepFieldErrors(stepKey) {
    const panel = document.getElementById(`step-${stepKey}-panel`);
    if (!panel) return;
    panel.querySelectorAll('.field-error').forEach(el => { el.textContent = ''; });
    panel.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
}

// Легка перевірка одного кроку: оновлює іконку статусу й короткий summary в заголовку,
// і, за потреби (showErrors), показує inline-помилки під конкретними полями.
function validateStep(stepKey, { showErrors = false } = {}) {
    const form = document.getElementById('checkout-form');
    const cfg = CHECKOUT_STEP_CONFIG[stepKey];
    if (!form || !cfg) return true;

    const result = cfg.validate(form);
    clearStepFieldErrors(stepKey);

    if (!result.valid && showErrors) {
        Object.entries(result.errors).forEach(([fieldId, message]) => setFieldError(fieldId, message));
    }

    const statusEl = document.getElementById(`step-${stepKey}-status`);
    const summaryEl = document.getElementById(`step-${stepKey}-summary`);
    const stepEl = document.querySelector(`.checkout-step[data-step="${stepKey}"]`);

    if (summaryEl) summaryEl.textContent = cfg.summary(form) || '';

    if (statusEl) {
        statusEl.classList.remove('is-valid', 'is-invalid');
        statusEl.removeAttribute('aria-label');
        if (result.valid) {
            // ✓ — крок заповнено коректно
            statusEl.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>';
            statusEl.classList.add('is-valid');
            statusEl.setAttribute('aria-label', 'Крок заповнено');
        } else if (result.optional || !showErrors) {
            // порожньо — крок ще не заповнений, але користувач ще не намагався його завершити
            // (перше завантаження сторінки / живий ввід), тому попередження поки не показуємо
            statusEl.innerHTML = '';
        } else {
            // ⚠ — крок обов'язковий, невалідний, і користувач уже залишив його (blur) або натиснув "Підтвердити"
            statusEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>';
            statusEl.classList.add('is-invalid');
            statusEl.setAttribute('aria-label', 'Потрібно заповнити');
        }
    }
    stepEl?.classList.toggle('has-error', !result.valid && !result.optional && showErrors);

    return result.valid || Boolean(result.optional);
}

function validateAllSteps({ showErrors = false } = {}) {
    let firstInvalidKey = null;
    let allValid = true;
    CHECKOUT_STEP_KEYS.forEach(key => {
        const valid = validateStep(key, { showErrors });
        if (!valid) {
            allValid = false;
            if (!firstInvalidKey) firstInvalidKey = key;
        }
    });
    return { allValid, firstInvalidKey };
}

function setStepOpen(stepKey, isOpen) {
    const stepEl = document.querySelector(`.checkout-step[data-step="${stepKey}"]`);
    const headerEl = document.getElementById(`step-${stepKey}-header`);
    if (!stepEl || !headerEl) return;
    stepEl.classList.toggle('open', isOpen);
    headerEl.setAttribute('aria-expanded', String(isOpen));
    accordionState[stepKey] = isOpen;
}

// Індекс кроку зараз розгорнутого (єдиного за раз) в CHECKOUT_STEP_KEYS.
let currentStepIndex = 0;

function stepIndexOf(stepKey) {
    return CHECKOUT_STEP_KEYS.indexOf(stepKey);
}

// Ексклюзивне розкриття: розгортає рівно один крок, решту згортає
// (п. ТЗ — "крок 2 розгортається, а крок 1 згортається").
function openOnlyStep(stepKey) {
    CHECKOUT_STEP_KEYS.forEach(key => setStepOpen(key, key === stepKey));
    currentStepIndex = stepIndexOf(stepKey);
}

// Перевіряє кроки [0, beforeIndex) без показу помилок і повертає ключ
// першого невалідного, або null, якщо всі коректні/необов'язкові.
function findFirstInvalidStepBefore(beforeIndex) {
    for (let i = 0; i < beforeIndex; i++) {
        const key = CHECKOUT_STEP_KEYS[i];
        if (!validateStep(key, { showErrors: false })) return key;
    }
    return null;
}

// Клік по заголовку кроку в акордеоні чекауту.
// Назад (до вже пройденого кроку) — вільно, без перевірок: "без жорсткої
// прив'язки", можна повернутися хоч із кроку 5 до кроку 1, щоб щось виправити.
// Вперед — лише послідовно: відкриваємо цільовий крок тільки якщо всі
// попередні кроки коректно заповнені (або необов'язкові). Якщо ні —
// цільовий крок НЕ відкривається, натомість розгортається перший
// незаповнений попередній крок і в ньому підсвічуються помилкові поля
// (так само, як зараз підсвічується при відході фокуса/спробі оформити).
function handleStepHeaderClick(stepKey) {
    const targetIndex = stepIndexOf(stepKey);
    if (targetIndex === currentStepIndex) return; // вже відкритий — нічого не робимо

    if (targetIndex < currentStepIndex) {
        openOnlyStep(stepKey); // рух назад завжди дозволений
        return;
    }

    const blockingKey = findFirstInvalidStepBefore(targetIndex);
    if (blockingKey) {
        openOnlyStep(blockingKey);
        validateStep(blockingKey, { showErrors: true });
        return;
    }

    openOnlyStep(stepKey);
}

// Розгортає крок з помилкою і скролить/фокусує на ньому — викликається при спробі оформити замовлення
function expandStepAndScroll(stepKey) {
    openOnlyStep(stepKey);
    const stepEl = document.querySelector(`.checkout-step[data-step="${stepKey}"]`);
    if (!stepEl) return;
    stepEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Помилка може бути позначена або прямо на полі (input.invalid), або на його обгортці
    // (напр. .phone-field.invalid — у самого <input> телефону рамку прибрано стилями).
    const invalidField = stepEl.querySelector('input.invalid, select.invalid, textarea.invalid')
        || stepEl.querySelector('.invalid input, .invalid select, .invalid textarea');
    invalidField?.focus({ preventScroll: true });
}

function initAccordion() {
    const accordion = document.getElementById('checkout-accordion');
    if (!accordion) return; // не на сторінці чекауту

    CHECKOUT_STEP_KEYS.forEach(key => {
        document.getElementById(`step-${key}-header`)?.addEventListener('click', () => handleStepHeaderClick(key));
    });

    // Легке "живе" оновлення статусу/summary під час вводу (без показу помилок, щоб не турбувати на кожну літеру)
    accordion.addEventListener('input', (e) => {
        const stepEl = e.target.closest('.checkout-step');
        if (stepEl) validateStep(stepEl.dataset.step, { showErrors: false });
    });
    accordion.addEventListener('change', (e) => {
        const stepEl = e.target.closest('.checkout-step');
        if (stepEl) validateStep(stepEl.dataset.step, { showErrors: false });
        if (e.target.name === 'packagingId') renderCheckoutSummary(); // миттєвий перерахунок суми (п. 5.4 ТЗ)
        // Формат доставки змінили — перефільтровуємо вже завантажені відділення без нового запиту до сервера
        if (e.target.name === 'deliveryFormat' && lastFetchedWarehouses.length > 0) {
            renderWarehouseOptions(lastFetchedWarehouses, e.target.value);
        }
        if (e.target.name === 'paymentMethod') {
            const total = getTotal(getCart()) + getSelectedPackagingPrice();
            renderPaymentDueRows(total);
            updateSubmitButtonForMethod();
        }
    });

    // Втрата фокусу кроком (клік поза ним/таб на інший крок) → повна перевірка з показом помилок
    accordion.addEventListener('focusout', (e) => {
        const stepEl = e.target.closest('.checkout-step');
        if (!stepEl) return;
        setTimeout(() => {
            if (stepEl.contains(document.activeElement)) return; // фокус лишився в межах цього ж кроку
            validateStep(stepEl.dataset.step, { showErrors: true });
        }, 0);
    }, true);

    // Початковий стан: перший незаповнений/некоректний крок розгорнутий, решта згорнуті
    const { firstInvalidKey } = validateAllSteps({ showErrors: false });
    const stepToOpen = firstInvalidKey || CHECKOUT_STEP_KEYS[0];
    openOnlyStep(stepToOpen);
}

// --- Сторінка оформлення замовлення (checkout.html) ---
// Посилання на сторінку товару за його артикулом (той самий формат,
// що й у script.js — product.html?id=АРТИКУЛ), щоб клік у підсумку
// замовлення вів на картку товару.
function productLinkById(id) {
    return `product.html?id=${encodeURIComponent(id)}`;
}

function renderCheckoutSummary() {
    const cart = getCart();
    const summaryEl = document.getElementById('checkout-summary-items');
    const countEl = document.getElementById('checkout-summary-count');
    const totalEl = document.getElementById('checkout-total');
    const emptyState = document.getElementById('checkout-empty');
    const formState = document.getElementById('checkout-form-wrapper');

    if (!summaryEl) return; // не на сторінці чекауту

    if (cart.length === 0) {
        if (emptyState) emptyState.hidden = false;
        if (formState) formState.hidden = true;
        return;
    }

    if (emptyState) emptyState.hidden = true;
    if (formState) formState.hidden = false;

    // Кількість одиниць товару в замовленні (сума qty, а не кількість
    // різних позицій) — той самий підрахунок, що й у бейджі кошика (getCount).
    if (countEl) {
        const totalQty = getCount(cart);
        countEl.textContent = `Обрано товарів: ${totalQty}`;
    }

    const packagingChecked = document.querySelector('input[name="packagingId"]:checked');
    const packagingPrice = getSelectedPackagingPrice();

    const itemsHtml = cart.map(item => `
        <a class="checkout-summary-line checkout-summary-line-link" href="${productLinkById(item.id)}" title="Переглянути товар «${escapeHTML(item.title)}» (відкриється в новій вкладці)" target="_blank" rel="noopener noreferrer">
            <img src="${escapeHTML(item.image) || 'img/placeholder.jpg'}" alt="${escapeHTML(item.title)}" loading="lazy">
            <div class="checkout-summary-line-info">
                <span class="checkout-summary-line-title">${escapeHTML(item.title)} × ${item.qty}</span>
                <span class="checkout-summary-line-articul">Артикул: ${escapeHTML(item.id)}</span>
            </div>
            <span class="checkout-summary-line-price">${item.price * item.qty} грн</span>
        </a>
    `).join('');

    const packagingHtml = packagingChecked ? `
        <div class="checkout-summary-line">
            <img src="${escapeHTML(packagingChecked.dataset.image) || 'img/placeholder.jpg'}" alt="" loading="lazy">
            <div class="checkout-summary-line-info">
                <span class="checkout-summary-line-title">Упакування: ${escapeHTML(packagingChecked.dataset.title || '')}</span>
            </div>
            <span class="checkout-summary-line-price">${packagingPrice > 0 ? packagingPrice + ' грн' : 'Безкоштовно'}</span>
        </div>
    ` : '';

    summaryEl.innerHTML = itemsHtml + packagingHtml;

    const newTotal = getTotal(cart) + packagingPrice;
    if (totalEl && totalEl.textContent !== String(newTotal)) {
        totalEl.textContent = newTotal;
        totalEl.classList.add('pulse'); // плавне оновлення суми (п. 5.6 ТЗ)
        setTimeout(() => totalEl.classList.remove('pulse'), 300);
    }
    updateCodAvailability(newTotal);
    renderPaymentDueRows(newTotal);
}

// Скидає кнопку форми в звичайний стан (напис + іконка залежно від обраного способу оплати).
function resetSubmitButton(submitBtn) {
    submitBtn.disabled = false;
    updateSubmitButtonForMethod();
}

// Спільний "хвіст" після того, як create-payment/switch-payment-method повернув pageUrl:
// показуємо оверлей і одразу редіректимо в тій самій вкладці.
function goToMonoPage(pageUrl) {
    showRedirectOverlay('Переходимо на сторінку оплати…');
    redirectToPayment(pageUrl);
}

async function submitOrder(event) {
    event.preventDefault();
    const form = event.target;

    // Клієнт повернувся з незавершеного замовлення і обрав "Змінити спосіб оплати" —
    // це не нове замовлення, а зміна методу для вже створеного (архітектурний опис, 10.4/10.7).
    if (unfinishedContext) {
        return submitSwitchedPayment(event, form);
    }

    const cart = getCart();
    if (cart.length === 0) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    const submitLabel = document.getElementById('checkout-submit-label');
    const errorEl = document.getElementById('checkout-error');
    if (errorEl) errorEl.textContent = '';

    // Валідація по кроках акордеону: кожен крок перевіряється незалежно;
    // при помилці — розгортаємо й скролимо до першого проблемного кроку,
    // помилки показуються inline під конкретними полями (не одним загальним текстом).
    const { allValid, firstInvalidKey } = validateAllSteps({ showErrors: true });
    if (!allValid) {
        expandStepAndScroll(firstInvalidKey);
        if (errorEl) errorEl.textContent = 'Перевірте позначені поля вище.';
        track(a => a.checkoutError('validation'));
        return;
    }

    const name = form.customerName.value.trim();
    const phone = getNormalizedPhone(form.customerPhone.value); // нормалізовано: +380XXXXXXXXX
    const email = form.customerEmail.value.trim();
    const deliveryType = form.deliveryType.value;
    const deliveryFormat = form.deliveryFormat.value;
    const city = form.city.value.trim();
    const cityRef = form.cityRef.value;
    const warehouseSelect = form.warehouse;
    const warehouse = warehouseSelect.value ? warehouseSelect.options[warehouseSelect.selectedIndex].text : '';
    const warehouseRef = warehouseSelect.value;
    const paymentMethod = form.paymentMethod.value;
    const comment = form.comment.value.trim();
    const packagingId = form.packagingId ? form.packagingId.value : '';
    const isPayable = paymentMethod === 'online' || paymentMethod === 'cod';

    submitBtn.disabled = true;
    if (submitLabel) submitLabel.textContent = 'Оформлюємо…';

    // Форма валідна — це кроки воронки "доставка" і "оплата"
    track(a => {
        a.addShipping(cart, { deliveryType, deliveryFormat });
        a.addPayment(cart, { paymentMethod });
    });

    // Контекст для серверної події Meta CAPI (fbp/fbc, GA client_id, згода). Ніколи не
    // блокує оформлення — збій тут лише означає, що CAPI-подія вийде менш точною.
    let tracking = null;
    try {
        if (window.SilveriAnalytics) tracking = await window.SilveriAnalytics.getTrackingContext();
    } catch (e) {
        console.warn('Аналітика: не вдалося зібрати контекст', e);
    }

    // Токен App Check (script.js): підтверджує серверу, що запит іде з нашого сайту.
    // Якщо його не вдалося отримати — шлемо без нього, рішення за create-order.
    const orderHeaders = { 'Content-Type': 'application/json' };
    try {
        const appCheckToken = window.silveriGetAppCheckToken ? await window.silveriGetAppCheckToken() : null;
        if (appCheckToken) orderHeaders['X-Firebase-AppCheck'] = appCheckToken;
    } catch (e) {
        console.warn('App Check: токен недоступний', e);
    }

    try {
        const response = await fetch('/.netlify/functions/create-order', {
            method: 'POST',
            headers: orderHeaders,
            body: JSON.stringify({
                items: cart.map(({ id, qty }) => ({ id, qty })), // ціну сервер бере сам із бази
                customer: { name, phone, email },
                delivery: { deliveryType, deliveryFormat, city, cityRef, warehouse, warehouseRef, paymentMethod, comment, packagingId },
                attribution: window.getStoredUTM ? window.getStoredUTM() : null,
                tracking,
            }),
        });

        // Ліміт Netlify (429) може прийти не JSON-ом — не даємо цьому зламати показ помилки.
        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
            if (response.status === 409 && Array.isArray(result.unavailable)) {
                track(a => a.checkoutError('unavailable'));
                if (errorEl) errorEl.textContent = 'На жаль, деякі товари вже розкупили. Оновіть кошик і спробуйте ще раз.';
            } else {
                track(a => a.checkoutError(response.status === 429 ? 'rate_limited' : 'server_error'));
                if (errorEl) {
                    errorEl.textContent = result.error
                        || (response.status === 429
                            ? 'Забагато спроб. Зачекайте хвилину й спробуйте ще раз.'
                            : 'Щось пішло не так. Спробуйте ще раз або напишіть нам напряму в Telegram/Viber.');
                }
            }
            resetSubmitButton(submitBtn);
            return;
        }

        // Спосіб оплати без monobank (ФОП): замовлення вже "в роботі", далі — як і раніше.
        // trackPurchaseOnce шле GA4/Meta-пiксель у браузері. Серверна CAPI-подія для fop
        // за замовчуванням вимкнена (create-order.mjs, CAPI_FOP_ON_CREATE); якщо її
        // ввімкнуть, обидві події йдуть з event_id = orderID, тож Meta сам зливає дублі.
        if (!isPayable) {
            const categoryById = new Map(cart.map(c => [c.id, c.category || '']));
            trackPurchaseOnce(result.orderID, result.items.map(i => ({ ...i, category: categoryById.get(i.id) || '' })), result.total);
            showCheckoutSuccess(result.orderID, result.items, result.total, { name, phone, city, warehouse, deliveryType, deliveryFormat, paymentMethod, comment, packaging: result.packaging });
            localStorage.removeItem(CART_KEY);
            renderCartPanel();
            return;
        }

        // online / cod: замовлення створене, але ще не оплачене. Кошик НЕ очищаємо і
        // trackPurchase НЕ викликаємо — це станеться лише після підтвердженої оплати
        // на order-status.html (архітектурний опис, 10.6). Зберігаємо контекст на
        // випадок, якщо клієнт закриє вкладку оплати чи натисне "Назад".
        saveUnfinishedOrder(result.orderID, result.statusToken, paymentMethod);
        if (submitLabel) submitLabel.textContent = 'Готуємо оплату…';

        const payRes = await createPayment(result.orderID, result.statusToken);

        if (payRes.ok && payRes.pageUrl) {
            goToMonoPage(payRes.pageUrl);
            return; // сторінка зараз перейде на monobank
        }
        if (payRes.ok && payRes.status) {
            // Рідкісний випадок: поки чекали на createPayment, оплата вже підтвердилась іншим шляхом.
            // Токен НЕ кладемо в URL (історія браузера, аналітика): order-status.js бере його
            // із sessionStorage (saveUnfinishedOrder вище) і сам очищає запис після показу результату,
            // тож clearUnfinishedOrder() тут не викликаємо.
            location.assign(`order-status.html?orderID=${encodeURIComponent(result.orderID)}`);
            return;
        }

        // Замовлення створено, а перейти до оплати не вдалося — не втрачаємо форму,
        // показуємо окрему панель з можливістю повторити чи написати нам напряму
        // (архітектурний опис, 10.4).
        showPaymentRetryPanel({ orderID: result.orderID, token: result.statusToken, method: paymentMethod, reason: payRes.error });
    } catch (e) {
        console.error('Не вдалося оформити замовлення:', e);
        track(a => a.checkoutError('network_error'));
        if (errorEl) errorEl.textContent = 'Щось пішло не так. Спробуйте ще раз або напишіть нам напряму в Telegram/Viber.';
        resetSubmitButton(submitBtn);
    }
}

// Клієнт у режимі "змінити спосіб оплати для вже створеного замовлення" (unfinishedContext).
// Інші кроки форми (контакти/доставка/коментар) тут не читаються й не валідуються —
// вони стосуються нового замовлення, а не зміни методу для наявного.
async function submitSwitchedPayment(event, form) {
    const { orderID, token } = unfinishedContext;
    const method = form.paymentMethod.value;
    const submitBtn = form.querySelector('button[type="submit"]');
    const submitLabel = document.getElementById('checkout-submit-label');
    const errorEl = document.getElementById('checkout-error');
    if (errorEl) errorEl.textContent = '';

    submitBtn.disabled = true;
    if (submitLabel) submitLabel.textContent = 'Оновлюємо спосіб оплати…';

    const switchRes = await switchPaymentMethod(orderID, token, method);
    if (!switchRes.ok) {
        if (errorEl) errorEl.textContent = switchRes.error || 'Не вдалося змінити спосіб оплати. Спробуйте ще раз.';
        resetSubmitButton(submitBtn);
        return;
    }

    if (method === 'fop') {
        // Оплата поза monobank: більше нема чого чекати, замовлення вже "в роботі".
        clearUnfinishedOrder();
        unfinishedContext = null;
        localStorage.removeItem(CART_KEY);
        renderCartPanel();
        showCheckoutSuccess(orderID, [], 0, { name: '', phone: '', city: '', warehouse: '', deliveryType: '', deliveryFormat: '', paymentMethod: 'fop', comment: '', packaging: null }, { skipItems: true });
        return;
    }

    saveUnfinishedOrder(orderID, token, method);
    if (submitLabel) submitLabel.textContent = 'Готуємо оплату…';
    const payRes = await createPayment(orderID, token);
    if (payRes.ok && payRes.pageUrl) {
        goToMonoPage(payRes.pageUrl);
        return;
    }
    showPaymentRetryPanel({ orderID, token, method, reason: payRes.error });
}

// Панель "не вдалося перейти до оплати" замість зникнення форми (архітектурний опис, 10.4).
function showPaymentRetryPanel({ orderID, token, method, reason }) {
    hideRedirectOverlay();
    const root = document.getElementById('checkout-root');
    if (!root) return;
    root.innerHTML = `
        <div class="checkout-retry">
            <h1>Замовлення №${orderID} створено</h1>
            <p>Але перейти до оплати зараз не вдалося${reason ? `: ${escapeHTML(reason)}` : '.'}</p>
            <p>Замовлення збережено — спробуйте ще раз за хвилину, оберіть інший спосіб оплати або напишіть нам напряму.</p>
            <div class="checkout-retry-buttons">
                <button type="button" id="retry-pay-btn" class="btn-main">Спробувати ще раз</button>
                <button type="button" id="retry-switch-btn" class="btn-secondary">Обрати інший спосіб оплати</button>
            </div>
            <p class="checkout-alt-channel">Або напишіть нам напряму, вкажіть номер замовлення:</p>
            <div class="not-found-buttons">
                <a href="https://t.me/solomia_ka?text=${encodeURIComponent(`Добрий день! Не вдалося оплатити замовлення ${orderID}`)}" target="_blank" rel="noopener noreferrer" class="modal-btn btn-tg">Telegram</a>
                <a href="viber://chat?number=%2B380680243337" target="_blank" rel="noopener noreferrer" class="modal-btn btn-vb">Viber</a>
            </div>
        </div>
    `;
    document.getElementById('retry-pay-btn')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Готуємо оплату…';
        const payRes = await createPayment(orderID, token);
        if (payRes.ok && payRes.pageUrl) { goToMonoPage(payRes.pageUrl); return; }
        e.target.disabled = false;
        e.target.textContent = 'Спробувати ще раз';
        alert(payRes.error || 'Не вдалося перейти до оплати. Спробуйте пізніше.');
    });
    document.getElementById('retry-switch-btn')?.addEventListener('click', () => {
        location.reload(); // чекаут-форма заново прочитає sessionStorage і покаже банер зміни способу
    });
}

const DELIVERY_TYPE_LABELS = { nova_poshta: 'Нова Пошта', ukrposhta: 'Укрпошта' };
const DELIVERY_FORMAT_LABELS = { branch: 'відділення', postomat: 'поштомат' };

// Показується лише для замовлень без онлайн-оплати (fop, і fop-гілка перемикання
// способу оплати для незавершеного замовлення). Для online/cod підтвердження
// показує order-status.html після реальної оплати.
function showCheckoutSuccess(orderID, items, total, details, opts = {}) {
    const root = document.getElementById('checkout-root');
    if (!root) return;

    const hasDetails = !opts.skipItems && details.phone;
    const lines = items.map(item => `${item.title} (арт. ${item.id}) — ${item.qty} шт. x ${item.price} грн`).join('\n');
    const deliveryLabel = hasDetails ? `${DELIVERY_TYPE_LABELS[details.deliveryType] || details.deliveryType}, ${DELIVERY_FORMAT_LABELS[details.deliveryFormat] || ''} ${details.warehouse}, ${details.city}` : '';
    const packagingLine = details.packaging ? `\nУпакування: ${details.packaging.title}${details.packaging.price > 0 ? ` (+${details.packaging.price} грн)` : ' (безкоштовно)'}` : '';
    const messageText = hasDetails
        ? `Добрий день! Оформив(-ла) замовлення ${orderID}:\n${lines}${packagingLine}\n\nРазом: ${total} грн.\nІм'я: ${details.name}\nТелефон: ${details.phone}\nДоставка: ${deliveryLabel}`
        : `Добрий день! Питання щодо замовлення ${orderID}`;

    root.innerHTML = `
        <div class="checkout-success">
            <h1>Замовлення №${orderID} оформлено 💗</h1>
            <p>Ми отримали ваше замовлення та зв'яжемося з вами для підтвердження деталей.</p>
            ${opts.skipItems ? '' : `
            <div class="checkout-summary-items">
                ${items.map(item => `
                    <div class="checkout-summary-line">
                        <img src="${escapeHTML(item.image) || 'img/placeholder.jpg'}" alt="${escapeHTML(item.title)}" loading="lazy">
                        <div class="checkout-summary-line-info">
                            <span class="checkout-summary-line-title">${escapeHTML(item.title)} × ${item.qty}</span>
                            <span class="checkout-summary-line-articul">Артикул: ${escapeHTML(item.id)}</span>
                        </div>
                        <span class="checkout-summary-line-price">${item.price * item.qty} грн</span>
                    </div>
                `).join('')}
                ${details.packaging ? `
                    <div class="checkout-summary-line">
                        <div class="checkout-summary-line-info">
                            <span class="checkout-summary-line-title">Упакування: ${escapeHTML(details.packaging.title)}</span>
                        </div>
                        <span class="checkout-summary-line-price">${details.packaging.price > 0 ? details.packaging.price + ' грн' : 'Безкоштовно'}</span>
                    </div>
                ` : ''}
            </div>`}
            ${hasDetails ? `<p>Ми зв'яжемось з вами за телефоном <strong>${escapeHTML(details.phone)}</strong> найближчим часом.</p>` : ''}
            <p class="checkout-alt-channel">Хочете прискорити — напишіть нам одразу в месенджер:</p>
            <div class="not-found-buttons">
                <a href="https://t.me/solomia_ka?text=${encodeURIComponent(messageText)}" target="_blank" rel="noopener noreferrer" class="modal-btn btn-tg">Telegram</a>
                <a href="viber://chat?number=%2B380680243337" target="_blank" rel="noopener noreferrer" class="modal-btn btn-vb">Viber</a>
            </div>
            <a href="catalog.html" class="back-to-catalog" style="display:inline-block; margin-top: 25px;">← Повернутись у каталог</a>
        </div>
    `;
}

// --- Незавершене замовлення (клієнт закрив/повернувся зі сторінки оплати monobank) ---
// Архітектурний опис, 10.4.
const UNFINISHED_STATUS_LABELS = {
    pending: 'ще не оплачено', processing: 'очікує підтвердження оплати',
    failed: 'оплата не пройшла', expired: 'час на оплату минув', payment_error: 'оплату не вдалося створити',
};

async function initUnfinishedOrderBanner() {
    const banner = document.getElementById('checkout-unfinished-order');
    if (!banner) return; // не на сторінці чекауту

    const pending = loadUnfinishedOrder();
    if (!pending) return;

    const status = await checkPaymentStatus(pending.orderID, pending.token);
    if (!status.ok) { clearUnfinishedOrder(); return; } // токен більше не діє / замовлення не знайдено

    if (['paid', 'prepaid'].includes(status.paymentStatus)) {
        clearUnfinishedOrder(); // оплата вже підтверджена (напр. в іншій вкладці) — банер не потрібен
        return;
    }
    if (!['pending', 'processing', 'failed', 'expired', 'payment_error'].includes(status.paymentStatus)) {
        clearUnfinishedOrder();
        return;
    }

    const statusLabel = UNFINISHED_STATUS_LABELS[status.paymentStatus] || 'ще не оплачено';
    banner.hidden = false;
    banner.innerHTML = `
        <p class="checkout-unfinished-title">У вас є неоплачене замовлення №${status.orderID}</p>
        <p class="checkout-unfinished-desc">${statusLabel}, на суму ${status.totalKop != null ? Math.round(status.totalKop / 100) : ''} грн</p>
        <div class="checkout-unfinished-buttons">
            <button type="button" id="unfinished-continue-btn" class="btn-main">Продовжити оплату</button>
            <button type="button" id="unfinished-switch-btn" class="btn-secondary">Змінити спосіб оплати</button>
            <button type="button" id="unfinished-dismiss-btn" class="checkout-unfinished-dismiss">Приховати</button>
        </div>
    `;

    document.getElementById('unfinished-continue-btn')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Готуємо оплату…';
        const payRes = await createPayment(pending.orderID, pending.token);
        if (payRes.ok && payRes.pageUrl) { goToMonoPage(payRes.pageUrl); return; }
        e.target.disabled = false;
        e.target.textContent = 'Продовжити оплату';
        alert(payRes.error || 'Не вдалося перейти до оплати. Спробуйте пізніше.');
    });
    document.getElementById('unfinished-switch-btn')?.addEventListener('click', () => {
        unfinishedContext = { orderID: pending.orderID, token: pending.token };
        banner.hidden = true;
        openOnlyStep('payment');
        updateSubmitButtonForMethod();
        document.getElementById('step-payment-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('unfinished-dismiss-btn')?.addEventListener('click', () => {
        // Лише ховає нагадування локально — замовлення на сервері не скасовується.
        // Якщо лишиться неоплаченим, автоматично скасується протягом 24 год (reconcile-payments).
        clearUnfinishedOrder();
        banner.hidden = true;
    });
}

// Робимо доступним для script.js (кнопка "У кошик" на картці товару)
window.addToCart = addToCart;


document.addEventListener('DOMContentLoaded', () => {
    renderCartPanel();
    renderCheckoutSummary();
    // Один раз за відвідування сторінки чекауту (не на кожен перерахунок суми,
    // на відміну від renderCheckoutSummary, яка викликається й при зміні упакування).
    if (document.getElementById('checkout-summary-items') && getCart().length > 0) {
        track(a => a.beginCheckout(getCart()));
    }
    initCityAutocomplete();
    initPhoneMask();
    initAccordion();
    initPackagingCarousel();
    updateSubmitButtonForMethod();
    initUnfinishedOrderBanner();
    document.getElementById('checkout-form')?.addEventListener('submit', submitOrder);

    // iOS Safari може відновити сторінку чекауту з bfcache (стан JS "заморожений") після
    // натискання "Назад" зі сторінки оплати monobank — знімаємо оверлей/розблоковуємо
    // кнопку й даємо банеру незавершеного замовлення показатись заново (архітектурний опис, 10.4).
    onBfcacheRestore(() => {
        hideRedirectOverlay();
        const submitBtn = document.getElementById('checkout-submit-btn');
        if (submitBtn) resetSubmitButton(submitBtn);
        initUnfinishedOrderBanner();
    });

    document.getElementById('cart-toggle')?.addEventListener('click', () => openCartPanel(true));
    document.getElementById('cart-close')?.addEventListener('click', closeCartPanel);
    document.getElementById('cart-overlay')?.addEventListener('click', closeCartPanel);
    document.getElementById('cart-checkout')?.addEventListener('click', goToCheckout);

    document.getElementById('cart-items')?.addEventListener('click', (e) => {
        const itemEl = e.target.closest('.cart-item');
        if (!itemEl) return;
        const id = itemEl.dataset.id;
        const cart = getCart();
        const item = cart.find(p => p.id === id);
        if (!item) return;

        if (e.target.closest('.qty-plus')) setQty(id, item.qty + 1);
        else if (e.target.closest('.qty-minus')) setQty(id, item.qty - 1);
        else if (e.target.closest('.cart-item-remove')) removeFromCart(id);
    });
});