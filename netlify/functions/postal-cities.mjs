// GET /.netlify/functions/postal-cities?q=київ
// Шукає міста через API Нової пошти, кешуючи результат у Firestore на 30 днів —
// один і той самий запит від різних клієнтів не буде щоразу йти до Нової пошти.
//
// Захист від зловживань (функція публічна, ключ НП і квота — наші):
//  - ліміт запитів по IP (config.rateLimit нижче);
//  - q: 2–50 символів, лише літери/цифри/пробіл/апостроф/дефіс/крапка, інакше — порожній
//    результат без звернення до НП і без запису в кеш;
//  - ключ кешу — sha256 від нормалізованого запиту (довільний рядок не стає ID документа);
//  - порожні відповіді не кешуються (див. _cache.js), таймаут на запит до НП.
import { createHash } from 'node:crypto';
import cachePkg from './_cache.js';
import { json } from '../lib/http.mjs';

const { getCached } = cachePkg;

const NP_API_URL = 'https://api.novaposhta.ua/v2.0/json/';
const CITIES_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 днів
const NP_TIMEOUT_MS = 8000;
const Q_MIN = 2;
const Q_MAX = 50;
const Q_ALLOWED = /^[\p{L}\p{N}\s'’ʼ.\-]+$/u;

function normalizeQuery(raw) {
    return String(raw || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export default async (req) => {
    if (req.method !== 'GET') return json(405, { error: 'Метод не підтримується.' });

    const query = normalizeQuery(new URL(req.url).searchParams.get('q'));

    if (query.length < Q_MIN || query.length > Q_MAX || !Q_ALLOWED.test(query)) {
        return json(200, []);
    }

    const docId = `np_${createHash('sha256').update(query).digest('hex').slice(0, 40)}`;

    try {
        const { data } = await getCached('postal_cities', docId, CITIES_TTL_MS, async () => {
            const response = await fetch(NP_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(NP_TIMEOUT_MS),
                body: JSON.stringify({
                    apiKey: process.env.NOVA_POSHTA_API_KEY,
                    modelName: 'Address',
                    calledMethod: 'getCities',
                    methodProperties: { FindByString: query, Limit: '15' },
                }),
            });
            const result = await response.json();

            if (!result.success) {
                throw new Error(result.errors?.join(', ') || 'Nova Poshta API error');
            }

            // Уніфікований вигляд — тільки те, що реально потрібно фронтенду
            return result.data.map((city) => ({
                ref: city.Ref,
                name: `${city.Description}, ${city.AreaDescription} обл.`,
            }));
        });

        return json(200, data);
    } catch (e) {
        console.error('postal-cities error:', e);
        return json(500, { error: 'Не вдалося отримати список міст.' });
    }
};

// Автокомпліт шле запит на кожне натискання (з debounce 300 мс), тож ліміт щедріший, ніж у create-order.
export const config = {
    rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip'] },
};
