// Дрібні хелпери для функцій формату v2 (Web Request/Response).

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

export function json(status, body, extraHeaders = {}) {
    return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...NO_STORE_HEADERS, ...extraHeaders },
    });
}

export const okJson = (body, extra) => json(200, body, extra);
export const badRequest = (error = 'Некоректний запит.') => json(400, { error });
export const notFound = (error = 'Не знайдено.') => json(404, { error });
export const forbidden = (error = 'Доступ заборонено.') => json(403, { error });
export const conflict = (error, extra) => json(409, { error, ...extra });
export const tooMany = (error = 'Забагато запитів. Спробуйте пізніше.') => json(429, { error });
export const serverError = (error = 'Внутрішня помилка сервера.') => json(500, { error });
export const badGateway = (error, code) => json(502, { error, code });

// Перевірка Origin для POST-запитів із браузера (додатковий бар'єр, не заміна токенної авторизації —
// архітектурний опис, 8.3). Заголовок Origin може бути відсутній (наприклад, у нативних застосунках),
// тоді пропускаємо перевірку; якщо присутній, він має збігатися з SITE_URL.
export function originAllowed(req, siteUrl) {
    const origin = req.headers.get('origin');
    if (!origin) return true;
    try {
        return new URL(origin).origin === new URL(siteUrl).origin;
    } catch {
        return false;
    }
}

// Суворіша версія для публічних POST-ендпоінтів, що створюють дані (create-order):
// браузер ЗАВЖДИ додає Origin до POST-запиту fetch(), тож його відсутність означає, що запит
// прийшов не з браузера (curl, скрипт) — відхиляємо. Підробити Origin з curl легко, тому це лише
// перший бар'єр, а основний — App Check (lib/app-check.mjs) і rate limit.
export function originRequired(req, siteUrl) {
    const origin = req.headers.get('origin');
    if (!origin) return false;
    try {
        return new URL(origin).origin === new URL(siteUrl).origin;
    } catch {
        return false;
    }
}

export async function readJsonBody(req, maxBytes = 16 * 1024) {
    const text = await req.text();
    if (text.length > maxBytes) return { error: 'too_large' };
    if (!text) return { value: {} };
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'not_object' };
        return { value };
    } catch {
        return { error: 'bad_json' };
    }
}
