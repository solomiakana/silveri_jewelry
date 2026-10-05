// --- Аналітика Silveri: GA4 + Meta Pixel + атрибуція + згода ---
// Підключається окремим <script> (не type="module") на кожній публічній сторінці,
// до script.js/cart.js. Працює незалежно від Firebase.
//
// Уся решта коду сайту викликає ТІЛЬКИ window.SilveriAnalytics.* і не знає
// про gtag/fbq. Будь-яка помилка тут глушиться — аналітика не може зламати продаж.

// ⚠️ ВСТАВ СВОЇ ID СЮДИ ПЕРЕД ДЕПЛОЄМ:
const GA4_MEASUREMENT_ID = 'G-XXXXXXXXXX';   // GA4 → Admin → Data Streams → Measurement ID
const META_PIXEL_ID = '1064635219902420'; 

// 'opt-out' — трекери працюють, доки відвідувач не натиснув «Відхилити»
// 'opt-in'  — трекери вантажаться тільки після «Прийняти» (для аудиторії ЄС)
const CONSENT_MODE = 'opt-out';
const ATTRIBUTION_TTL_DAYS = 30;
const CURRENCY = 'UAH';

(function () {
    'use strict';

    // Поки ID не вставлені — нічого не вантажимо (події лише логуються в debug-режимі)
    const GA_OK = /^G-[A-Z0-9]{6,}$/.test(GA4_MEASUREMENT_ID) && GA4_MEASUREMENT_ID !== 'G-XXXXXXXXXX';
    const PIXEL_OK = /^\d{10,20}$/.test(META_PIXEL_ID);

    // ---------- Безпечне сховище (Safari private / заблокований localStorage) ----------
    const memStore = {};
    const storage = {
        get(key) {
            try { return localStorage.getItem(key); } catch (e) { return memStore[key] ?? null; }
        },
        set(key, value) {
            try { localStorage.setItem(key, value); } catch (e) { memStore[key] = value; }
        },
        remove(key) {
            try { localStorage.removeItem(key); } catch (e) { delete memStore[key]; }
        },
    };
    const sessionStore = {
        get(key) {
            try { return sessionStorage.getItem(key); } catch (e) { return memStore['s:' + key] ?? null; }
        },
        set(key, value) {
            try { sessionStorage.setItem(key, value); } catch (e) { memStore['s:' + key] = value; }
        },
    };

    // --- DebugView / тестовий режим ---
    // Увімкнути вручну в консолі браузера: localStorage.setItem('silveri_debug', '1')
    // Вимкнути: localStorage.removeItem('silveri_debug')
    const DEBUG = storage.get('silveri_debug') === '1';

    function log(...args) { if (DEBUG) console.log('[analytics]', ...args); }
    function safe(fn) { try { return fn(); } catch (e) { log('error', e); } }

    // ---------- Згода ----------
    const CONSENT_KEY = 'silveri_consent';
    const LEGACY_CONSENT_KEY = 'silveri_cookie_consent'; // старий банер писав сюди 'accepted'

    // 'granted' | 'denied' | 'unset'
    function getConsent() {
        try {
            const raw = storage.get(CONSENT_KEY);
            if (raw) {
                const v = JSON.parse(raw).analytics;
                if (v === 'granted' || v === 'denied') return v;
            }
        } catch (e) { /* ігноруємо пошкоджений запис */ }
        if (storage.get(LEGACY_CONSENT_KEY) === 'accepted') return 'granted';
        return 'unset';
    }

    function trackingAllowed() {
        const c = getConsent();
        return CONSENT_MODE === 'opt-in' ? c === 'granted' : c !== 'denied';
    }

    // ---------- Завантаження GA4 / Meta ----------
    const DEFER_PAGEVIEW = window.SILVERI_DEFER_PAGEVIEW === true; // product.html: page_view після завантаження товару
    let started = false;
    let pageViewSent = false;
    let pageViewRequested = false;
    let pageViewTitle = '';

    function gtag() { window.dataLayer.push(arguments); }

    function startTrackers() {
        if (started) return;
        started = true;

        if (GA_OK) {
            safe(() => {
                window['ga-disable-' + GA4_MEASUREMENT_ID] = false;
                const s = document.createElement('script');
                s.async = true;
                s.src = `https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}`;
                document.head.appendChild(s);

                window.dataLayer = window.dataLayer || [];
                window.gtag = gtag;
                gtag('js', new Date());
                const cfg = {};
                if (DEBUG) cfg.debug_mode = true;
                if (DEFER_PAGEVIEW) cfg.send_page_view = false;
                gtag('config', GA4_MEASUREMENT_ID, cfg);
                if (!DEFER_PAGEVIEW) pageViewSent = true;
            });
        } else if (!DEFER_PAGEVIEW) {
            pageViewSent = true;
        }

        if (PIXEL_OK) {
            safe(() => {
                !(function (f, b, e, v, n, t, s) {
                    if (f.fbq) return;
                    n = f.fbq = function () {
                        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
                    };
                    if (!f._fbq) f._fbq = n;
                    n.push = n; n.loaded = true; n.version = '2.0';
                    n.queue = [];
                    t = b.createElement(e); t.async = true;
                    t.src = v;
                    s = b.getElementsByTagName(e)[0];
                    s.parentNode.insertBefore(t, s);
                })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
                fbq('init', META_PIXEL_ID);
                fbq('track', 'PageView');
            });
        }

        if (DEFER_PAGEVIEW) {
            // Запасний варіант: якщо товар не завантажився — page_view все одно піде
            setTimeout(() => { pageViewRequested = true; flushPageView(); }, 3000);
            flushPageView();
        }
    }

    function flushPageView() {
        if (pageViewSent || !pageViewRequested || !started) return;
        pageViewSent = true;
        emitGA('page_view', { page_title: pageViewTitle || document.title, page_location: location.href });
    }

    // ---------- Низькорівневі відправники ----------
    function emitGA(name, params) {
        log('GA4', name, params);
        if (!GA_OK || !started || !trackingAllowed()) return;
        safe(() => gtag('event', name, params));
    }

    function emitMeta(name, params, options) {
        log('Meta', name, params, options || '');
        if (!PIXEL_OK || !started || !trackingAllowed()) return;
        safe(() => options ? fbq('track', name, params, options) : fbq('track', name, params));
    }

    // Захист від дублів у межах одного завантаження сторінки
    const fired = new Set();
    function once(key) {
        if (fired.has(key)) return false;
        fired.add(key);
        return true;
    }

    // ---------- Нормалізація товарів ----------
    // Вхід: { id, title, price, qty?, category? } — і з Firestore, і з кошика, і з відповіді сервера
    function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

    function gaItem(p, index) {
        const item = {
            item_id: String(p.id),
            item_name: p.title || String(p.id),
            price: num(p.price),
            quantity: p.qty > 0 ? p.qty : 1,
        };
        if (p.category) item.item_category = p.category;
        if (index !== undefined) item.index = index;
        return item;
    }

    function metaContent(p) {
        return { id: String(p.id), quantity: p.qty > 0 ? p.qty : 1, item_price: num(p.price) };
    }

    function sumValue(products) {
        return products.reduce((s, p) => s + num(p.price) * (p.qty > 0 ? p.qty : 1), 0);
    }

    function countQty(products) {
        return products.reduce((s, p) => s + (p.qty > 0 ? p.qty : 1), 0);
    }

    // Спільний набір параметрів Meta для подій з кошиком/чекаутом
    function metaCartParams(products) {
        return {
            content_type: 'product',
            content_ids: products.map(p => String(p.id)),
            contents: products.map(metaContent),
            num_items: countQty(products),
            value: sumValue(products),
            currency: CURRENCY,
        };
    }

    // ---------- Атрибуція (UTM / fbclid / gclid) ----------
    const ATTR_KEY = 'silveri_attr';
    const LEGACY_ATTR_KEY = 'silveri_utm';
    const UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    const DAY_MS = 24 * 60 * 60 * 1000;

    function captureAttribution() {
        safe(() => {
            const params = new URLSearchParams(location.search);
            const hasAny = UTM_PARAMS.some(p => params.has(p)) || params.has('fbclid') || params.has('gclid');
            if (!hasAny) return;

            const attr = {};
            UTM_PARAMS.forEach(p => { if (params.has(p)) attr[p] = params.get(p); });
            if (params.has('gclid')) attr.gclid = params.get('gclid');
            if (params.has('fbclid')) attr.fbclid = params.get('fbclid');
            attr.landingPage = location.pathname;
            const now = Date.now();
            attr.capturedAt = new Date(now).toISOString();
            attr.expiresAt = new Date(now + ATTRIBUTION_TTL_DAYS * DAY_MS).toISOString();
            storage.set(ATTR_KEY, JSON.stringify(attr));
        });
    }

    function readAttribution() {
        try {
            const raw = storage.get(ATTR_KEY) || storage.get(LEGACY_ATTR_KEY);
            if (!raw) return null;
            const attr = JSON.parse(raw);
            // Старі записи (без expiresAt) живуть TTL від моменту захоплення
            const expires = attr.expiresAt
                ? Date.parse(attr.expiresAt)
                : Date.parse(attr.capturedAt) + ATTRIBUTION_TTL_DAYS * DAY_MS;
            if (!Number.isFinite(expires) || expires < Date.now()) {
                storage.remove(ATTR_KEY);
                storage.remove(LEGACY_ATTR_KEY);
                return null;
            }
            return attr;
        } catch (e) {
            return null;
        }
    }

    function readCookie(name) {
        const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
    }

    // Контекст для сервера (create-order → Meta Conversions API)
    function getTrackingContext() {
        return new Promise((resolve) => {
            const attr = readAttribution();
            const ctx = {
                consent: getConsent(),
                eventSourceUrl: location.href,
                clientUserAgent: navigator.userAgent,
            };
            if (trackingAllowed()) {
                ctx.fbp = readCookie('_fbp');
                // _fbc ставить піксель; якщо його ще нема, а fbclid зберігся — будуємо за форматом Meta
                ctx.fbc = readCookie('_fbc') ||
                    (attr && attr.fbclid ? `fb.1.${Date.parse(attr.capturedAt) || Date.now()}.${attr.fbclid}` : '');
            }

            if (!(GA_OK && started && trackingAllowed() && typeof window.gtag === 'function')) {
                resolve(ctx);
                return;
            }
            // client_id/session_id асинхронні; не чекаємо довше 500 мс
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(ctx); } };
            setTimeout(finish, 500);
            safe(() => {
                gtag('get', GA4_MEASUREMENT_ID, 'client_id', (v) => { ctx.gaClientId = v; });
                gtag('get', GA4_MEASUREMENT_ID, 'session_id', (v) => { ctx.gaSessionId = String(v); finish(); });
            });
        });
    }

    // ---------- Публічні події ----------
    const A = {};

    // page_view для сторінок, де заголовок відомий пізніше (product.html)
    A.pageView = function ({ title } = {}) {
        safe(() => {
            pageViewRequested = true;
            if (title) pageViewTitle = title;
            flushPageView();
        });
    };

    A.viewItem = function (product) {
        safe(() => {
            if (!product || !product.id || !once('view_item:' + product.id)) return;
            const p = { ...product, qty: 1 };
            emitGA('view_item', { currency: CURRENCY, value: num(p.price), items: [gaItem(p)] });
            emitMeta('ViewContent', {
                content_type: 'product',
                content_ids: [String(p.id)],
                content_name: p.title,
                content_category: p.category || '',
                contents: [metaContent(p)],
                value: num(p.price),
                currency: CURRENCY,
            });
        });
    };

    // onSnapshot перемальовує каталог при кожній зміні бази — шлемо подію лише коли змінився видимий список
    const lastListSignature = {};
    A.viewItemList = function (listId, listName, products) {
        safe(() => {
            if (!Array.isArray(products) || products.length === 0) return;
            const signature = listName + '|' + products.map(p => p.id).join(',');
            if (lastListSignature[listId] === signature) return;
            lastListSignature[listId] = signature;
            emitGA('view_item_list', {
                item_list_id: listId,
                item_list_name: listName,
                items: products.map((p, i) => gaItem({ ...p, qty: 1 }, i)),
            });
        });
    };

    A.addToCart = function (item, qty = 1) {
        safe(() => {
            if (!item || !item.id) return;
            const p = { ...item, qty };
            emitGA('add_to_cart', { currency: CURRENCY, value: sumValue([p]), items: [gaItem(p)] });
            emitMeta('AddToCart', {
                content_type: 'product',
                content_ids: [String(p.id)],
                content_name: p.title,
                content_category: p.category || '',
                contents: [metaContent(p)],
                value: sumValue([p]),
                currency: CURRENCY,
            });
        });
    };

    A.removeFromCart = function (item, qty = 1) {
        safe(() => {
            if (!item || !item.id) return;
            const p = { ...item, qty };
            emitGA('remove_from_cart', { currency: CURRENCY, value: sumValue([p]), items: [gaItem(p)] });
        });
    };

    A.viewCart = function (cart) {
        safe(() => {
            if (!Array.isArray(cart) || cart.length === 0) return;
            emitGA('view_cart', { currency: CURRENCY, value: sumValue(cart), items: cart.map((p, i) => gaItem(p, i)) });
        });
    };

    A.beginCheckout = function (cart) {
        safe(() => {
            if (!Array.isArray(cart) || cart.length === 0 || !once('begin_checkout')) return;
            emitGA('begin_checkout', { currency: CURRENCY, value: sumValue(cart), items: cart.map((p, i) => gaItem(p, i)) });
            emitMeta('InitiateCheckout', metaCartParams(cart));
        });
    };

    // info: { deliveryType, deliveryFormat, paymentMethod }
    A.addShipping = function (cart, info = {}) {
        safe(() => {
            if (!Array.isArray(cart) || cart.length === 0 || !once('add_shipping_info')) return;
            emitGA('add_shipping_info', {
                currency: CURRENCY,
                value: sumValue(cart),
                shipping_tier: [info.deliveryType, info.deliveryFormat].filter(Boolean).join('_'),
                items: cart.map((p, i) => gaItem(p, i)),
            });
        });
    };

    A.addPayment = function (cart, info = {}) {
        safe(() => {
            if (!Array.isArray(cart) || cart.length === 0 || !once('add_payment_info')) return;
            emitGA('add_payment_info', {
                currency: CURRENCY,
                value: sumValue(cart),
                payment_type: info.paymentMethod || '',
                items: cart.map((p, i) => gaItem(p, i)),
            });
            emitMeta('AddPaymentInfo', metaCartParams(cart));
        });
    };

    // order: { orderID, items, total } — дані З СЕРВЕРА
    A.purchase = function (order) {
        safe(() => {
            if (!order || !order.orderID) return;
            // Один раз на замовлення, навіть якщо функцію викличуть повторно
            const key = 'silveri_purchased:' + order.orderID;
            if (sessionStore.get(key)) return;
            sessionStore.set(key, '1');

            const items = order.items || [];
            const value = num(order.total) || sumValue(items);
            emitGA('purchase', {
                transaction_id: order.orderID,
                value,
                currency: CURRENCY,
                items: items.map((p, i) => gaItem(p, i)),
            });
            // eventID = orderID: за ним Meta зіставляє браузерну подію з серверною (CAPI)
            emitMeta('Purchase', { ...metaCartParams(items), value, order_id: order.orderID }, { eventID: order.orderID });
        });
    };

    // reason: validation | unavailable | rate_limited | server_error | network_error
    A.checkoutError = function (reason) {
        safe(() => emitGA('checkout_error', { reason: String(reason || 'unknown') }));
    };

    // ---------- Згода: публічний API ----------
    A.getConsent = getConsent;
    A.setConsent = function (value) {
        safe(() => {
            const v = value === 'granted' ? 'granted' : 'denied';
            storage.set(CONSENT_KEY, JSON.stringify({ analytics: v, ts: new Date().toISOString() }));
            if (v === 'granted') storage.set(LEGACY_CONSENT_KEY, 'accepted');
            else storage.remove(LEGACY_CONSENT_KEY);

            if (v === 'granted') {
                if (!started) startTrackers();
                if (GA_OK) window['ga-disable-' + GA4_MEASUREMENT_ID] = false;
                if (PIXEL_OK && typeof window.fbq === 'function') safe(() => fbq('consent', 'grant'));
            } else {
                if (GA_OK) window['ga-disable-' + GA4_MEASUREMENT_ID] = true;
                if (PIXEL_OK && typeof window.fbq === 'function') safe(() => fbq('consent', 'revoke'));
            }
            log('consent', v);
        });
    };

    A.getTrackingContext = getTrackingContext;
    A.getAttribution = readAttribution;

    window.SilveriAnalytics = A;

    // Сумісність зі старим кодом
    window.getStoredUTM = readAttribution;
    window.trackPurchase = function (orderID, items, total) { A.purchase({ orderID, items, total }); };

    // ---------- Клік Telegram/Viber: один делегований listener на весь сайт ----------
    function contactLocation(el) {
        if (el.closest('.checkout-success')) return 'success';
        if (el.closest('#order-modal')) return 'modal';
        if (el.closest('header')) return 'header';
        if (el.closest('footer')) return 'footer';
        if (el.closest('#product-page-root')) return 'product';
        if (el.closest('#contacts')) return 'contacts';
        return 'page';
    }

    document.addEventListener('click', (e) => {
        safe(() => {
            const link = e.target.closest && e.target.closest('a[href]');
            if (!link) return;
            const href = link.getAttribute('href') || '';
            let method = null;
            if (href.startsWith('https://t.me/') || href.startsWith('http://t.me/')) method = 'telegram';
            else if (href.startsWith('viber:')) method = 'viber';
            if (!method) return;

            // page_location не передаємо: GA4 підставляє повний URL сам
            emitGA('contact_click', { method, link_location: contactLocation(link) });
            emitMeta('Contact', { content_name: method });
        });
    }, true);

    // ---------- Старт ----------
    captureAttribution();
    if (trackingAllowed()) startTrackers();
    else log('трекери не запущені: немає згоди (' + CONSENT_MODE + ')');
    if (!GA_OK) log('GA4: ID не вказано — події не відправляються');
    if (!PIXEL_OK) log('Meta Pixel: ID не вказано — події не відправляються');
})();
