// Побудова клієнта Mono та базових URL із змінних середовища Netlify.
// SITE_URL завжди з env, ніколи з заголовка Host запиту (захист від Host header injection —
// архітектурний опис, розділ 8.1).
import { createMonoClient } from './mono-client.mjs';

export function getSiteUrl(env = process.env) {
    const url = env.SITE_URL;
    if (!url) throw new Error('Змінна середовища SITE_URL не налаштована.');
    return url.replace(/\/+$/, '');
}

export function getMonoClient(env = process.env) {
    const token = env.MONOBANK_MERCHANT_TOKEN;
    if (!token) throw new Error('Змінна середовища MONOBANK_MERCHANT_TOKEN не налаштована.');
    return createMonoClient({ token });
}

export function redirectUrlFor(orderID, env = process.env) {
    return `${getSiteUrl(env)}/order-status.html?orderID=${encodeURIComponent(orderID)}`;
}

export function webHookUrl(env = process.env) {
    return `${getSiteUrl(env)}/.netlify/functions/mono-webhook`;
}
