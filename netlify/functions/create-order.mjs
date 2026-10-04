// POST /.netlify/functions/create-order
// Приймає від клієнта ТІЛЬКИ id товару + кількість (без ціни!) та дані
// покупця/доставки. Ціну, назву й фото бере з Firestore (джерело правди),
// тож підмінити суму замовлення через DevTools більше не можна.
//
// Спосіб оплати приймається лише зі списку (online | cod | fop), суми
// (totalKop, onlineAmountKop, dueOnDeliveryKop) рахує сервер, а не клієнт.
// Для online/cod замовлення стартує в orderStatus "awaiting_payment" і
// повертає клієнту statusToken — саме він (а не сам orderID) дає право
// створити інвойс і читати статус оплати (create-payment.mjs,
// check-payment-status.mjs). Файл написаний як ESM (.mjs), щоб напряму
// імпортувати спільні бібліотеки з netlify/lib/ без дублювання логіки;
// формат функції — v2 (Web Request/Response), як і в create-payment.mjs: це дає
// config.rateLimit (ліміт по IP) нижче.
//
// Захист від спаму/ботів (функція публічна й пише в базу):
//  1. rate limit по IP (config нижче) + ліміт по номеру телефону в самій функції;
//  2. Origin обов'язковий і має збігатися з SITE_URL (браузер завжди його шле);
//  3. токен App Check (X-Firebase-AppCheck) — підтверджує, що запит із нашого сайту;
//     APP_CHECK_ENFORCE=false вимикає відмову (аварійний перемикач, запит лише логується);
//  4. серверна CAPI-подія Purchase для fop НЕ шлеться при створенні замовлення (див. нижче).
import firebaseAdminPkg from './_firebaseAdmin.js';
import adminPkg from 'firebase-admin';
import metaCapiPkg from './_metaCapi.js';
import { generateOrderId, generateStatusToken, hashToken } from '../lib/tokens.mjs';
import { isCodAllowed, onlineAmountKop, prepaymentKopFromEnv } from '../lib/money.mjs';
import { buildTrackingContext } from '../lib/capi-tracking.mjs';
import { PAYMENT_METHODS, ORDER_STATUS_AWAITING_PAYMENT, ORDER_STATUS_NEW, PAYMENT_STATUS } from '../lib/payment-constants.mjs';
import { json, okJson, badRequest, originRequired, readJsonBody } from '../lib/http.mjs';
import { checkAppCheck, appCheckEnforced } from '../lib/app-check.mjs';

const { getDb } = firebaseAdminPkg;
const admin = adminPkg;
const { sendPurchase } = metaCapiPkg;

const MAX_ITEMS = 30;
const MAX_QTY_PER_ITEM = 20;
const MAX_TEXT_LEN = 300;
const EMAIL_MAX_LEN = 180;
const PHONE_REGEX = /^\+380\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ORDER_ID_CREATE_ATTEMPTS = 5; // на випадок колізії випадкового orderID (малоймовірно)
const FIRESTORE_ALREADY_EXISTS = 6;

function cleanText(value, maxLen = MAX_TEXT_LEN) {
    return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

// Приводить довільний формат (0671234567 / 380671234567 / +380671234567 / вже нормалізований)
// до +380XXXXXXXXX. Клієнт завжди надсилає вже нормалізоване значення, але сервер —
// джерело правди й не покладається на це (п. 4.7 ТЗ: клієнтська валідація лише для зручності).
function normalizePhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('380')) d = d.slice(3);
    else if (d.startsWith('0')) d = d.slice(1);
    if (d.length !== 9) return null;
    return '+380' + d;
}

export default async (req, context) => {
    if (req.method !== 'POST') return json(405, { error: 'Метод не підтримується.' });

    // 1) Origin: лише з нашого сайту (якщо SITE_URL задано, як і в create-payment).
    const siteUrl = process.env.SITE_URL;
    if (siteUrl && !originRequired(req, siteUrl)) return json(403, { error: 'Заборонено.' });

    // 2) App Check. getDb() ініціалізує Admin SDK (потрібно для admin.appCheck()).
    let db;
    try {
        db = getDb();
    } catch (e) {
        console.error('create-order: Firebase Admin не ініціалізовано:', e.message);
        return json(500, { error: 'Не вдалося оформити замовлення. Спробуйте ще раз.' });
    }
    const appCheck = await checkAppCheck(req, admin);
    if (!appCheck.ok) {
        console.warn(`create-order: App Check ${appCheck.reason}`);
        if (appCheckEnforced()) {
            return json(403, { error: 'Не вдалося підтвердити запит. Оновіть сторінку й спробуйте ще раз.' });
        }
    }

    const { value: payload, error: bodyError } = await readJsonBody(req, 32 * 1024);
    if (bodyError) return badRequest();

    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const customer = payload.customer || {};
    const delivery = payload.delivery || {};
    const attribution = payload.attribution || {};
    // Контекст для Meta Conversions API (analytics.js::getTrackingContext на клієнті).
    // IP не зберігаємо в жодному полі, крім цього об'єкта — потрібен лише для відправки в Meta.
    const headers = Object.fromEntries(req.headers);
    if (!headers['x-nf-client-connection-ip'] && context?.ip) headers['x-nf-client-connection-ip'] = context.ip;
    const { tracking, ip: clientIp, userAgent: clientUserAgent } = buildTrackingContext(payload.tracking, headers);

    // --- Базова валідація ---
    if (rawItems.length === 0) {
        return json(400, { error: 'Кошик порожній.' });
    }
    if (rawItems.length > MAX_ITEMS) {
        return json(400, { error: 'Забагато позицій у замовленні.' });
    }

    const name = cleanText(customer.name, 100);
    const phone = cleanText(customer.phone, 30);
    const email = cleanText(customer.email, EMAIL_MAX_LEN);
    const city = cleanText(delivery.city, 100);
    const cityRef = cleanText(delivery.cityRef, 100);
    const warehouse = cleanText(delivery.warehouse, 150);
    const warehouseRef = cleanText(delivery.warehouseRef, 100);
    const deliveryType = cleanText(delivery.deliveryType, 30) || 'nova_poshta';
    const deliveryFormat = cleanText(delivery.deliveryFormat, 30) || 'branch';
    const comment = cleanText(delivery.comment, 500);
    const packagingId = cleanText(delivery.packagingId, 50);

    // Спосіб оплати — суворий whitelist. За замовчуванням "online" (за замовчуванням у чекауті),
    // будь-яке невідоме значення від клієнта відхиляємо, а не тихо підміняємо на щось безпечне:
    // це або баг на фронтенді, або спроба обійти перевірку.
    const rawPaymentMethod = cleanText(delivery.paymentMethod, 30) || 'online';
    if (!PAYMENT_METHODS.includes(rawPaymentMethod)) {
        return json(400, { error: 'Невідомий спосіб оплати.' });
    }
    const paymentMethod = rawPaymentMethod;

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

    if (!name || !city || !cityRef || !warehouse) {
        return json(400, { error: 'Заповніть усі обов’язкові поля.' });
    }

    // Телефон — обов'язковий і має бути коректним українським номером після нормалізації
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone || !PHONE_REGEX.test(normalizedPhone)) {
        return json(400, { error: 'Некоректний формат номера телефону.' });
    }

    // Email — необов'язковий; якщо вказаний, має бути коректного формату
    if (email && !EMAIL_REGEX.test(email)) {
        return json(400, { error: 'Некоректний формат email.' });
    }

    // Прибираємо дублікати id в кошику, підсумовуючи кількість
    const wanted = new Map();
    for (const raw of rawItems) {
        const id = cleanText(raw?.id, 50);
        const qty = Math.floor(Number(raw?.qty));
        if (!id || !Number.isFinite(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
            return json(400, { error: `Некоректна кількість для товару ${id || '?'}.` });
        }
        wanted.set(id, (wanted.get(id) || 0) + qty);
    }

    try {
        // --- Базовий анти-спам: не більше 3 замовлень з одного номера за 10 хв ---
        // Матчимо по нормалізованому номеру, щоб різні формати запису того самого номера не обходили ліміт.
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
        const recentByPhone = await db.collection('orders')
            .where('customerPhone', '==', normalizedPhone)
            .where('createdAt', '>=', tenMinAgo)
            .limit(4)
            .get();
        if (recentByPhone.size >= 3) {
            return json(429, { error: 'Забагато замовлень поспіль з цього номера. Спробуйте за кілька хвилин або напишіть нам напряму.' });
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
            return json(409, {
                error: 'Деякі товари вже недоступні, оновіть кошик.',
                unavailable,
            });
        }

        // --- Пакування: ціна ніколи не приймається від клієнта — тільки packagingId,
        // ціну й назву сервер бере сам із Firestore (той самий патерн, що й для товарів). ---
        let packaging = null;
        if (packagingId) {
            const packSnap = await db.collection('packaging').where('id', '==', packagingId).limit(1).get();
            if (packSnap.empty || packSnap.docs[0].data().active === false) {
                return json(400, { error: 'Обраний варіант упакування вже недоступний, оновіть сторінку.' });
            }
            const packData = packSnap.docs[0].data();
            packaging = {
                id: packagingId,
                title: packData.title || packagingId,
                price: Number(packData.price) || 0,
            };
        }

        const total = items.reduce((sum, item) => sum + item.price * item.qty, 0) + (packaging ? packaging.price : 0);
        const totalKop = Math.round(total * 100);
        if (totalKop <= 0) {
            return json(400, { error: 'Некоректна сума замовлення.' });
        }

        const prepaymentKop = prepaymentKopFromEnv();
        // "cod" недоступний, якщо сума замовлення не більша за передоплату — інакше
        // передоплата покривала б усю суму й накладений платіж втрачає сенс.
        if (paymentMethod === 'cod' && !isCodAllowed(totalKop, prepaymentKop)) {
            return json(400, { error: 'Накладений платіж недоступний для цієї суми замовлення.' });
        }

        // Початковий стан залежить від способу оплати (розділи 2 і 5 архітектурного опису):
        //   online/cod — очікуємо оплату через monobank, замовлення ще не "в роботі";
        //   fop        — оплата поза системою, замовлення одразу в роботі.
        const isPayable = paymentMethod === 'online' || paymentMethod === 'cod';
        const orderStatus = isPayable ? ORDER_STATUS_AWAITING_PAYMENT : ORDER_STATUS_NEW;
        const paymentStatus = PAYMENT_STATUS.PENDING;
        const onlineAmount = onlineAmountKop({ method: paymentMethod, totalKop, prepaymentKop });
        const dueOnDeliveryKop = paymentMethod === 'cod' ? Math.max(0, totalKop - onlineAmount) : 0;

        // Токен для доступу до оплати/статусу цього замовлення без автентифікації користувача.
        // Клієнту йде сам токен, у базі — лише його хеш (netlify/lib/tokens.mjs).
        const statusToken = isPayable ? generateStatusToken() : null;
        const statusTokenHash = statusToken ? hashToken(statusToken) : null;

        // orderID генерується як криптостійкий випадковий рядок (не з часу створення),
        // а запис іде через .create(), який провалиться при колізії замість того, щоб
        // мовчки перезаписати чуже замовлення. Колізія по суті неможлива (~50 біт
        // ентропії), тому кілька спроб — лише про всяк випадок.
        let orderID;
        let lastError;
        for (let attempt = 0; attempt < ORDER_ID_CREATE_ATTEMPTS; attempt++) {
            orderID = generateOrderId();
            try {
                await db.collection('orders').doc(orderID).create({
                    orderID,
                    items,
                    total,
                    totalKop,
                    onlineAmountKop: onlineAmount,
                    dueOnDeliveryKop,
                    paidKop: 0,
                    refundedKop: 0,
                    refundPendingKop: 0,
                    customerName: name,
                    customerPhone: normalizedPhone,
                    customerEmail: email, // string | '' — необов'язкове поле (п. 4.2 ТЗ)
                    deliveryType,
                    deliveryFormat,
                    city,
                    cityRef,
                    warehouse,
                    warehouseRef,
                    paymentMethod,
                    paymentProvider: isPayable ? 'monobank' : null,
                    paymentStatus,
                    orderStatus,
                    invoiceId: null,
                    statusTokenHash,
                    attempts: 0,
                    paymentLock: null,
                    needsAttention: null,
                    comment,
                    packaging, // { id, title, price } | null — п. 5.3.8 ТЗ
                    utm,
                    tracking, // fbp/fbc/consent/… для Meta CAPI; capi{} додається нижче (fop) або при підтвердженні оплати (online/cod)
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                lastError = null;
                break;
            } catch (e) {
                lastError = e;
                // ALREADY_EXISTS — пробуємо інший orderID; будь-яка інша помилка йде далі без повтору.
                if (e?.code !== FIRESTORE_ALREADY_EXISTS) throw e;
            }
        }
        if (lastError) {
            console.error('create-order: не вдалося згенерувати унікальний orderID', lastError);
            return json(500, { error: 'Не вдалося оформити замовлення. Спробуйте ще раз.' });
        }

        // Серверна подія Purchase у Meta CAPI для fop за замовчуванням ВИМКНЕНА:
        // fop-замовлення стає "new" одразу, без оплати й без підтвердження, тож будь-хто, хто
        // обійде захист вище, міг би накрутити фейкові конверсії в рекламний кабінет Meta.
        // Пікселя в браузері (trackPurchaseOnce у cart.js) це не стосується.
        // Повернути стару поведінку: CAPI_FOP_ON_CREATE=true у Netlify.
        // Для online/cod CAPI-подія йде окремо, з applyInvoiceState, у момент підтвердження
        // paid/prepaid (netlify/lib/apply-invoice-state.mjs).
        // sendPurchase ніколи не кидає винятків; запис результату — best effort.
        if (!isPayable && process.env.CAPI_FOP_ON_CREATE === 'true') {
            const capi = await sendPurchase({
                orderID, items, total,
                customer: { name, phone: normalizedPhone },
                tracking, ip: clientIp, userAgent: clientUserAgent,
            });
            try {
                await db.collection('orders').doc(orderID).update({
                    'tracking.capi': { ...capi, sentAt: admin.firestore.Timestamp.now() },
                });
            } catch (e) {
                console.error('create-order: не вдалося записати статус CAPI:', e.message);
            }
        }

        return okJson({
            orderID,
            items,
            total,
            packaging,
            paymentMethod,
            onlineAmountKop: onlineAmount,
            dueOnDeliveryKop,
            statusToken, // null для fop — оплата поза системою, статус не потрібен
        });
    } catch (e) {
        console.error('create-order error:', e);
        return json(500, { error: 'Не вдалося оформити замовлення. Спробуйте ще раз.' });
    }
};

// Ліміт по IP: оформлення замовлення — рідка дія, 5 спроб на хвилину з однієї адреси з запасом.
export const config = {
    rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ['ip'] },
};
