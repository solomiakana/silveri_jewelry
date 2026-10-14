// GET /api/catalog
// Публічний знімок каталогу (товари + опубліковані відгуки) для всіх сторінок сайту.
// Замінює прямі onSnapshot/getDocs із браузера: без цього кожен перегляд головної чи каталогу
// читав усю колекцію products (і reviews) з Firestore.
//
// Кешування (дві незалежні межі):
//  - браузер: Cache-Control max-age=60;
//  - CDN Netlify: Netlify-CDN-Cache-Control s-maxage=3600 + stale-while-revalidate=86400.
//    Після закінчення години перший запит отримує попередню версію одразу, а оновлення
//    відбувається у фоні — відвідувач ніколи не чекає на Firestore.
// Після змін в адмінці кеш скидається за тегом "catalog" функцією catalog-refresh.mjs, тож
// нові товари, ціни й наявність з'являються за лічені секунди, а не за годину.
//
// Захист від зловживань: будь-який query-рядок → 400 (без звернення до Firestore і без кешу),
// інакше ?x=1, ?x=2… обходили б кеш CDN і множили читання. Додатково — ліміт запитів по IP.
import firebaseAdminPkg from './_firebaseAdmin.js';
import { getCatalog, CATALOG_CACHE_TAG } from '../lib/catalog.mjs';
import { json } from '../lib/http.mjs';

const { getDb } = firebaseAdminPkg;

export default async (req) => {
    if (req.method !== 'GET') return json(405, { error: 'Метод не підтримується.' });
    if (new URL(req.url).search) return json(400, { error: 'Некоректний запит.' });

    try {
        const payload = await getCatalog(getDb());
        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'public, max-age=60',
                'Netlify-CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400, durable',
                'Netlify-Cache-Tag': CATALOG_CACHE_TAG,
            },
        });
    } catch (e) {
        console.error('catalog: не вдалося зібрати каталог', e);
        // json() ставить no-store: помилку CDN не кешує.
        return json(500, { error: 'Не вдалося завантажити каталог.' });
    }
};

export const config = {
    path: '/api/catalog',
    rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip'] },
};
