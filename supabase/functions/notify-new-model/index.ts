// Retro Football Wear — Edge Function "notify-new-model"
// Envía un email a todos los usuarios activos cuando un administrador publica un modelo nuevo.
// El envío se hace con la API de Brevo (plan gratuito: 300 emails/día).
//
// Secretos necesarios (Supabase → Edge Functions → Secrets):
//   BREVO_API_KEY   clave de API de Brevo (Brevo → SMTP & API → API Keys)
//   MAIL_FROM       email remitente verificado en Brevo
//   MAIL_FROM_NAME  (opcional) nombre del remitente; por defecto "Retro Football Wear"
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase automáticamente.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
// Direcciones de las cuentas de prueba: no se les envía nada para no dañar la reputación del remitente.
const isTestAddress = (e: string) => /@(ejemplo|example)\.(com|org|net)$/i.test(e);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Solo un administrador activo puede lanzar el aviso.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: 'Sin sesión' }, 401);
    const { data: me } = await admin.from('profiles').select('role, active').eq('id', user.id).single();
    if (me?.role !== 'admin' || !me.active) return json({ error: 'Solo un administrador puede avisar a los usuarios' }, 403);

    const apiKey = Deno.env.get('BREVO_API_KEY'), from = Deno.env.get('MAIL_FROM');
    if (!apiKey || !from) return json({ error: 'El envío de emails aún no está configurado (faltan BREVO_API_KEY y MAIL_FROM).', notConfigured: true }, 503);

    const { modelId, appUrl } = await req.json();
    const { data: row } = await admin.from('models').select('data').eq('id', modelId).single();
    if (!row) return json({ error: 'Modelo no encontrado' }, 404);
    const m = row.data, base = String(appUrl || '');
    const cover = m.images?.[0] ? new URL(m.images[0], base || undefined).href : '';
    const price = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(Number(m.price) || 0);

    const { data: users } = await admin.from('profiles').select('name, email').eq('active', true).neq('id', user.id);
    const to = (users ?? []).filter((u) => u.email && !isTestAddress(u.email));
    if (!to.length) return json({ sent: 0, skipped: (users ?? []).length });

    const html = `<!doctype html><html><body style="margin:0;background:#faf8f3;font-family:Arial,Helvetica,sans-serif;color:#14213d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden">
      <tr><td style="padding:20px 24px;background:#14213d;color:#ffffff;font-family:Georgia,serif;font-size:20px;font-weight:bold">Retro <span style="color:#e8b624;font-family:Arial;font-size:12px;letter-spacing:3px">FOOTBALL WEAR</span></td></tr>
      ${cover ? `<tr><td><img src="${esc(cover)}" alt="${esc(m.name)}" width="520" style="display:block;width:100%;height:auto"></td></tr>` : ''}
      <tr><td style="padding:24px">
        <p style="margin:0 0 6px;font-size:13px;color:#b8860b;font-weight:bold;text-transform:uppercase;letter-spacing:1px">Nuevo modelo disponible</p>
        <h1 style="margin:0 0 8px;font-size:22px">${esc(m.name)}</h1>
        <p style="margin:0 0 12px;font-size:15px;color:#475569">${esc(m.description)}</p>
        <p style="margin:0 0 20px;font-size:18px;font-weight:bold">${esc(price)}</p>
        ${base ? `<a href="${esc(base)}" style="display:inline-block;background:#14213d;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:12px">Ver y pedir mi talla</a>` : ''}
      </td></tr>
      <tr><td style="padding:16px 24px;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9">Recibes este aviso porque tienes cuenta en Retro Football Wear. Si no quieres recibirlos, díselo al administrador.</td></tr>
    </table>
  </td></tr></table></body></html>`;

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: from, name: Deno.env.get('MAIL_FROM_NAME') || 'Retro Football Wear' },
        subject: `Nuevo modelo: ${m.name}`,
        htmlContent: html,
        // una versión por destinatario: cada uno recibe su propio email sin ver a los demás
        messageVersions: to.map((u) => ({ to: [{ email: u.email, name: u.name }] })),
      }),
    });
    if (!res.ok) return json({ error: `Brevo respondió ${res.status}: ${await res.text()}` }, 502);
    return json({ sent: to.length, skipped: (users ?? []).length - to.length });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
