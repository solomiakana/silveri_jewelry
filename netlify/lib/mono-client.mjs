import { CCY_UAH, INVOICE_ID_RE } from './payment-constants.mjs';

// Мінімальний клієнт monobank acquiring (Node 18+, вбудований fetch).
// Автоматичних повторів немає навмисно: для create/cancel після таймауту невідомо,
// чи операція виконана, тому рішення про повтор приймає викликаюча логіка.

export class MonoApiError extends Error {
    constructor(kind, { status = null, errCode = null, errText = null } = {}) {
        super(`Mono API: ${kind}${status ? ` (${status})` : ''}`);
        this.name = 'MonoApiError';
        this.kind = kind;       // timeout | network | bad_request | auth | not_found | rate_limited | server | unexpected
        this.status = status;
        this.errCode = errCode;
        this.errText = errText;
    }

    // Чи можна безпечно вважати, що операція НЕ виконана (запит відхилено до обробки).
    get definitelyNotApplied() {
        return ['bad_request', 'auth', 'not_found', 'rate_limited'].includes(this.kind);
    }

    // Чи результат невідомий (таймаут, мережа, 5xx) — потрібна звірка, а не повтор наосліп.
    get outcomeUnknown() {
        return ['timeout', 'network', 'server'].includes(this.kind);
    }
}

function kindFromStatus(status) {
    if (status === 400) return 'bad_request';
    if (status === 403) return 'auth';
    if (status === 404) return 'not_found';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server';
    return 'unexpected';
}

export function createMonoClient({
    token,
    baseUrl = 'https://api.monobank.ua',
    fetchImpl = globalThis.fetch,
    timeoutMs = 7000,
} = {}) {
    if (!token) throw new Error('MONOBANK_MERCHANT_TOKEN не налаштований');
    if (typeof fetchImpl !== 'function') throw new Error('fetch недоступний');

    async function request(method, path, { query, body } = {}) {
        const url = new URL(path, baseUrl);
        if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await fetchImpl(url, {
                method,
                headers: {
                    'X-Token': token,
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
        } catch (e) {
            throw new MonoApiError(e?.name === 'AbortError' ? 'timeout' : 'network');
        } finally {
            clearTimeout(timer);
        }

        const text = await res.text().catch(() => '');
        let json = null;
        if (text) {
            try { json = JSON.parse(text); } catch { json = null; }
        }

        if (!res.ok) {
            throw new MonoApiError(kindFromStatus(res.status), {
                status: res.status,
                errCode: json?.errCode ?? null,
                errText: json?.errText ?? null,
            });
        }
        return json;
    }

    return {
        // POST /api/merchant/invoice/create
        async createInvoice({ amountKop, reference, destination, redirectUrl, webHookUrl, validitySec }) {
            if (!Number.isInteger(amountKop) || amountKop <= 0) throw new RangeError('Некоректна сума інвойсу');
            const data = await request('POST', '/api/merchant/invoice/create', {
                body: {
                    amount: amountKop,
                    ccy: CCY_UAH,
                    paymentType: 'debit',
                    validity: validitySec,
                    redirectUrl,
                    webHookUrl,
                    merchantPaymInfo: { reference, destination },
                },
            });
            if (!data || typeof data.invoiceId !== 'string' || !INVOICE_ID_RE.test(data.invoiceId)
                || typeof data.pageUrl !== 'string') {
                throw new MonoApiError('unexpected');
            }
            let page;
            try { page = new URL(data.pageUrl); } catch { throw new MonoApiError('unexpected'); }
            if (page.protocol !== 'https:') throw new MonoApiError('unexpected');
            return { invoiceId: data.invoiceId, pageUrl: page.toString() };
        },

        // GET /api/merchant/invoice/status
        async getInvoiceStatus(invoiceId) {
            return request('GET', '/api/merchant/invoice/status', { query: { invoiceId } });
        },

        // POST /api/merchant/invoice/remove — інвалідація ще не оплаченого інвойсу
        async removeInvoice(invoiceId) {
            await request('POST', '/api/merchant/invoice/remove', { body: { invoiceId } });
        },

        // POST /api/merchant/invoice/cancel — повне скасування (amount не передаємо навмисно)
        async cancelInvoice({ invoiceId, extRef, items }) {
            return request('POST', '/api/merchant/invoice/cancel', {
                body: { invoiceId, extRef, ...(items ? { items } : {}) },
            });
        },

        // GET /api/merchant/pubkey -> { key: base64(PEM) }
        async getPublicKey() {
            const data = await request('GET', '/api/merchant/pubkey');
            if (!data || typeof data.key !== 'string' || !data.key) throw new MonoApiError('unexpected');
            return data.key;
        },
    };
}
