// --- Аналітика: GA4 + Meta Pixel + UTM + події ---
// Підключається окремим <script> (не type="module") на кожній публічній сторінці,
// до script.js/cart.js. Працює незалежно від Firebase.

// ⚠️ ВСТАВ СВОЇ ID СЮДИ ПЕРЕД ДЕПЛОЄМ:
const GA4_MEASUREMENT_ID = 'G-XXXXXXXXXX';   // GA4 → Admin → Data Streams → Measurement ID
const META_PIXEL_ID = '_PIXEL_ID';       // Meta Events Manager → Pixel → код ініціалізації

(function () {
    // --- DebugView / тестовий режим ---
    // Увімкнути вручну в консолі браузера: localStorage.setItem('silveri_debug', '1')
    // Вимкнути: localStorage.removeItem('silveri_debug')
    const DEBUG = localStorage.getItem('silveri_debug') === '1';

    // --- GA4 (gtag.js) ---
    const gaScript = document.createElement('script');
    gaScript.async = true;
    gaScript.src = `https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}`;
    document.head.appendChild(gaScript);

    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag('js', new Date());
    gtag('config', GA4_MEASUREMENT_ID, DEBUG ? { debug_mode: true } : {});

    // --- Meta Pixel ---
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

    // --- UTM: захоплюємо з URL і зберігаємо (last-click, живе поки не прийде нова мітка) ---
    const UTM_KEY = 'silveri_utm';
    const UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    const params = new URLSearchParams(location.search);
    const hasUtm = UTM_PARAMS.some(p => params.has(p));
    if (hasUtm) {
        const utm = {};
        UTM_PARAMS.forEach(p => { if (params.has(p)) utm[p] = params.get(p); });
        if (params.has('gclid')) utm.gclid = params.get('gclid');
        if (params.has('fbclid')) utm.fbclid = params.get('fbclid');
        utm.landingPage = location.pathname;
        utm.capturedAt = new Date().toISOString();
        localStorage.setItem(UTM_KEY, JSON.stringify(utm));
    }

    window.getStoredUTM = function () {
        try {
            const raw = localStorage.getItem(UTM_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    };

    // --- Telegram/Viber кліки: один делегований listener на весь сайт,
    // ловить будь-яке посилання t.me/ або viber:, де б воно не було на сторінці ---
    document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href]');
        if (!link) return;
        const href = link.getAttribute('href') || '';
        let method = null;
        if (href.includes('t.me/')) method = 'telegram';
        else if (href.startsWith('viber:')) method = 'viber';
        if (!method) return;

        gtag('event', 'contact_click', {
            method,
            page_location: location.pathname,
        });
        fbq('track', 'Contact', { content_name: method });

        if (DEBUG) console.log('[analytics] contact_click', method, href);
    }, true);

    // --- Purchase: викликається з cart.js після успішного створення замовлення ---
    window.trackPurchase = function (orderID, items, total, currency = 'UAH') {
        gtag('event', 'purchase', {
            transaction_id: orderID,
            value: total,
            currency,
            items: items.map(i => ({
                item_id: i.id,
                item_name: i.title,
                price: i.price,
                quantity: i.qty,
            })),
        });

        fbq('track', 'Purchase', {
            value: total,
            currency,
            content_type: 'product',
            content_ids: items.map(i => i.id),
            contents: items.map(i => ({ id: i.id, quantity: i.qty })),
        });

        if (DEBUG) console.log('[analytics] purchase', orderID, total, items);
    };
})();
