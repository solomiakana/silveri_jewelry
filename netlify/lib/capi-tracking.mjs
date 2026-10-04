// Санітизація контексту для Meta Conversions API (fbp/fbc/consent/…), який клієнт
// передає в create-order разом із замовленням (аналітика, analytics.js::getTrackingContext).
// Винесено окремо, бо цей об'єкт читають і create-order.mjs (fop: CAPI одразу),
// і apply-invoice-state.mjs (online/cod: CAPI лише після підтвердженої оплати).

function cleanStr(value, maxLen) {
    return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

export function buildTrackingContext(rawTracking, headers = {}) {
    const clientTracking = rawTracking && typeof rawTracking === 'object' ? rawTracking : {};
    const clientIp = headers['x-nf-client-connection-ip']
        || String(headers['x-forwarded-for'] || '').split(',')[0].trim()
        || '';
    const userAgent = cleanStr(headers['user-agent'], 300) || cleanStr(clientTracking.clientUserAgent, 300);

    const tracking = {
        fbp: cleanStr(clientTracking.fbp, 150),
        fbc: cleanStr(clientTracking.fbc, 250),
        consent: ['granted', 'denied'].includes(clientTracking.consent) ? clientTracking.consent : 'unset',
        eventSourceUrl: /^https?:\/\//.test(clientTracking.eventSourceUrl || '') ? cleanStr(clientTracking.eventSourceUrl, 300) : '',
        gaClientId: cleanStr(clientTracking.gaClientId, 100),
        gaSessionId: cleanStr(clientTracking.gaSessionId, 100),
        clientUserAgent: userAgent,
        // IP замовника зберігаємо лише тут, у tracking: потрібен для відкладеної CAPI-події
        // online/cod (applyInvoiceState шле її значно пізніше за create-order, коли запит
        // клієнта вже завершився й IP більше нізвідки взяти). Жодних інших цілей чи логів.
        ip: cleanStr(clientIp, 64),
    };
    Object.keys(tracking).forEach((k) => { if (!tracking[k]) delete tracking[k]; });
    return { tracking, ip: clientIp, userAgent };
}
