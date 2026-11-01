// La Prima Mery — Edge Function "paypal": cobros reales con PayPal (o tarjeta a través de PayPal).
// El importe lo calcula SIEMPRE el servidor a partir del pedido guardado, y el pedido solo se marca como
// pagado cuando PayPal confirma el cobro (captura COMPLETED). El navegador nunca decide el precio.
//
// Acciones (body.action):
//   create  { orderId }                 → crea la orden de PayPal y devuelve su id
//   capture { orderId, paypalOrderId }  → cobra, registra el pago, avisa a los administradores
//
// Configuración:
//   · Client ID (público): en la app, Ajustes → «PayPal Client ID» (tabla settings).
//   · Secreto PAYPAL_SECRET (Supabase → Edge Functions → Secrets): «Secret» de la app de PayPal.
//   · PAYPAL_ENV opcional: 'sandbox' para pruebas; por defecto, cobros reales ('live').
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const SIZES = ['S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'];
const units = (items: Record<string, number>) => SIZES.reduce((a, s) => a + (Number(items?.[s]) || 0), 0);
// Mismo cálculo que la app (ofertas por % o por lote «lleva N y paga M»).
function offerPrice(offer: any, unitPrice: number, qty: number) {
  if (!offer) return unitPrice * qty;
  if (offer.type === 'units') return (Math.floor(qty / offer.buy) * offer.pay + qty % offer.buy) * unitPrice;
  return Math.round(unitPrice * qty * (100 - offer.percent)) / 100;
}
const itemsText = (items: Record<string, number>) => SIZES.filter((s) => items?.[s]).map((s) => `${s}x${items[s]}`).join(', ');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const env = (k: string) => Deno.env.get(k) ?? '';
    const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await db.auth.getUser(token);
    if (!user) return json({ error: 'Sin sesión' }, 401);
    const { data: me } = await db.from('profiles').select('id, name, email, active, pending').eq('id', user.id).single();
    if (!me?.active || me.pending) return json({ error: 'Tu cuenta no está activa' }, 403);

    const { data: st } = await db.from('settings').select('data').eq('id', 1).single();
    const clientId = String(st?.data?.paypalClientId || '').trim(), secret = env('PAYPAL_SECRET').trim();
    const currency = st?.data?.currency || 'EUR';
    if (!clientId || !secret) return json({ error: 'El pago con PayPal aún no está configurado.', notConfigured: true }, 503);
    const base = env('PAYPAL_ENV') === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

    const auth = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${clientId}:${secret}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!auth.ok) return json({ error: 'PayPal ha rechazado las credenciales (Client ID o Secret). Revisa que sean las de «Live».' }, 502);
    const { access_token } = await auth.json();
    const pp = (path: string, body?: unknown) => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body ? JSON.stringify(body) : undefined,
    });

    const body = await req.json();
    const { data: row } = await db.from('orders').select('data').eq('id', body.orderId).single();
    if (!row) return json({ error: 'Pedido no encontrado' }, 404);
    const o = row.data;
    if (o.userId !== me.id) return json({ error: 'No es tu pedido' }, 403);
    const amount = offerPrice(o.offer, Number(o.unitPrice), units(o.items));
    const value = amount.toFixed(2);

    if (body.action === 'create') {
      if (o.status === 'pagado') return json({ error: 'Este pedido ya está pagado' }, 409);
      if (!(amount > 0)) return json({ error: 'Importe no válido' }, 400);
      const r = await pp('/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: o.id, custom_id: me.id,
          description: `La Prima Mery · ${o.modelName} (${itemsText(o.items)})`.slice(0, 127),
          amount: { currency_code: currency, value },
        }],
      });
      const d = await r.json();
      if (!r.ok) return json({ error: `PayPal no pudo crear el pago: ${d?.message || r.status}` }, 502);
      return json({ id: d.id });
    }

    if (body.action === 'capture') {
      if (o.status === 'pagado') return json({ payment: o.payment, already: true });
      const r = await pp(`/v2/checkout/orders/${encodeURIComponent(body.paypalOrderId)}/capture`);
      const d = await r.json();
      const unit = d?.purchase_units?.[0], cap = unit?.payments?.captures?.[0];
      if (!r.ok || d.status !== 'COMPLETED' || cap?.status !== 'COMPLETED') {
        return json({ error: `El pago no se ha completado (${d?.details?.[0]?.description || d?.message || d?.status || r.status}).` }, 402);
      }
      if (unit.reference_id !== o.id || cap.amount?.value !== value || cap.amount?.currency_code !== currency) {
        return json({ error: 'El importe cobrado no coincide con el pedido. Contacta con La Prima Mery.' }, 409);
      }
      const now = new Date().toISOString();
      const payment = {
        txId: cap.id, method: env('PAYPAL_ENV') === 'sandbox' ? 'PayPal (pruebas)' : 'PayPal',
        payerEmail: d.payer?.email_address || '', payerId: d.payer?.payer_id || null,
        payerName: [d.payer?.name?.given_name, d.payer?.name?.surname].filter(Boolean).join(' ') || me.name,
        paidByUserId: me.id, amount, paidAt: now,
      };
      await db.from('orders').update({ data: { ...o, status: 'pagado', payment, updatedAt: now } }).eq('id', o.id);
      await db.from('payments').upsert({ id: `p_${cap.id}`, data: { id: `p_${cap.id}`, orderId: o.id, userId: o.userId, ...payment } });
      // aviso a los administradores (notificación + copia en el buzón)
      const { data: admins } = await db.from('profiles').select('id, email').eq('role', 'admin').eq('active', true).eq('pending', false);
      for (const a of admins ?? []) {
        const n = `n_pago_${cap.id}_${a.id.slice(0, 8)}`, e = `e_pago_${cap.id}_${a.id.slice(0, 8)}`;
        await db.from('notifications').upsert({ id: n, data: { id: n, to: a.id, title: `Pago recibido: ${o.modelName}`, body: `${me.name} ha pagado ${value} € con PayPal (${itemsText(o.items)}).`, orderId: o.id, at: now, read: false } });
        await db.from('emails').upsert({ id: e, data: { id: e, toUserId: a.id, to: a.email, subject: `[La Prima Mery] Pago recibido: ${o.modelName}`, body: `Hola:\n\n${me.name} ha pagado su pedido de ${o.modelName} (${itemsText(o.items)}).\nImporte: ${value} € · PayPal\nCuenta PayPal: ${payment.payerEmail || '—'} · Transacción ${cap.id}\n\n— La Prima Mery`, orderId: o.id, at: now } });
      }
      return json({ payment });
    }

    return json({ error: 'Acción no válida' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
