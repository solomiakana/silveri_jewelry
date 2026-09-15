// GET /.netlify/functions/postal-warehouses?cityRef=<guid>
// Список відділень/поштоматів обраного міста, кешується на 7 днів (відділення
// відкриваються/закриваються частіше, ніж з'являються нові міста).
const { getCached } = require('./_cache');

const NP_API_URL = 'https://api.novaposhta.ua/v2.0/json/';
const WAREHOUSES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 днів

exports.handler = async (event) => {
    const cityRef = (event.queryStringParameters?.cityRef || '').trim();

    if (!cityRef) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Не вказано cityRef.' }) };
    }

    const docId = `np_${cityRef}`;

    try {
        const { data } = await getCached('postal_warehouses', docId, WAREHOUSES_TTL_MS, async () => {
            const response = await fetch(NP_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apiKey: process.env.NOVA_POSHTA_API_KEY,
                    modelName: 'Address',
                    calledMethod: 'getWarehouses',
                    methodProperties: { CityRef: cityRef, Limit: '500' },
                }),
            });
            const json = await response.json();

            if (!json.success) {
                throw new Error(json.errors?.join(', ') || 'Nova Poshta API error');
            }

            return json.data.map((wh) => ({
                ref: wh.Ref,
                name: wh.Description,
                // "Поштомат" у CategoryOfWarehouse Нової пошти позначається як "Postomat"
                type: wh.CategoryOfWarehouse === 'Postomat' ? 'postomat' : 'branch',
            }));
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        };
    } catch (e) {
        console.error('postal-warehouses error:', e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Не вдалося отримати список відділень.' }) };
    }
};
