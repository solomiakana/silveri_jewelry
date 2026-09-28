// POST /.netlify/functions/create-order
// Приймає від клієнта ТІЛЬКИ id товару + кількість (без ціни!) та дані
// покупця/доставки. Ціну, назву й фото бере з Firestore (джерело правди),
// тож підмінити суму замовлення через DevTools більше не можна.
const crypto = require('crypto');
const { getDb } = require('./_firebaseAdmin');
const admin = require('firebase-admin');
const { sendPurchase } = require('./_metaCapi');

const MAX_ITEMS = 30;
const MAX_QTY_PER_ITEM = 20;
const MAX_TEXT_LEN = 300;

// Випадковий ID виду "SIL-K7M2QX". Алфавіт без схожих символів (0/O, 1/I/L).
// Раніше це були останні 6 цифр Date.now(), які повторюються кожні ~16 хв —
// колізія тихо перезаписувала б чуже замовлення й "з'їдала" purchase у GA4.
const ORDER_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateOrderId() {
    const bytes = crypto.randomBytes(6);
    let id = '';
    for (let i = 0; i < 6; i++) id += ORDER_ID_ALPHABET[bytes[i] % ORDER_ID_ALPHABET.length];
    return 'SIL-' + id;
}

const isAlreadyExists = (e) => e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS/.test(String(e.message)));

function cleanText(value, maxLen = MAX_TEXT_LEN) {
    return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Метод не підтримується.' }) };
    }

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Некоректний запит.' }) };
    }

    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const customer = payload.customer || {};
    const delivery = payload.delivery || {};
    const attribution = payload.attribution || {};
    const clientTracking = payload.tracking || {};

    // --- Базова валідація ---
    if (rawItems.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Кошик порожній.' }) };
    }
    if (rawItems.length > MAX_ITEMS) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Забагато позицій у замовленні.' }) };
    }

    const name = cleanText(customer.name, 100);
    const phone = cleanText(customer.phone, 30);
    const city = cleanText(delivery.city, 100);
    const cityRef = cleanText(delivery.cityRef, 100);
    const warehouse = cleanText(delivery.warehouse, 150);
    const warehouseRef = cleanText(delivery.warehouseRef, 100);
    const deliveryType = cleanText(delivery.deliveryType, 30) || 'nova_poshta';
    const deliveryFormat = cleanText(delivery.deliveryFormat, 30) || 'branch';
    const paymentMethod = cleanText(delivery.paymentMethod, 30) || 'cod';
    const comment = cleanText(delivery.comment, 500);

    // UTM/кліки з реклами — не обов'язкові, просто для власної статистики
    const utm = {
        utm_source: cleanText(attribution.utm_source, 100),
        utm_medium: cleanText(attribution.utm_medium, 100),
        utm_campaign: cleanText(attribution.utm_campaign, 100),
        utm_term: cleanText(attribution.utm_term, 100),
        utm_content: cleanText(attribution.utm_content, 100),
        gclid: cleanText(attribution.gclid, 150),
        fbclid: cleanText(attribution.fbclid, 150),
        landingPage: cleanText(attribution.landingPage, 200),
    };
    // Прибираємо порожні поля, щоб не засмічувати документ
    Object.keys(utm).forEach(k => { if (!utm[k]) delete utm[k]; });

    // Контекст для аналітики (Meta CAPI). IP не зберігаємо — він потрібен лише для відправки в Meta.
    const headers = event.headers || {};
    const clientIp = headers['x-nf-client-connection-ip'] ||
        String(headers['x-forwarded-for'] || '').split(',')[0].trim() || '';
    const userAgent = cleanText(headers['user-agent'], 300) || cleanText(clientTracking.clientUserAgent, 300);
    const tracking = {
        fbp: cleanText(clientTracking.fbp, 150),
        fbc: cleanText(clientTracking.fbc, 250),
        consent: ['granted', 'denied'].includes(clientTracking.consent) ? clientTracking.consent : 'unset',
        eventSourceUrl: /^https?:\/\//.test(clientTracking.eventSourceUrl || '') ? cleanText(clientTracking.eventSourceUrl, 300) : '',
        gaClientId: cleanText(clientTracking.gaClientId, 100),
        gaSessionId: cleanText(clientTracking.gaSessionId, 100),
        clientUserAgent: userAgent,
    };
    Object.keys(tracking).forEach(k => { if (!tracking[k]) delete tracking[k]; });

    if (!name || !phone || !city || !cityRef || !warehouse) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Заповніть усі обов’язкові поля.' }) };
    }

    // Прибираємо дублікати id в кошику, підсумовуючи кількість
    const wanted = new Map();
    for (const raw of rawItems) {
        const id = cleanText(raw?.id, 50);
        const qty = Math.floor(Number(raw?.qty));
        if (!id || !Number.isFinite(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
            return { statusCode: 400, body: JSON.stringify({ error: `Некоректна кількість для товару ${id || '?'}.` }) };
        }
        wanted.set(id, (wanted.get(id) || 0) + qty);
    }

    try {
        const db = getDb();

        // --- Базовий анти-спам: не більше 3 замовлень з одного номера за 10 хв ---
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
        const recentByPhone = await db.collection('orders')
            .where('customerPhone', '==', phone)
            .where('createdAt', '>=', tenMinAgo)
            .limit(4)
            .get();
        if (recentByPhone.size >= 3) {
            return {
                statusCode: 429,
                body: JSON.stringify({ error: 'Забагато замовлень поспіль з цього номера. Спробуйте за кілька хвилин або напишіть нам напряму.' }),
            };
        }

        // --- Джерело правди: реальні дані товарів з Firestore ---
        const items = [];
        const unavailable = [];

        for (const [id, qty] of wanted.entries()) {
            const snap = await db.collection('products').where('id', '==', id).limit(1).get();
            if (snap.empty) {
                unavailable.push(id);
                continue;
            }
            const product = snap.docs[0].data();
            if (product.inStock === false) {
                unavailable.push(id);
                continue;
            }
            items.push({
                id,
                title: product.title || id,
                price: Number(product.price) || 0,
                image: product.image || '',
                qty,
            });
        }

        if (unavailable.length > 0) {
            return {
                statusCode: 409,
                body: JSON.stringify({
                    error: 'Деякі товари вже недоступні, оновіть кошик.',
                    unavailable,
                }),
            };
        }

        const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);

        const orderData = {
            items,
            total,
            customerName: name,
            customerPhone: phone,
            deliveryType,
            deliveryFormat,
            city,
            cityRef,
            warehouse,
            warehouseRef,
            paymentMethod,
            paymentStatus: 'pending',
            orderStatus: 'new',
            comment,
            utm,
            tracking,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // create() (а не set()) — не дозволяє перезаписати існуюче замовлення; при колізії ID беремо новий
        let orderID = null;
        let orderRef = null;
        for (let attempt = 0; attempt < 5 && !orderRef; attempt++) {
            const candidate = generateOrderId();
            const ref = db.collection('orders').doc(candidate);
            try {
                await ref.create({ orderID: candidate, ...orderData });
                orderID = candidate;
                orderRef = ref;
            } catch (e) {
                if (!isAlreadyExists(e)) throw e;
            }
        }
        if (!orderRef) throw new Error('Не вдалося згенерувати унікальний ID замовлення');

        // Серверна подія Purchase у Meta (дедуплікація з пікселем за event_id = orderID).
        // Ніколи не ламає замовлення: sendPurchase не кидає винятків, а запис результату — best effort.
        const capi = await sendPurchase({
            orderID, items, total,
            customer: { name, phone },
            tracking, ip: clientIp, userAgent,
        });
        try {
            await orderRef.update({ 'tracking.capi': { ...capi, sentAt: admin.firestore.Timestamp.now() } });
        } catch (e) {
            console.error('create-order: не вдалося записати статус CAPI:', e.message);
        }


        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderID, items, total }),
        };
    } catch (e) {
        console.error('create-order error:', e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Не вдалося оформити замовлення. Спробуйте ще раз.' }) };
    }
};
