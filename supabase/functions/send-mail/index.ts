// La Prima Mery — Edge Function "send-mail"
// Envía los emails de la app desde la cuenta de Gmail de La Prima Mery (SMTP, puerto 465).
//
// Tipos (body.type):
//   contact  → la consulta (o la nueva respuesta del usuario) a todos los administradores activos
//   reply    → la respuesta de un administrador al usuario de la consulta
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
    const send = (to: string | string[], subject: string, html: string, replyTo?: string) =>
      transport.sendMail({ from: sender, to, subject, html, replyTo });

    const body = await req.json();
    const appUrl = String(body.appUrl || '').split('?')[0];

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

      if (body.type === 'contact') {
        if (t.userId !== me.id) return json({ error: 'No es tu consulta' }, 403);
        const { data: admins } = await admin.from('profiles').select('email').eq('role', 'admin').eq('active', true).eq('pending', false);
        const to = (admins ?? []).map((a) => a.email).filter((e) => e && !isTestAddress(e));
        if (!to.length) return json({ sent: 0 });
        const first = (t.messages ?? []).length === 1;
        await send(to, `[La Prima Mery] ${first ? 'Nueva consulta' : 'Nueva respuesta'} de ${me.name}: ${t.subject}`,
          layout(first ? 'Nueva consulta' : 'El usuario ha respondido',
            `<p style="margin:0 0 10px"><b>${esc(me.name)}</b> (@${esc(me.username)}) ${first ? 'ha enviado una consulta' : 'ha escrito en su consulta'} «<b>${esc(t.subject)}</b>»:</p>${quote(last.body)}`,
            appUrl ? { href: appUrl, text: 'Responder en la app' } : undefined),
          me.email);
        return json({ sent: to.length });
      }
      if (!isAdmin) return json({ error: 'Solo administradores' }, 403);
      if (!owner?.email || isTestAddress(owner.email)) return json({ sent: 0 });
      await send(owner.email, `[La Prima Mery] Respuesta a tu consulta: ${t.subject}`,
        layout('Tienes una respuesta', `<p style="margin:0 0 10px">Hola ${esc((owner.name || '').split(' ')[0])}, te hemos respondido a tu consulta «<b>${esc(t.subject)}</b>»:</p>${quote(last.body)}`,
          appUrl ? { href: appUrl, text: 'Ver la conversación' } : undefined));
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
