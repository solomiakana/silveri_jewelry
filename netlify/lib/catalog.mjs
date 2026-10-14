// Публічний знімок каталогу: товари + опубліковані відгуки в одному JSON.
// Його віддає /api/catalog (netlify/functions/catalog.mjs), а CDN Netlify кешує відповідь,
// тож Firestore читається один раз на оновлення кешу, а не на кожен перегляд сторінки.
//
// Модуль не імпортує firebase-admin: db передається ззовні, тому логіку можна тестувати
// з підробним db (catalog.test.mjs).

export const CATALOG_CACHE_TAG = 'catalog';
export const MAX_PRODUCTS = 1000;
export const REVIEWS_LIMIT = 60;
export const MEMORY_TTL_MS = 60 * 1000;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

// Білий список полів: у публічну відповідь потрапляє лише те, що реально показує сайт
// (script.js: buildProductCard, renderProductDetail, renderFeatured). Будь-які інші поля
// документів (службові, майбутні) назовні не віддаються.
export function serializeProduct(data) {
    const out = {
        id: str(data.id),
        title: str(data.title),
        description: str(data.description),
        price: Number(data.price) || 0,
        image: str(data.image),
        category: str(data.category),
        weight: str(data.weight),
        size: str(data.size),
        purity: str(data.purity),
        coating: str(data.coating),
        // inStock: сайт перевіряє саме `=== false`, тож зберігаємо булеве значення як є,
        // а відсутнє поле лишаємо відсутнім (тобто «в наявності», як і раніше).
        featured: data.featured === true,
    };
    if (typeof data.inStock === 'boolean') out.inStock = data.inStock;
    return out;
}

// Публічний відгук: без instagramLink, productId, published, createdAt.
export function serializeReview(data) {
    return {
        name: str(data.name),
        text: str(data.text),
        rating: Number(data.rating) || 0,
        image: str(data.image),
        sortOrder: Number(data.sortOrder) || 0,
    };
}

// Ті самі запити, що раніше робив браузер (script.js), тільки тепер — на сервері й з лімітами.
export async function loadCatalog(db) {
    const [productsSnap, reviewsSnap] = await Promise.all([
        db.collection('products').orderBy('createdAt', 'desc').limit(MAX_PRODUCTS).get(),
        db.collection('reviews')
            .where('published', '==', true)
            .orderBy('sortOrder', 'desc')
            .limit(REVIEWS_LIMIT)
            .get(),
    ]);

    if (productsSnap.size >= MAX_PRODUCTS) {
        console.warn(`catalog: досягнуто ліміт ${MAX_PRODUCTS} товарів — частину може бути не видно`);
    }

    return {
        products: productsSnap.docs.map((d) => serializeProduct(d.data())),
        reviews: reviewsSnap.docs.map((d) => serializeReview(d.data())),
        generatedAt: new Date().toISOString(),
    };
}

// Короткий кеш у пам'яті інстансу функції. Дві задачі:
//  - паралельні запити під час промаху CDN (або фонового оновлення) ділять одне читання Firestore;
//  - повторні виклики протягом хвилини не читають базу взагалі.
// Помилки не кешуються.
let memo = null;
let inflight = null;

export async function getCatalog(db, { now = Date.now, ttlMs = MEMORY_TTL_MS } = {}) {
    if (memo && now() - memo.at < ttlMs) return memo.payload;
    if (!inflight) {
        inflight = loadCatalog(db)
            .then((payload) => {
                memo = { at: now(), payload };
                return payload;
            })
            .finally(() => {
                inflight = null;
            });
    }
    return inflight;
}

export function resetCatalogMemory() {
    memo = null;
}
