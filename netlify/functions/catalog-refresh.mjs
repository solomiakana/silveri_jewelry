// POST /api/catalog-refresh
// Викликається адмінкою після зміни товару чи відгуку: скидає кеш CDN для /api/catalog
// (за тегом "catalog"), тож наступний відвідувач одразу отримає свіжий каталог.
// Без цього зміни з'явилися б на сайті лише після закінчення TTL (до 1 години).
//
// Лише для адміна (Firebase ID token + /admins/{uid}) — інакше будь-хто міг би примусово
// скидати кеш і множити читання Firestore. Вимога «свіжого входу» тут не потрібна:
// операція не фінансова й нічого не змінює в даних.
import { requireAdmin } from '../lib/admin-auth.mjs';
import { resetCatalogMemory, CATALOG_CACHE_TAG } from '../lib/catalog.mjs';
import { json, okJson, forbidden } from '../lib/http.mjs';

export default async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'Метод не підтримується.' });

    const auth = await requireAdmin(req.headers.get('authorization'));
    if (auth.error) return forbidden();

    // Кеш у пам'яті цього інстансу (інші інстанси скинуться самі за ≤60 с).
    resetCatalogMemory();

    let purged = false;
    try {
        // Динамічний імпорт: якщо пакет недоступний чи Netlify відхилив скидання, адмінка
        // отримає purged:false і покаже попередження, а не мовчазну помилку.
        const { purgeCache } = await import('@netlify/functions');
        await purgeCache({ tags: [CATALOG_CACHE_TAG] });
        purged = true;
    } catch (e) {
        console.error('catalog-refresh: не вдалося скинути кеш CDN', e);
    }

    return okJson({ ok: true, purged });
};

export const config = {
    path: '/api/catalog-refresh',
    rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip'] },
};
