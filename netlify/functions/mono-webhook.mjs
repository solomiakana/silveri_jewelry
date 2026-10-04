// POST /.netlify/functions/mono-webhook
// Приймає сповіщення про статус інвойсу від monobank. Алгоритм — архітектурний опис, 7.2.
//
// Важливо: підпис рахується від точного сирого тіла запиту. У функціях v2 воно береться
// через req.text() і НІКОЛИ не переганяється через JSON.parse -> JSON.stringify.
import firebaseAdminPkg from './_firebaseAdmin.js';
import { createHash } from 'node:crypto';
import { verifyMonoSignature } from '../lib/mono-signature.mjs';
import { getMonoPublicKey, refetchMonoPublicKey } from '../lib/pubkey-cache.mjs';
import { getMonoClient } from '../lib/mono-env.mjs';
import { applyInvoiceState } from '../lib/apply-invoice-state.mjs';
import { INVOICE_ID_RE, MONO_STATUSES } from '../lib/payment-constants.mjs';

const { getDb } = firebaseAdminPkg;
const MAX_BODY_BYTES = 64 * 1024;

export default async (req) => {
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    const signature = req.headers.get('x-sign');
    if (!signature) return new Response(null, { status: 401 });

    const rawBody = await req.text();
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) return new Response(null, { status: 413 });

    const db = getDb();
    const mono = getMonoClient();

    let key = await getMonoPublicKey({ db, monoClient: mono });
    let valid = verifyMonoSignature({ rawBody, signature, publicKey: key });
    if (!valid) {
        // Ключ міг ротуватися: не частіше ніж раз на кілька хвилин пробуємо перезапитати.
        const fresh = await refetchMonoPublicKey({ db, monoClient: mono }).catch(() => null);
        if (fresh) {
            key = fresh;
            valid = verifyMonoSignature({ rawBody, signature, publicKey: key });
        }
    }
    if (!valid) {
        console.warn('mono-webhook: невалідний підпис', {
            bodyHash: createHash('sha256').update(rawBody).digest('hex'),
            ip: req.headers.get('x-nf-client-connection-ip'),
            snippet: rawBody.slice(0, 2000),
        });
        return new Response(null, { status: 401 });
    }

    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return new Response(null, { status: 400 });
    }

    // Валідація схеми до застосування (дешева, ще до транзакції). Повністю невалідні
    // події все одно відповідаємо 200 — повтор нічого не виправить (розділ 7.2, крок 7).
    const event = {
        invoiceId: payload?.invoiceId,
        status: payload?.status,
        amount: payload?.amount,
        ccy: payload?.ccy,
        finalAmount: payload?.finalAmount,
        reference: payload?.reference,
        modifiedDate: payload?.modifiedDate,
        errCode: payload?.errCode,
        failureReason: payload?.failureReason,
        paymentInfo: payload?.paymentInfo,
        cancelList: payload?.cancelList,
    };
    if (typeof event.invoiceId !== 'string' || !INVOICE_ID_RE.test(event.invoiceId) || !MONO_STATUSES.includes(event.status)) {
        return new Response(null, { status: 200 }); // syntactically valid JSON, but not our shape — nothing to retry
    }

    const eventId = createHash('sha256').update(rawBody).digest('hex');
    try {
        const outcome = await applyInvoiceState({
            db, event, source: 'webhook', eventId, rawBodyForLog: rawBody,
            ip: req.headers.get('x-nf-client-connection-ip'),
        });
        if (outcome?.result === 'rejected_mismatch') {
            console.error('mono-webhook: розбіжність даних, needsAttention виставлено', event.invoiceId, outcome.reason);
        }
        return new Response(null, { status: 200 });
    } catch (e) {
        // Тимчасовий збій (напр. Firestore недоступний) — 500, Mono повторить доставку
        // до 3 разів; далі стан наздожене планова звірка (reconcile-payments).
        console.error('mono-webhook: помилка обробки', e);
        return new Response(null, { status: 500 });
    }
};

export const config = {
    // Джерело — Mono, а не браузер; захист це підпис, не IP-ліміт (архітектурний опис, 8.2).
    // Ліміт лишається як крайній запобіжник від аномального шторму запитів.
    rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip'] },
};
