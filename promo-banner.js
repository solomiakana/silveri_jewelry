// Рекламний банер-модалка (акція на один товар).
// Підключається <script type="module"> на головній, каталозі, FAQ і сторінці товару, ПІСЛЯ cart.js.
// Уся логіка рішень — у promo-logic.mjs (там же тести). Тут лише браузерна обв'язка:
// таймер, перевірка перешкод, рендер, події.
//
// Як це працює:
//   1. Через DELAY_MS після завантаження КОЖНОЇ сторінки (таймер на сторінку, не на сесію)
//      робиться спроба показу.
//   2. Банер показується не частіше ніж раз на 24 години (від моменту показу, localStorage).
//   3. Якщо в цю мить на екрані cookie-банер, відкрите вікно/кошик чи людина друкує —
//      показ відкладається і повторюється щосекунди (до GIVE_UP_MS), поки перешкода не зникне.
//   4. Увесь модуль «тихий»: будь-яка помилка лише в консоль, сайт це не ламає.
//
// Налагодження: localStorage.setItem('silveri_debug','1') — у консолі видно причини відмови.
// Показати ще раз під час тестів: localStorage.removeItem('silveri_promo_last_shown:' + <id кампанії>).

import {
    DAY_MS, parseLastShown, isCooldownOver, isCampaignActive, isPageEligible, getBlocker, evaluateShow,
} from './promo-logic.mjs';

// ---------- Конфіг кампанії ----------
// Нова акція = новий id (старі відмітки «вже показували» перестають діяти) + нова картинка/товар.
const CAMPAIGN = {
    id: 'pave-2026-10',
    enabled: true,
    productId: '124',                 // артикул товару в каталозі
    expectedPrice: 1400,              // ціна, вшита в картинку; якщо в каталозі інша — банер не показується
    image: 'img/promo/pave-bracelet.webp',
    imageWidth: 928,
    imageHeight: 1289,
    delayMs: 10_000,                  // через скільки після завантаження сторінки пробуємо показати
    cooldownMs: DAY_MS,               // не частіше ніж раз на 24 години
    startsAt: null,                   // напр. '2026-10-21T00:00:00+03:00'
    endsAt: null,                     // напр. '2026-10-31T23:59:59+03:00'
};

const LAST_SHOWN_KEY = 'silveri_promo_last_shown:' + CAMPAIGN.id;
const CART_KEY = 'silveri_cart';
const POLL_MS = 1000;
const GIVE_UP_MS = 120_000;           // скільки максимум чекаємо, поки зникне перешкода
const PREFETCH_LEAD_MS = 3000;        // картинку й каталог підтягуємо за кілька секунд до показу

const DEBUG = (() => { try { return localStorage.getItem('silveri_debug') === '1'; } catch { return false; } })();
const log = (...a) => { if (DEBUG) console.log('[promo]', ...a); };

function track(fn) {
    try { if (window.SilveriAnalytics) fn(window.SilveriAnalytics); } catch (e) { log('analytics', e); }
}

// ---------- Сховище ----------
// Якщо localStorage недоступний (приватний режим, заблоковані дані), банер не показуємо взагалі:
// без пам'яті «вже показували» він би з'являвся на кожній сторінці.
function storageWorks() {
    try {
        const k = '__silveri_promo_probe__';
        localStorage.setItem(k, '1');
        localStorage.removeItem(k);
        return true;
    } catch { return false; }
}
function readLastShown() {
    try { return parseLastShown(localStorage.getItem(LAST_SHOWN_KEY)); } catch { return null; }
}
function writeLastShown(ts) {
    try { localStorage.setItem(LAST_SHOWN_KEY, String(ts)); } catch { /* перевірено storageWorks */ }
}
function isInCart(id) {
    try {
        const cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
        return Array.isArray(cart) && cart.some(p => String(p.id) === String(id));
    } catch { return false; }
}

// ---------- Каталог ----------
// Переважно через спільний loadCatalog зі script.js (один запит і спільний кеш на сторінку);
// якщо script.js не завантажився — прямий запит до /api/catalog.
async function loadProduct() {
    let data;
    if (window.SilveriCatalog && typeof window.SilveriCatalog.load === 'function') {
        data = await window.SilveriCatalog.load();
    } else {
        const res = await fetch('/api/catalog', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('catalog HTTP ' + res.status);
        data = await res.json();
    }
    const products = Array.isArray(data && data.products) ? data.products : [];
    return products.find(p => String(p.id) === String(CAMPAIGN.productId)) || null;
}

// ---------- Перешкоди ----------
function readBlockerState() {
    const el = document.activeElement;
    const typing = !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
    const modalOverlay = document.querySelector('.modal-overlay');
    const redirectOverlay = document.querySelector('.payment-redirect-overlay:not([hidden])');
    return {
        tabVisible: document.visibilityState === 'visible',
        cookieBannerVisible: !!document.querySelector('.cookie-banner.show'),
        cartOpen: !!document.querySelector('#cart-panel.open'),
        otherModalOpen: !!redirectOverlay || !!document.querySelector('.promo-overlay') ||
            (!!modalOverlay && getComputedStyle(modalOverlay).display !== 'none'),
        typingInField: typing,
    };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Показ ----------
function productUrl(id) {
    return `product.html?id=${encodeURIComponent(id)}`; // так само, як у каталозі (script.js)
}

function promoInfo(slot) {
    return { id: CAMPAIGN.id, name: 'Акція: ' + CAMPAIGN.productId, creative: CAMPAIGN.image, slot };
}

function showBanner(product) {
    const url = productUrl(product.id);
    const trackItem = { id: product.id, title: product.title, price: Number(product.price), category: (product.category || '').toLowerCase() };
    const previouslyFocused = document.activeElement;

    const overlay = document.createElement('div');
    overlay.className = 'promo-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'promo-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1; // фокус при відкритті — на модалці, без видимої рамки на кнопці
    dialog.setAttribute('aria-label', `Акція: ${product.title}, ${product.price} грн`);
    dialog.style.setProperty('--promo-ratio', `${CAMPAIGN.imageWidth} / ${CAMPAIGN.imageHeight}`);

    const link = document.createElement('a');
    link.className = 'promo-modal__link';
    link.href = url;
    link.setAttribute('aria-label', `Переглянути товар: ${product.title}`);
    const img = document.createElement('img');
    img.className = 'promo-modal__img';
    img.src = CAMPAIGN.image;
    img.width = CAMPAIGN.imageWidth;
    img.height = CAMPAIGN.imageHeight;
    img.alt = `${product.title} — ${product.price} грн`;
    img.decoding = 'async';
    link.appendChild(img);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'promo-modal__close';
    closeBtn.setAttribute('aria-label', 'Закрити');
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'promo-modal__cta';
    cta.textContent = 'Додати в кошик';

    dialog.append(link, closeBtn, cta);
    overlay.appendChild(dialog);

    let closed = false;
    const prevOverflow = document.body.style.overflow;

    function close(method, { restoreFocus = true } = {}) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKeydown, true);
        overlay.classList.remove('show');
        document.body.style.overflow = prevOverflow;
        if (method) track(a => a.promotion('dismiss', promoInfo(method)));
        setTimeout(() => overlay.remove(), 250);
        if (restoreFocus && previouslyFocused && typeof previouslyFocused.focus === 'function' && document.contains(previouslyFocused)) {
            try { previouslyFocused.focus(); } catch { /* елемент міг зникнути */ }
        }
    }

    function onKeydown(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            close('escape');
            return;
        }
        if (e.key !== 'Tab') return;
        // Проста пастка фокуса: Tab ходить по колу серед трьох елементів модалки
        const focusables = [link, cta, closeBtn];
        const idx = focusables.indexOf(document.activeElement);
        e.preventDefault();
        const next = e.shiftKey ? (idx <= 0 ? focusables.length - 1 : idx - 1) : (idx + 1) % focusables.length;
        focusables[next].focus();
    }

    closeBtn.addEventListener('click', () => close('close_button'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close('overlay'); });

    // Клік по картинці — звичайний перехід на сторінку товару (посилання), лише фіксуємо подію
    link.addEventListener('click', () => {
        track(a => a.promotion('select', promoInfo('banner_image'), trackItem));
    });

    cta.addEventListener('click', () => {
        track(a => a.promotion('select', promoInfo('add_to_cart'), trackItem));
        if (typeof window.addToCart === 'function') {
            window.addToCart({
                id: String(product.id),
                title: product.title,
                price: Number(product.price),
                image: product.image || CAMPAIGN.image,
                category: (product.category || '').toLowerCase(),
            });
            close(null, { restoreFocus: false }); // addToCart сам відкриває панель кошика
        } else {
            window.location.href = url;            // cart.js не завантажився — хоча б ведемо на товар
        }
    });

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeydown, true);
    requestAnimationFrame(() => {
        overlay.classList.add('show');
        dialog.focus({ preventScroll: true });
    });

    track(a => a.promotion('view', promoInfo('banner'), trackItem));
}

// ---------- Планувальник ----------
let started = false;

async function run() {
    if (started) return;
    started = true;

    if (!isPageEligible(location.pathname, location.search, CAMPAIGN.productId)) { log('сторінка не підходить'); return; }
    if (!storageWorks()) { log('localStorage недоступний — не показуємо'); return; }
    // Швидка перевірка без мережі: якщо кампанія вимкнена або cooldown ще триває — навіть таймер не ставимо
    if (!isCampaignActive(CAMPAIGN, Date.now())) { log('кампанія неактивна'); return; }
    if (!isCooldownOver(readLastShown(), Date.now(), CAMPAIGN.cooldownMs)) { log('cooldown'); return; }

    const startedAt = Date.now();

    // Підготовка трохи заздалегідь: каталог + картинка, щоб модалка з'явилась одразу й без мигання
    const prepare = (async () => {
        await sleep(Math.max(0, CAMPAIGN.delayMs - PREFETCH_LEAD_MS));
        const product = await loadProduct();
        if (product) {
            await new Promise((resolve) => {
                const pre = new Image();
                pre.onload = pre.onerror = resolve;
                pre.src = CAMPAIGN.image;
            });
        }
        return product;
    })();

    prepare.catch(() => {}); // помилку обробимо нижче; тут лише гасимо «unhandled rejection»
    await sleep(Math.max(0, CAMPAIGN.delayMs - (Date.now() - startedAt)));

    let product;
    try { product = await prepare; } catch (e) { log('каталог недоступний', e); return; }

    // Чекаємо, поки зникнуть тимчасові перешкоди (cookie-банер, кошик, друк у полі, прихована вкладка)
    const deadline = Date.now() + GIVE_UP_MS;
    let blocker;
    while ((blocker = getBlocker(readBlockerState())) !== null) {
        if (Date.now() > deadline) { log('перешкода не зникла:', blocker); return; }
        log('відкладено через', blocker);
        await sleep(POLL_MS);
    }

    // Остаточна перевірка ПЕРЕД показом: lastShownAt перечитуємо заново (могла відкритись інша
    // вкладка й уже показати банер), кошик теж міг змінитись, поки ми чекали.
    const decision = evaluateShow({
        now: Date.now(),
        campaign: CAMPAIGN,
        lastShownAt: readLastShown(),
        product,
        inCart: isInCart(CAMPAIGN.productId),
    });
    log('рішення:', decision);
    if (!decision.show) return;

    writeLastShown(Date.now()); // фіксуємо показ одразу: оновлення сторінки не покаже банер повторно
    showBanner(product);
}

function init() {
    run().catch(e => log('помилка', e));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
