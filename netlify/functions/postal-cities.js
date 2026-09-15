// GET /.netlify/functions/postal-cities?q=київ
// Шукає міста через API Нової пошти, кешуючи результат у Firestore на 30 днів —
// один і той самий запит від різних клієнтів не буде щоразу йти до Нової пошти.
const { getCached } = require('./_cache');

const NP_API_URL = 'https://api.novaposhta.ua/v2.0/json/';
const CITIES_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 днів

exports.handler = async (event) => {
    const query = (event.queryStringParameters?.q || '').trim();

    if (query.length < 2) {
        return { statusCode: 200, body: JSON.stringify([]) };
    }

    const docId = `np_${query.toLowerCase()}`;

    try {
        const { data } = await getCached('postal_cities', docId, CITIES_TTL_MS, async () => {
            const response = await fetch(NP_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apiKey: process.env.NOVA_POSHTA_API_KEY,
                    modelName: 'Address',
                    calledMethod: 'getCities',
                    methodProperties: { FindByString: query, Limit: '15' },
                }),
            });
            const json = await response.json();

            if (!json.success) {
                throw new Error(json.errors?.join(', ') || 'Nova Poshta API error');
            }

            // Уніфікований вигляд — тільки те, що реально потрібно фронтенду
            return json.data.map((city) => ({
                ref: city.Ref,
                name: `${city.Description}, ${city.AreaDescription} обл.`,
            }));
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        };
    } catch (e) {
        console.error('postal-cities error:', e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Не вдалося отримати список міст.' }) };
    }
};
