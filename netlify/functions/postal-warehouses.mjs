// GET /.netlify/functions/postal-warehouses?cityRef=<guid>
// Список відділень/поштоматів обраного міста, кешується на 7 днів (відділення
// відкриваються/закриваються частіше, ніж з'являються нові міста).
//
// cityRef має бути GUID (так Нова пошта ідентифікує місто), будь-що інше — 400 без звернення до НП.
// Ліміт запитів по IP — config.rateLimit нижче.
import cachePkg from './_cache.js';
import { json } from '../lib/http.mjs';

const { getCached } = cachePkg;

const NP_API_URL = 'https://api.novaposhta.ua/v2.0/json/';
const WAREHOUSES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 днів
const NP_TIMEOUT_MS = 8000;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async (req) => {
    if (req.method !== 'GET') return json(405, { error: 'Метод не підтримується.' });

    const cityRef = (new URL(req.url).searchParams.get('cityRef') || '').trim().toLowerCase();

    if (!cityRef || !GUID_RE.test(cityRef)) {
        return json(400, { error: 'Не вказано або некоректний cityRef.' });
    }

    const docId = `np_${cityRef}`;

    try {
        const { data } = await getCached('postal_warehouses', docId, WAREHOUSES_TTL_MS, async () => {
            const response = await fetch(NP_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(NP_TIMEOUT_MS),
                body: JSON.stringify({
                    apiKey: process.env.NOVA_POSHTA_API_KEY,
                    modelName: 'Address',
                    calledMethod: 'getWarehouses',
                    methodProperties: { CityRef: cityRef, Limit: '500' },
                }),
            });
            const result = await response.json();

            if (!result.success) {
                throw new Error(result.errors?.join(', ') || 'Nova Poshta API error');
            }

            return result.data.map((wh) => ({
                ref: wh.Ref,
                name: wh.Description,
                // "Поштомат" у CategoryOfWarehouse Нової пошти позначається як "Postomat"
                type: wh.CategoryOfWarehouse === 'Postomat' ? 'postomat' : 'branch',
            }));
        });

        return json(200, data);
    } catch (e) {
        console.error('postal-warehouses error:', e);
        return json(500, { error: 'Не вдалося отримати список відділень.' });
    }
};

export const config = {
    rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip'] },
};
