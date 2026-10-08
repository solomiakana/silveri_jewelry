// Формує basketOrder для invoice/create — monobank зробив це поле обов'язковим для
// фіскалізації ("'basketOrder' cannot be empty, it is mandatory for fiscalization and
// split payments", errCode INVALID_MERCHANT_PAYM_INFO). Сума всіх total в кошику МАЄ
// збігатися із сумою самого інвойсу (amountKop), інакше Mono знову поверне bad_request.
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
        }];
    }

    const items = (order.items || []).map((it) => {
        const unitKop = Math.round(Number(it.price) * 100);
        const qty = Number(it.qty) || 1;
        const item = {
            name: String(it.title ?? 'Товар').slice(0, 128),
            qty,
            sum: unitKop,
            total: unitKop * qty,
            unit: 'шт.',
        };
        if (it.id != null) item.code = String(it.id);
        return item;
    });

    if (order.packaging) {
        const unitKop = Math.round(Number(order.packaging.price) * 100);
        const item = {
            name: String(order.packaging.title ?? 'Упаковка').slice(0, 128),
            qty: 1,
            sum: unitKop,
            total: unitKop,
            unit: 'шт.',
        };
        if (order.packaging.id != null) item.code = String(order.packaging.id);
        items.push(item);
    }

    // Захист від розбіжності (округлення копійок, неповні дані): якщо сума позицій не
    // збігається точно із сумою інвойсу, додаємо коригувальний рядок — безпечніше, ніж
    // ризикнути отримати відмову Mono чи неправильний фіскальний чек.
    const itemsTotal = items.reduce((s, it) => s + it.total, 0);
    const diff = amountKop - itemsTotal;
    if (diff !== 0) {
        items.push({ name: 'Коригування суми', qty: 1, sum: diff, total: diff, unit: 'шт.' });
    }

    return items;
}
