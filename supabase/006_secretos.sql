-- =====================================================================
-- La Prima Mery — 006: secretos de la app (p. ej. el Secret de PayPal) guardados desde Ajustes
-- Ejecutar después de 005_contacto.sql. Idempotente.
--
-- La tabla app_secrets NO tiene políticas de acceso: nadie puede leerla desde la app (ni los
-- administradores). Solo las Edge Functions, con la clave de servicio, leen los valores.
-- Los administradores escriben con admin_set_secret y ven si está guardado con admin_secret_status
-- (fecha y últimos 4 caracteres, nunca el valor).
-- =====================================================================

create table if not exists public.app_secrets (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

create or replace function public.admin_set_secret(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Solo un administrador puede guardar estos datos'; end if;
  if p_key not in ('paypal_secret') then raise exception 'Clave no permitida'; end if;
  if coalesce(trim(p_value), '') = '' then
    delete from public.app_secrets where key = p_key;
  else
    insert into public.app_secrets (key, value, updated_at, updated_by) values (p_key, trim(p_value), now(), auth.uid())
    on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
  end if;
end $$;

create or replace function public.admin_secret_status() returns table (key text, hint text, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.key, '…' || right(s.value, 4), s.updated_at from public.app_secrets s where public.is_admin();
$$;

revoke all on function public.admin_set_secret(text, text) from public, anon;
revoke all on function public.admin_secret_status() from public, anon;
grant execute on function public.admin_set_secret(text, text) to authenticated;
grant execute on function public.admin_secret_status() to authenticated;
