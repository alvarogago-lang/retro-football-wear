-- =====================================================================
-- La Prima Mery — 004: propuesta de baja por inactividad (6 meses sin pedidos)
-- Ejecutar después de 003_solicitudes.sql. Idempotente.
--
-- Cada día (pg_cron, 07:00 UTC) se revisan los usuarios activos que no son administradores, con la
-- cuenta creada hace más de 6 meses y sin ningún pedido en los últimos 6 meses. Para cada uno se marca
-- la propuesta (profiles.inactive_flag_at) y se avisa a todos los administradores (notificación + copia
-- en el buzón de correo). El administrador decide: dar de baja, eliminar definitivamente o mantener.
-- «Mantener» evita que se vuelva a proponer durante otros 6 meses.
-- =====================================================================

alter table public.profiles add column if not exists inactive_flag_at timestamptz;
alter table public.profiles add column if not exists inactive_kept_at timestamptz;

-- Fecha del último pedido de cada usuario (los pedidos guardan su fecha en data.createdAt).
create or replace function public.last_order_at(p_user uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
  select max((data->>'createdAt')::timestamptz) from public.orders where user_id = p_user;
$$;

create or replace function public.check_inactive_users() returns int
language plpgsql security definer set search_path = public as $$
declare
  u record; a record; n int := 0;
  stamp text := to_char(now(), 'YYYYMMDDHH24MISSMS');
  last_at timestamptz;
begin
  -- quien ha vuelto a pedir deja de estar propuesto
  update public.profiles p set inactive_flag_at = null
  where inactive_flag_at is not null and public.last_order_at(p.id) > now() - interval '6 months';

  for u in
    select p.* from public.profiles p
    where p.active and not p.pending and p.role = 'user'
      and p.created_at < now() - interval '6 months'
      and p.inactive_flag_at is null
      and (p.inactive_kept_at is null or p.inactive_kept_at < now() - interval '6 months')
      and coalesce(public.last_order_at(p.id), '-infinity'::timestamptz) < now() - interval '6 months'
  loop
    last_at := public.last_order_at(u.id);
    update public.profiles set inactive_flag_at = now() where id = u.id;
    n := n + 1;
    for a in select id, email from public.profiles where role = 'admin' and active and not pending loop
      insert into public.notifications (id, data) values ('n_inact_' || stamp || '_' || n || '_' || left(a.id::text, 8), jsonb_build_object(
        'id', 'n_inact_' || stamp || '_' || n || '_' || left(a.id::text, 8), 'to', a.id, 'kind', 'inactive', 'userId', u.id,
        'title', 'Usuario sin pedidos en 6 meses',
        'body', u.name || ' (@' || u.username || ') no ha hecho pedidos en 6 meses. ¿Darlo de baja? Revísalo en Usuarios.',
        'at', now(), 'read', false));
      insert into public.emails (id, data) values ('e_inact_' || stamp || '_' || n || '_' || left(a.id::text, 8), jsonb_build_object(
        'id', 'e_inact_' || stamp || '_' || n || '_' || left(a.id::text, 8), 'toUserId', a.id, 'to', a.email,
        'subject', '[La Prima Mery] Confirmar baja por inactividad: ' || u.name,
        'body', 'Hola:' || chr(10) || chr(10) || u.name || ' (@' || u.username || ', ' || u.email || ') no ha hecho ningún pedido en los últimos 6 meses'
                || case when last_at is null then ' (nunca ha pedido).' else ' (último pedido: ' || to_char(last_at, 'DD/MM/YYYY') || ').' end || chr(10) || chr(10)
                || 'Entra en Usuarios → Propuestas de baja para darlo de baja, eliminarlo definitivamente o mantenerlo.' || chr(10) || chr(10) || '— La Prima Mery',
        'at', now()));
    end loop;
  end loop;
  return n;
end $$;
revoke all on function public.check_inactive_users() from public, anon, authenticated;

-- Decisión del administrador sobre una propuesta: 'keep' (mantener) o 'baja' (dar de baja).
create or replace function public.admin_inactivity_action(p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Solo un administrador puede hacerlo'; end if;
  if p_action = 'keep' then
    update public.profiles set inactive_flag_at = null, inactive_kept_at = now() where id = p_id;
  elsif p_action = 'baja' then
    if public.is_admin_user(p_id) then raise exception 'No se puede dar de baja a un administrador desde aquí'; end if;
    update public.profiles set inactive_flag_at = null, active = false where id = p_id;
  else
    raise exception 'Acción no válida';
  end if;
  update public.notifications set data = data || '{"read": true}' where data->>'kind' = 'inactive' and data->>'userId' = p_id::text;
end $$;
revoke all on function public.admin_inactivity_action(uuid, text) from public, anon;
grant execute on function public.admin_inactivity_action(uuid, text) to authenticated;

-- Tarea diaria
create extension if not exists pg_cron;
do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'lpm-inactividad';
  perform cron.schedule('lpm-inactividad', '0 7 * * *', 'select public.check_inactive_users()');
end $$;
