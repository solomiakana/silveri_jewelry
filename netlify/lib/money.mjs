// Грошові розрахунки: усе на сервері, у копійках, цілими числами.

// Гривні (можуть бути дробові, до 2 знаків) -> копійки.
// Кидає помилку для від'ємних, нескінченних значень і значень із більш ніж 2 знаками після коми,
// щоб мовчки не округлити дивну ціну.
export function uahToKop(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
        throw new RangeError('Некоректна сума');
    }
    const kop = Math.round(n * 100);
    if (Math.abs(n * 100 - kop) > 1e-6) {
        throw new RangeError('Сума має більше двох знаків після коми');
    }
    return kop;
}

export function kopToUah(kop) {
    return kop / 100;
}

// Розмір передоплати з env (PREPAYMENT_UAH), за замовчуванням 200 грн.
export function prepaymentKopFromEnv(env = process.env) {
    const raw = env?.PREPAYMENT_UAH;
    if (raw === undefined || raw === null || raw === '') return 20_000;
    const kop = uahToKop(raw);
    if (kop <= 0) throw new RangeError('PREPAYMENT_UAH має бути більше нуля');
    return kop;
}

// Накладений платіж доступний лише коли сума замовлення більша за передоплату.
export function isCodAllowed(totalKop, prepaymentKop) {
    return Number.isInteger(totalKop) && totalKop > prepaymentKop;
}

// Сума інвойсу Mono залежно від способу оплати.
export function onlineAmountKop({ method, totalKop, prepaymentKop }) {
    if (!Number.isInteger(totalKop) || totalKop <= 0) throw new RangeError('Некоректна сума замовлення');
    switch (method) {
        case 'online':
            return totalKop;
        case 'cod':
            return Math.min(prepaymentKop, totalKop);
        case 'fop':
            return 0;
        default:
            throw new RangeError('Невідомий спосіб оплати');
    }
}

// Скільки клієнт має сплатити при отриманні (для cod).
export function dueOnDeliveryKop({ totalKop, paidKop = 0, refundedKop = 0 }) {
    return Math.max(0, totalKop - (paidKop - refundedKop));
}
