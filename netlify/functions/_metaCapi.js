// Серверна відправка подій у Meta Conversions API (CAPI).
// Використовується з create-order.js: Purchase йде і з браузера (піксель), і звідси,
// а Meta зливає дублі за спільним event_id = orderID.
//
// Змінні середовища Netlify:
//   META_PIXEL_ID        — ID пікселя (1064635219902420)
//   META_CAPI_TOKEN      — токен доступу (Events Manager → Settings → Conversions API → Generate access token)
//   META_GRAPH_VERSION   — необов'язково, за замовчуванням v21.0
//   META_TEST_EVENT_CODE — необов'язково, тільки на час тестів (Events Manager → Test events)
const crypto = require('crypto');

const TIMEOUT_MS = 2000;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Телефон → цифри з кодом країни без "+": 380XXXXXXXXX
function normalizePhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 12 && digits.startsWith('380')) return digits;
    if (digits.length === 11 && digits.startsWith('80')) return '3' + digits;
    if (digits.length === 10 && digits.startsWith('0')) return '38' + digits;
    if (digits.length === 9) return '380' + digits;
    return digits;
}

// "Іван Петренко" → { fn: "іван", ln: "петренко" }; одне слово → тільки fn
function splitName(raw) {
    const parts = String(raw || '')
        .toLowerCase()
        .replace(/[^\p{L}\s'’-]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);
    if (parts.length === 0) return {};
    if (parts.length === 1) return { fn: parts[0] };
    return { fn: parts[0], ln: parts[parts.length - 1] };
}

function buildUserData({ name, phone, tracking, ip, userAgent }) {
    const user = { country: [sha256('ua')] };

    const ph = normalizePhone(phone);
    if (ph) {
        user.ph = [sha256(ph)];
        user.external_id = [sha256(ph)];
    }
    const { fn, ln } = splitName(name);
    if (fn) user.fn = [sha256(fn)];
    if (ln) user.ln = [sha256(ln)];

    // fbp/fbc/ip/user-agent за вимогами Meta передаються НЕ хешованими
    if (tracking && tracking.fbp) user.fbp = tracking.fbp;
    if (tracking && tracking.fbc) user.fbc = tracking.fbc;
    if (ip) user.client_ip_address = ip;
    if (userAgent) user.client_user_agent = userAgent;
    return user;
}

// Повертає { status: 'sent' | 'failed' | 'skipped', httpStatus?, error? } і НІКОЛИ не кидає виняток
async function sendPurchase({ orderID, items, total, customer, tracking, ip, userAgent }) {
    try {
        const pixelId = process.env.META_PIXEL_ID;
        const token = process.env.META_CAPI_TOKEN;
        if (!pixelId || !token) return { status: 'skipped', error: 'no_config' };
        if (tracking && tracking.consent === 'denied') return { status: 'skipped', error: 'consent_denied' };

        const version = process.env.META_GRAPH_VERSION || 'v21.0';
        const event = {
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            event_id: orderID,
            action_source: 'website',
            event_source_url: (tracking && tracking.eventSourceUrl) || 'https://silveri.com.ua/checkout.html',
            user_data: buildUserData({ name: customer.name, phone: customer.phone, tracking, ip, userAgent }),
            custom_data: {
                currency: 'UAH',
                value: total,
                content_type: 'product',
                content_ids: items.map(i => String(i.id)),
                contents: items.map(i => ({ id: String(i.id), quantity: i.qty, item_price: i.price })),
                num_items: items.reduce((s, i) => s + i.qty, 0),
                order_id: orderID,
            },
        };

        const body = { data: [event], access_token: token };
        if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(`https://graph.facebook.com/${version}/${pixelId}/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!res.ok) return { status: 'failed', httpStatus: res.status };
            return { status: 'sent', httpStatus: res.status };
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        // Токен у повідомлення не потрапляє: логуємо лише текст помилки
        return { status: 'failed', error: String((e && e.message) || e).slice(0, 200) };
    }
}

module.exports = { sendPurchase, normalizePhone, splitName, buildUserData };
