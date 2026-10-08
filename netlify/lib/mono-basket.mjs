// Формує basketOrder для invoice/create — monobank зробив це поле обов'язковим для
// фіскалізації. Дві окремі вимоги, з'ясовані на реальних відмовах Mono (не задокументовані
// наперед, тому саме в такому порядку й виявлені):
//  1. errCode INVALID_MERCHANT_PAYM_INFO, "'basketOrder' cannot be empty..." — кошик не може
//     бути порожнім (mono-client.mjs додатково перевіряє це перед запитом).
//  2. errCode INVALID_MERCHANT_PAYM_INFO, "'code' is required" — КОЖЕН рядок кошика мусить
//     мати непорожній `code` (ідентифікатор товару), навіть якщо в нас цього товару нема
//     як окремого id (накладений платіж, коригувальний рядок) — тому нижче code виставляється
//     завжди, з резервним значенням, якщо реального id немає.
// Сума всіх total в кошику МАЄ збігатися із сумою самого інвойсу (amountKop), інакше Mono
// поверне ще одну відмову — через розбіжність сум.
export function buildBasketOrder({ order, amountKop }) {
    if (order.paymentMethod === 'cod') {
        // Передоплата — не повна вартість товару. Клали б реальні товари з повною ціною —
        // сума кошика не збігалась би із сумою інвойсу (саме передоплати). Тому один умовний
        // рядок на всю суму інвойсу, а не розбивка по товарах.
        return [{
            name: `Передоплата за замовлення ${order.orderID}`,
            qty: 1,
            sum: amountKop,
            total: amountKop,
            unit: 'шт.',
            code: 'PREPAYMENT',
        }];
    }

    const items = (order.items || []).map((it, i) => {
        const unitKop = Math.round(Number(it.price) * 100);
        const qty = Number(it.qty) || 1;
        return {
            name: String(it.title ?? 'Товар').slice(0, 128),
            qty,
            sum: unitKop,
            total: unitKop * qty,
            unit: 'шт.',
            code: it.id != null ? String(it.id) : `ITEM-${i + 1}`,
        };
    });

    if (order.packaging) {
        const unitKop = Math.round(Number(order.packaging.price) * 100);
        items.push({
            name: String(order.packaging.title ?? 'Упаковка').slice(0, 128),
            qty: 1,
            sum: unitKop,
            total: unitKop,
            unit: 'шт.',
            code: order.packaging.id != null ? String(order.packaging.id) : 'PACKAGING',
        });
    }

    // Захист від розбіжності (округлення копійок, неповні дані): якщо сума позицій не
    // збігається точно із сумою інвойсу, додаємо коригувальний рядок — безпечніше, ніж
    // ризикнути отримати відмову Mono чи неправильний фіскальний чек.
    const itemsTotal = items.reduce((s, it) => s + it.total, 0);
    const diff = amountKop - itemsTotal;
    if (diff !== 0) {
        items.push({ name: 'Коригування суми', qty: 1, sum: diff, total: diff, unit: 'шт.', code: 'ADJUSTMENT' });
    }

    return items;
}
