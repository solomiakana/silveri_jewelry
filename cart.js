// --- МІНІМАЛЬНИЙ КОШИК (localStorage, без бекенду) ---
// Підключається на всіх клієнтських сторінках (index.html, catalog.html, product.html, faq.html, checkout.html)
// Firestore тут більше не потрібен: замовлення тепер створює серверна
// функція /.netlify/functions/create-order (вона сама рахує ціни й пише в базу
// через Admin SDK). Кошик і раніше зберігався лише в localStorage.

const CART_KEY = 'silveri_cart';

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
    } else {
        cart.push({ id: item.id, title: item.title, price: item.price, image: item.image, qty });
    }
    saveCart(cart);
    openCartPanel(); // одразу показуємо кошик, щоб було видно, що товар додався
}

function removeFromCart(id) {
    saveCart(getCart().filter(p => p.id !== id));
}

function setQty(id, qty) {
    const cart = getCart();
    const item = cart.find(p => p.id === id);
    if (!item) return;
    if (qty <= 0) {
        removeFromCart(id);
        return;
    }
    item.qty = qty;
    saveCart(cart);
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

function openCartPanel() {
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
    if (!select) return;
    select.innerHTML = '<option value="">Спершу оберіть місто</option>';
    select.disabled = true;
    if (warehouseRefInput) warehouseRefInput.value = '';
}

let lastFetchedWarehouses = [];

async function loadWarehouses(cityRef) {
    const select = document.getElementById('warehouse');
    if (!select) return;

    select.innerHTML = '<option value="">Завантаження...</option>';
    select.disabled = true;

    try {
        const format = document.getElementById('deliveryFormat')?.value || 'branch';
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

// Сегментовані перемикачі "Формат отримання" на checkout.html
function initSegmentedControls() {
    document.querySelectorAll('.segmented-control').forEach(control => {
        const hiddenInputId = control.id === 'deliveryTypeControl' ? 'deliveryType' : 'deliveryFormat';
        const hiddenInput = document.getElementById(hiddenInputId);
        if (!hiddenInput) return;

        control.querySelectorAll('.segmented-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                control.querySelector('.segmented-btn.active')?.classList.remove('active');
                btn.classList.add('active');
                hiddenInput.value = btn.dataset.value;

                // Формат доставки змінили — перефільтровуємо вже завантажені відділення без нового запиту
                if (hiddenInputId === 'deliveryFormat' && lastFetchedWarehouses.length > 0) {
                    renderWarehouseOptions(lastFetchedWarehouses, btn.dataset.value);
                }
            });
        });
    });
}

// --- Сторінка оформлення замовлення (checkout.html) ---
function renderCheckoutSummary() {
    const cart = getCart();
    const summaryEl = document.getElementById('checkout-summary-items');
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

    summaryEl.innerHTML = cart.map(item => `
        <div class="checkout-summary-line">
            <img src="${escapeHTML(item.image) || 'img/placeholder.jpg'}" alt="${escapeHTML(item.title)}" loading="lazy">
            <div class="checkout-summary-line-info">
                <span class="checkout-summary-line-title">${escapeHTML(item.title)} × ${item.qty}</span>
                <span class="checkout-summary-line-articul">Артикул: ${escapeHTML(item.id)}</span>
            </div>
            <span class="checkout-summary-line-price">${item.price * item.qty} грн</span>
        </div>
    `).join('');

    if (totalEl) totalEl.textContent = getTotal(cart);
}

async function submitOrder(event) {
    event.preventDefault();
    const cart = getCart();
    if (cart.length === 0) return;

    const form = event.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const errorEl = document.getElementById('checkout-error');
    if (errorEl) errorEl.textContent = '';

    const name = form.customerName.value.trim();
    const phone = form.customerPhone.value.trim();
    const deliveryType = form.deliveryType.value;
    const deliveryFormat = form.deliveryFormat.value;
    const city = form.city.value.trim();
    const cityRef = form.cityRef.value;
    const warehouseSelect = form.warehouse;
    const warehouse = warehouseSelect.value ? warehouseSelect.options[warehouseSelect.selectedIndex].text : '';
    const warehouseRef = warehouseSelect.value;
    const paymentMethod = form.paymentMethod.value;
    const comment = form.comment.value.trim();

    if (!name || !phone || !city || !cityRef || !warehouse) {
        if (errorEl) errorEl.textContent = 'Будь ласка, заповніть усі обов’язкові поля — місто й відділення оберіть зі списку підказок.';
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Оформлюємо...';

    try {
        const response = await fetch('/.netlify/functions/create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: cart.map(({ id, qty }) => ({ id, qty })), // ціну сервер бере сам із бази
                customer: { name, phone },
                delivery: { deliveryType, deliveryFormat, city, cityRef, warehouse, warehouseRef, paymentMethod, comment },
                attribution: window.getStoredUTM ? window.getStoredUTM() : null,
            }),
        });

        const result = await response.json();

        if (!response.ok) {
            if (response.status === 409 && Array.isArray(result.unavailable)) {
                if (errorEl) errorEl.textContent = 'На жаль, деякі товари вже розкупили. Оновіть кошик і спробуйте ще раз.';
            } else {
                if (errorEl) errorEl.textContent = result.error || 'Щось пішло не так. Спробуйте ще раз або напишіть нам напряму в Telegram/Viber.';
            }
            submitBtn.disabled = false;
            submitBtn.textContent = 'Підтвердити замовлення';
            return;
        }

        // result.items/result.total — актуальні дані з сервера (а не з локального кошика)
        if (window.trackPurchase) window.trackPurchase(result.orderID, result.items, result.total);
        showCheckoutSuccess(result.orderID, result.items, result.total, { name, phone, city, warehouse, deliveryType, deliveryFormat, paymentMethod, comment });
        localStorage.removeItem(CART_KEY);
        renderCartPanel();
    } catch (e) {
        console.error('Не вдалося оформити замовлення:', e);
        if (errorEl) errorEl.textContent = 'Щось пішло не так. Спробуйте ще раз або напишіть нам напряму в Telegram/Viber.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Підтвердити замовлення';
    }
}

const DELIVERY_TYPE_LABELS = { nova_poshta: 'Нова Пошта', ukrposhta: 'Укрпошта' };
const DELIVERY_FORMAT_LABELS = { branch: 'відділення', postomat: 'поштомат' };

function showCheckoutSuccess(orderID, items, total, details) {
    const root = document.getElementById('checkout-root');
    if (!root) return;

    const lines = items.map(item => `${item.title} (арт. ${item.id}) — ${item.qty} шт. x ${item.price} грн`).join('\n');
    const deliveryLabel = `${DELIVERY_TYPE_LABELS[details.deliveryType] || details.deliveryType}, ${DELIVERY_FORMAT_LABELS[details.deliveryFormat] || ''} ${details.warehouse}, ${details.city}`;
    const messageText = `Добрий день! Оформив(-ла) замовлення ${orderID}:\n${lines}\n\nРазом: ${total} грн.\nІм'я: ${details.name}\nТелефон: ${details.phone}\nДоставка: ${deliveryLabel}`;

    root.innerHTML = `
        <div class="checkout-success">
            <h1>Замовлення №${orderID} оформлено 💗</h1>
            <p>Ми отримали ваше замовлення та зв'яжемося з вами для підтвердження деталей.</p>
            <p>Якщо ви обрали накладений платіж, менеджер надасть реквізити для внесення передоплати 200 грн.</p>
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
            </div>
            <p>Ми зв'яжемось з вами за телефоном <strong>${escapeHTML(details.phone)}</strong> найближчим часом.</p>
            <p class="checkout-alt-channel">Хочете прискорити — напишіть нам одразу в месенджер:</p>
            <div class="not-found-buttons">
                <a href="https://t.me/solomia_ka?text=${encodeURIComponent(messageText)}" target="_blank" rel="noopener noreferrer" class="modal-btn btn-tg">Telegram</a>
                <a href="viber://chat?number=%2B380680243337" target="_blank" rel="noopener noreferrer" class="modal-btn btn-vb">Viber</a>
            </div>
            <a href="catalog.html" class="back-to-catalog" style="display:inline-block; margin-top: 25px;">← Повернутись у каталог</a>
        </div>
    `;
}

// Робимо доступним для script.js (кнопка "У кошик" на картці товару)
window.addToCart = addToCart;


document.addEventListener('DOMContentLoaded', () => {
    renderCartPanel();
    renderCheckoutSummary();
    initSegmentedControls();
    initCityAutocomplete();
    document.getElementById('checkout-form')?.addEventListener('submit', submitOrder);

    document.getElementById('cart-toggle')?.addEventListener('click', openCartPanel);
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