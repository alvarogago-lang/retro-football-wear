// La Prima Mery — Edge Function "send-mail"
// Envía los emails de la app desde la cuenta de Gmail de La Prima Mery (SMTP, puerto 465).
//
// Tipos (body.type):
//   contact   → mensaje del usuario a todos los administradores activos (copia oculta a la cuenta de la app)
//   reply     → mensaje de un administrador al usuario (copia oculta a la cuenta de la app y al resto de admins)
//   broadcast → { modelId, kind: 'new-model' | 'offer' } modelo nuevo u oferta a todos los usuarios activos (CCO, tandas de 50)
//   order       → solicitud nueva: «Hemos recibido tu solicitud» al usuario y aviso a los administradores
//   approve     → el administrador aprueba la solicitud: instrucciones de pago (texto fijo) e importe al usuario
//   paid-notice → el usuario dice que ya ha pagado: el pedido pasa a «pago_comunicado» y se avisa a los administradores
//   confirm     → el administrador valida el pago: fecha de entrega al usuario
//   (todos con copia oculta a la cuenta de La Prima Mery)
//   invite   → invitación de un usuario a un amigo, con enlace a «Crear cuenta» (máx. 10 al día por usuario)
//   test     → email de prueba al administrador que la llama
//
// Secretos (Supabase → Edge Functions → Secrets):
//   GMAIL_APP_PASSWORD  contraseña de aplicación de Google (16 letras) de laprimamery@gmail.com; la pega el usuario
//                       (SMTP_PASS se acepta como nombre antiguo). NO sirve la contraseña normal de la cuenta.
//   MAIL_SENDER     (opcional) remitente; por defecto laprimamery@gmail.com   MAIL_FROM_NAME  La Prima Mery (opcional)
//   SMTP_HOST / SMTP_PORT / SMTP_USER  opcionales: smtp.gmail.com / 465 / remitente
import nodemailer from 'npm:nodemailer@6.9.16';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const nl2br = (s: unknown) => esc(s).replace(/\n/g, '<br>');
const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
// Pago fuera de la app (mismo texto que en index.html)
const PAYPAL_ACCOUNT = 'daniordo191119@icloud.com';
const APPROVAL_TEXT = `Su solicitud ha sido aprobada. Para finalizar el pedido haga el depósito a través de PayPal a la cuenta ${PAYPAL_ACCOUNT}. Una vez realizado el pago solicite en sus pedidos la confirmación del mismo y en cuanto reciba la notificación de que el pago se ha realizado de forma correcta recibirá el producto en la fecha que el admin indique al validar la confirmación del pago.`;
const isTestAddress = (e: string) => /@(ejemplo|example)\.(com|org|net)$/i.test(e);

// Plantilla común con la imagen de La Prima Mery
function layout(title: string, inner: string, button?: { href: string; text: string }) {
  return `<!doctype html><html><body style="margin:0;background:#faf6ee;font-family:Arial,Helvetica,sans-serif;color:#2a1410">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" style="max-width:540px;background:#ffffff;border-radius:16px;overflow:hidden">
      <tr><td style="height:4px;background:#7b1e2e"></td></tr>
      <tr><td style="padding:22px 24px 4px;font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#7b1e2e">La Prima Mery<div style="font-family:Arial;font-size:10px;letter-spacing:3px;color:#8f7020;margin-top:4px">EQUIPACIÓN HISTÓRICA</div></td></tr>
      <tr><td style="padding:14px 24px 24px;font-size:15px;line-height:1.55">
        <h1 style="margin:0 0 12px;font-size:18px;color:#2a1410">${esc(title)}</h1>
        ${inner}
        ${button ? `<p style="margin:20px 0 0"><a href="${esc(button.href)}" style="display:inline-block;background:#7b1e2e;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:12px">${esc(button.text)}</a></p>` : ''}
      </td></tr>
      <tr><td style="padding:14px 24px;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9">La Prima Mery · Equipación histórica</td></tr>
    </table>
  </td></tr></table></body></html>`;
}
const quote = (body: string) => `<div style="margin:0 0 4px;padding:12px 14px;background:#faf6ee;border-left:3px solid #c9a23a;border-radius:6px">${nl2br(body)}</div>`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const env = (k: string) => Deno.env.get(k) ?? '';
    const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: 'Sin sesión' }, 401);
    const { data: me } = await admin.from('profiles').select('id, name, username, email, role, active, pending').eq('id', user.id).single();
    if (!me?.active || me.pending) return json({ error: 'Tu cuenta no está activa' }, 403);
    const isAdmin = me.role === 'admin';

    const from = env('MAIL_SENDER') || 'laprimamery@gmail.com', pass = (env('GMAIL_APP_PASSWORD') || env('SMTP_PASS')).replace(/\s+/g, ''); // Google la muestra en grupos de 4: se quitan espacios y saltos de línea
    if (!pass) return json({ error: 'El correo de la app aún no está configurado.', notConfigured: true }, 503);
    const transport = nodemailer.createTransport({
      host: env('SMTP_HOST') || 'smtp.gmail.com', port: Number(env('SMTP_PORT') || 465), secure: true,
      auth: { user: env('SMTP_USER') || from, pass },
    });
    const sender = { name: env('MAIL_FROM_NAME') || 'La Prima Mery', address: from };
    const send = (to: string | string[], subject: string, html: string, replyTo?: string, bcc?: string[]) =>
      transport.sendMail({ from: sender, to, subject, html, replyTo, bcc: bcc?.length ? bcc : undefined });

    const body = await req.json();
    const appUrl = String(body.appUrl || '').split('?')[0];
    const money = (n: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n || 0);
    const absUrl = (src: string) => { try { return new URL(src, appUrl || undefined).href; } catch { return ''; } };
    const SIZES = ['S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'];
    const units = (it: Record<string, number>) => SIZES.reduce((a, s) => a + (Number(it?.[s]) || 0), 0);
    const itemsText = (it: Record<string, number>) => SIZES.filter((s) => it?.[s]).map((s) => `${s}×${it[s]}`).join(', ');
    const offerPrice = (o: any, p: number, q: number) => !o ? p * q : o.type === 'units' ? (Math.floor(q / o.buy) * o.pay + q % o.buy) * p : Math.round(p * q * (100 - o.percent)) / 100;
    const offerText = (o: any) => o.type === 'units' ? `${o.buy}x${o.pay}: lleva ${o.buy} y paga ${o.pay}` : `${o.percent}% de descuento${o.type === 'time' && o.endsAt ? ` hasta el ${new Date(o.endsAt).toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Madrid' })}` : ''}`;
    const activeAdmins = async () => ((await admin.from('profiles').select('id, email').eq('role', 'admin').eq('active', true).eq('pending', false)).data ?? [])
      .filter((a) => a.email && !isTestAddress(a.email));

    if (body.type === 'test') {
      if (!isAdmin) return json({ error: 'Solo administradores' }, 403);
      await send(me.email, 'Prueba de correo · La Prima Mery', layout('El correo funciona', '<p style="margin:0">Este es un email de prueba de La Prima Mery. Si lo recibes, el envío de emails está bien configurado.</p>'));
      return json({ sent: 1 });
    }

    if (body.type === 'contact' || body.type === 'reply') {
      const { data: row } = await admin.from('contact').select('data').eq('id', body.threadId).single();
      if (!row) return json({ error: 'Consulta no encontrada' }, 404);
      const t = row.data, last = (t.messages ?? []).at(-1);
      if (!last) return json({ error: 'Consulta vacía' }, 400);
      const { data: owner } = await admin.from('profiles').select('name, email').eq('id', t.userId).single();

      // Todos los mensajes llegan también, en copia oculta, a la cuenta de La Prima Mery.
      const admins = (await activeAdmins()).map((a) => a.email);
      if (body.type === 'contact') {
        if (t.userId !== me.id) return json({ error: 'No es tu consulta' }, 403);
        const first = (t.messages ?? []).length === 1;
        const to = admins.length ? admins : [from];
        await send(to, `[La Prima Mery] ${first ? 'Nueva consulta' : 'Nuevo mensaje'} de ${me.name}: ${t.subject}`,
          layout(first ? 'Nueva consulta' : 'Nuevo mensaje del usuario',
            `<p style="margin:0 0 10px"><b>${esc(me.name)}</b> (@${esc(me.username)}) ${first ? 'ha enviado una consulta' : 'ha escrito en su conversación'} «<b>${esc(t.subject)}</b>»:</p>${quote(last.body)}`,
            appUrl ? { href: appUrl, text: 'Responder en la app' } : undefined),
          me.email, [from]);
        return json({ sent: to.length });
      }
      if (!isAdmin) return json({ error: 'Solo administradores' }, 403);
      if (!owner?.email || isTestAddress(owner.email)) return json({ sent: 0 });
      const started = (t.messages ?? []).length === 1; // conversación iniciada por un administrador
      await send(owner.email, `[La Prima Mery] ${started ? 'Mensaje' : 'Respuesta'}: ${t.subject}`,
        layout(started ? 'Tienes un mensaje de La Prima Mery' : 'Tienes una respuesta',
          `<p style="margin:0 0 10px">Hola ${esc((owner.name || '').split(' ')[0])}, ${started ? 'te escribimos sobre' : 'te hemos respondido en'} «<b>${esc(t.subject)}</b>»:</p>${quote(last.body)}`,
          appUrl ? { href: appUrl, text: 'Ver la conversación y responder' } : undefined),
        undefined, [from, ...admins.filter((e) => e !== me.email)]);
      return json({ sent: 1 });
    }

    // Modelo nuevo u oferta: a todos los usuarios activos, en copia oculta y por tandas.
    if (body.type === 'broadcast') {
      if (!isAdmin) return json({ error: 'Solo administradores' }, 403);
      const { data: row } = await admin.from('models').select('data').eq('id', body.modelId).single();
      if (!row) return json({ error: 'Modelo no encontrado' }, 404);
      const m = row.data, isOffer = body.kind === 'offer';
      if (isOffer && !m.offer?.active) return json({ error: 'El modelo no tiene una oferta activa' }, 400);
      const { data: users } = await admin.from('profiles').select('email').eq('active', true).eq('pending', false).neq('role', 'admin');
      const list = [...new Set((users ?? []).map((u) => u.email).filter((e) => e && !isTestAddress(e)))];
      if (!list.length) return json({ sent: 0 });
      const cover = m.images?.[0] ? absUrl(m.images[0]) : '';
      const price = isOffer && m.offer.type !== 'units'
        ? `<s style="color:#94a3b8;font-weight:normal">${money(m.price)}</s> ${money(offerPrice(m.offer, m.price, 1))}` : money(m.price);
      const html = layout(isOffer ? `¡Oferta en ${m.name}!` : `Nuevo modelo: ${m.name}`,
        `${cover ? `<img src="${esc(cover)}" alt="${esc(m.name)}" width="492" style="display:block;width:100%;height:auto;border-radius:12px;margin:0 0 14px">` : ''}
         ${isOffer ? `<p style="margin:0 0 10px;display:inline-block;background:#7b1e2e;color:#fff;font-weight:bold;padding:6px 12px;border-radius:8px">OFERTA · ${esc(offerText(m.offer))}</p>` : ''}
         <p style="margin:0 0 10px">${esc(m.description)}</p>
         <p style="margin:0;font-size:18px;font-weight:bold">${price}</p>`,
        appUrl ? { href: appUrl, text: 'Ver y pedir mi talla' } : undefined);
      const subject = isOffer ? `Oferta en La Prima Mery: ${m.name}` : `Nuevo modelo en La Prima Mery: ${m.name}`;
      for (let i = 0; i < list.length; i += 50) await send(from, subject, html, undefined, list.slice(i, i + 50));
      return json({ sent: list.length });
    }

    // Pedidos: solicitud, aprobación, aviso de pago del usuario y validación del pago.
    if (['order', 'approve', 'paid-notice', 'confirm'].includes(body.type)) {
      const { data: row } = await admin.from('orders').select('data').eq('id', body.orderId).single();
      if (!row) return json({ error: 'Pedido no encontrado' }, 404);
      const o = row.data;
      const ownerOnly = body.type === 'order' || body.type === 'paid-notice';
      if (ownerOnly && o.userId !== me.id) return json({ error: 'No es tu pedido' }, 403);
      if (!ownerOnly && !isAdmin) return json({ error: 'Solo administradores' }, 403);
      const { data: owner } = await admin.from('profiles').select('name, username, email').eq('id', o.userId).single();
      const total = offerPrice(o.offer, Number(o.unitPrice), units(o.items));
      const summary = `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 12px;font-size:14px">
        <tr><td style="padding:6px 0;color:#64748b">Modelo</td><td style="padding:6px 0;text-align:right"><b>${esc(o.modelName)}</b></td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Tallas</td><td style="padding:6px 0;text-align:right">${esc(itemsText(o.items))}</td></tr>
        ${o.offer ? `<tr><td style="padding:6px 0;color:#64748b">Oferta</td><td style="padding:6px 0;text-align:right">${esc(offerText(o.offer))}</td></tr>` : ''}
        <tr><td style="padding:6px 0;color:#64748b">Importe</td><td style="padding:6px 0;text-align:right;font-size:16px"><b>${money(total)}</b></td></tr></table>`;
      const hi = `<p style="margin:0 0 10px">Hola ${esc((owner?.name || '').split(' ')[0])}:</p>`;
      const btn = appUrl ? { href: appUrl, text: 'Ver mis pedidos' } : undefined;
      const adminBtn = appUrl ? { href: appUrl, text: 'Abrir la app' } : undefined;
      const toUser = owner?.email && !isTestAddress(owner.email);
      const admins = (await activeAdmins()).map((a) => a.email);
      const toAdmins = (subject: string, html: string) => send(admins.length ? admins : [from], subject, html, owner?.email, admins.length ? [from] : undefined);
      const who = `<b>${esc(owner?.name)}</b> (@${esc(owner?.username)})`;

      if (body.type === 'order') {
        let sent = 0;
        if (toUser) {
          await send(owner.email, 'Hemos recibido tu solicitud · La Prima Mery',
            layout('Hemos recibido tu solicitud', `${hi}<p style="margin:0 0 12px">Gracias por tu solicitud. Estos son los detalles:</p>${summary}
              <p style="margin:0">Te avisaremos cuando la aprobemos, con las instrucciones para hacer el pago.</p>`, btn), undefined, [from]);
          sent++;
        }
        await toAdmins(`[La Prima Mery] Nueva solicitud de ${owner?.name}: ${o.modelName}`,
          layout('Nueva solicitud', `<p style="margin:0 0 10px">${who} ha solicitado:</p>${summary}<p style="margin:0">Apruébala en la pestaña Pedidos de la app.</p>`, adminBtn));
        return json({ sent: sent + 1 });
      }

      if (body.type === 'approve') {
        if (!toUser) return json({ sent: 0 });
        const extra = o.approval?.message ? quote(o.approval.message) : '';
        await send(owner.email, `Solicitud aprobada: ${o.modelName} · La Prima Mery`,
          layout('Su solicitud ha sido aprobada', `${hi}<p style="margin:0 0 12px">${esc(APPROVAL_TEXT)}</p>${summary}${extra}`, btn), undefined, [from]);
        return json({ sent: 1 });
      }

      if (body.type === 'paid-notice') {
        if (o.status !== 'aprobado') return json({ error: 'Este pedido no está pendiente de pago' }, 409);
        const now = new Date().toISOString();
        const { error } = await admin.from('orders').update({ data: { ...o, status: 'pago_comunicado', paymentNotice: { at: now }, updatedAt: now } }).eq('id', o.id);
        if (error) return json({ error: error.message }, 500);
        try {
          await toAdmins(`[La Prima Mery] Pago comunicado por ${owner?.name}: ${o.modelName}`,
            layout('Un usuario dice que ya ha pagado', `<p style="margin:0 0 10px">${who} dice que ya ha hecho el depósito por PayPal a ${esc(PAYPAL_ACCOUNT)}:</p>${summary}
              <p style="margin:0">Comprueba que el pago ha llegado y valídalo en la pestaña Pedidos indicando la fecha de entrega.</p>`, adminBtn));
        } catch (e) {
          return json({ statusChanged: true, mailError: String((e as Error)?.message ?? e) });
        }
        return json({ statusChanged: true, sent: 1 });
      }

      // confirm: pago validado
      if (!toUser) return json({ sent: 0 });
      const d = o.delivery || {};
      const when = d.date ? new Date(d.date + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' }) : '';
      await send(owner.email, `Pago confirmado: ${o.modelName} · La Prima Mery`,
        layout('El pago se ha realizado correctamente', `${hi}<p style="margin:0 0 12px">Hemos comprobado el pago de tu pedido.</p>${summary}
          ${when ? `<p style="margin:0 0 12px;font-size:16px"><b>Recibirás el producto el ${esc(when)}.</b></p>` : ''}${d.message ? quote(d.message) : ''}`, btn), undefined, [from]);
      return json({ sent: 1 });
    }

    if (body.type === 'invite') {
      const to = String(body.to || '').trim().toLowerCase();
      if (!isEmail(to)) return json({ error: 'Escribe un email válido' }, 400);
      const { data: exists } = await admin.from('profiles').select('id').ilike('email', to).maybeSingle();
      if (exists) return json({ alreadyUser: true });
      const { count } = await admin.from('invitations').select('id', { count: 'exact', head: true })
        .eq('user_id', me.id).gte('at', new Date(Date.now() - 864e5).toISOString());
      if ((count ?? 0) >= 10) return json({ error: 'Has llegado al máximo de 10 invitaciones al día. Prueba mañana.' }, 429);
      const friend = String(body.friendName || '').trim().slice(0, 60), note = String(body.note || '').trim().slice(0, 500);
      await send(to, `${me.name} te invita a La Prima Mery`,
        layout(`${me.name} te invita a La Prima Mery`,
          `<p style="margin:0 0 10px">Hola${friend ? ' ' + esc(friend) : ''}:</p>
           <p style="margin:0 0 10px"><b>${esc(me.name)}</b> te invita a <b>La Prima Mery</b>, la app para pedir réplicas de equipaciones históricas de fútbol: camisetas, pantalones y chaquetas, en tu talla.</p>
           ${note ? quote(note) : ''}
           <p style="margin:12px 0 0">Crea tu cuenta con el botón. Un administrador la validará y recibirás un email para crear tu contraseña.</p>`,
          { href: `${appUrl}?registro`, text: 'Crear mi cuenta' }), me.email);
      await admin.from('invitations').insert({ user_id: me.id, email: to });
      return json({ sent: 1 });
    }

    return json({ error: 'Tipo de envío no válido' }, 400);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return json({ error: /Invalid login|535|Username and Password not accepted|BadCredentials/i.test(msg) ? `Gmail ha rechazado la contraseña de aplicación (GMAIL_APP_PASSWORD). Detalle: ${msg.slice(0, 160)}` : msg }, 500);
  }
});
