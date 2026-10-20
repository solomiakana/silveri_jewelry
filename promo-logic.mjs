

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

// Сторінки, де банер дозволений: головна, каталог, FAQ і картки товарів.
// (checkout, order-status, admin, privacy, terms — свідомо поза списком.)
const ALLOWED_PATHS = new Set([
    '/', '/index.html',
    '/catalog', '/catalog.html',
    '/faq', '/faq.html',
    '/product.html',
]);

// Розбирає значення з localStorage у число-мітку часу. Усе некоректне → null («ніколи не показували»).
export function parseLastShown(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// Кампанія активна, якщо вона увімкнена і "now" потрапляє в необов'язковий інтервал дат.
export function isCampaignActive(campaign, now) {
    if (!campaign || campaign.enabled === false) return false;
    if (campaign.startsAt && now < Date.parse(campaign.startsAt)) return false;
    if (campaign.endsAt && now >= Date.parse(campaign.endsAt)) return false;
    return true;
}

// Чи минуло cooldown з моменту останнього показу.
// Мітка з майбутнього — це збій годинника на пристрої: якщо вона далі за cooldown від "now",
// вважаємо її хибною (інакше банер заблокувався б назавжди), інакше — трактуємо як «щойно».
export function isCooldownOver(lastShownAt, now, cooldownMs) {
    if (lastShownAt === null || lastShownAt === undefined) return true;
    const elapsed = now - lastShownAt;
    if (elapsed < 0) return -elapsed > cooldownMs;
    return elapsed >= cooldownMs;
}

// Артикул товару з адреси сторінки: /product.html?id=124 або /product/124.
export function productIdFromLocation(pathname, search) {
    const fromQuery = new URLSearchParams(search || '').get('id');
    if (fromQuery) return fromQuery;
    const m = /^\/product\/([^/]+)\/?$/.exec(pathname || '');
    return m ? decodeURIComponent(m[1]) : null;
}

// Чи дозволена ця сторінка. На сторінці самого акційного товару банер зайвий.
export function isPageEligible(pathname, search, campaignProductId) {
    const path = pathname || '/';
    const isProductPage = path === '/product.html' || path.startsWith('/product/');
    if (!isProductPage && !ALLOWED_PATHS.has(path)) return false;
    if (isProductPage) {
        const id = productIdFromLocation(path, search);
        if (id !== null && String(id) === String(campaignProductId)) return false;
    }
    return true;
}

// Тимчасові перешкоди: банер не скасовується, а відкладається, поки вони не зникнуть.
// state: { tabVisible, cookieBannerVisible, cartOpen, otherModalOpen, typingInField }
export function getBlocker(state) {
    if (!state.tabVisible) return 'tab-hidden';
    if (state.cookieBannerVisible) return 'cookie-banner';
    if (state.cartOpen) return 'cart-open';
    if (state.otherModalOpen) return 'other-modal';
    if (state.typingInField) return 'typing';
    return null;
}

// Остаточне рішення. Повертає { show: boolean, reason: string } — причина потрібна
// і для тестів, і для налагодження в консолі (localStorage.silveri_debug = '1').
// ctx: { now, campaign, lastShownAt, product, inCart }
export function evaluateShow(ctx) {
    const { now, campaign, lastShownAt, product, inCart } = ctx;
    if (!isCampaignActive(campaign, now)) return { show: false, reason: 'campaign-inactive' };
    if (!isCooldownOver(lastShownAt, now, campaign.cooldownMs)) return { show: false, reason: 'cooldown' };
    if (!product) return { show: false, reason: 'product-not-found' };
    if (product.inStock === false) return { show: false, reason: 'out-of-stock' };
    // Ціна вшита в картинку банера. Якщо в каталозі вона змінилась — банер не показуємо,
    // щоб відвідувач ніколи не побачив одну суму в банері й іншу в кошику.
    if (campaign.expectedPrice !== undefined && Number(product.price) !== Number(campaign.expectedPrice)) {
        return { show: false, reason: 'price-mismatch' };
    }
    if (inCart) return { show: false, reason: 'already-in-cart' };
    return { show: true, reason: 'ok' };
}
