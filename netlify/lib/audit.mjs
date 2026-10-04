// Незмінний журнал дій адміна над платежами (архітектурний опис, 4.5). Лише додавання.
export async function writeAudit(db, { actorUid, actorEmail = null, action, orderID = null, invoiceId = null, req = null, details = null }) {
    await db.collection('audit_log').add({
        at: new Date(),
        actorUid,
        actorEmail,
        action,
        orderID,
        invoiceId,
        ip: req?.headers.get('x-nf-client-connection-ip') ?? null,
        userAgent: req?.headers.get('user-agent') ?? null,
        details,
    }).catch((e) => console.error('audit_log write failed:', e)); // best-effort: не блокуємо основну операцію
}
