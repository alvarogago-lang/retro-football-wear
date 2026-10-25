-- =====================================================================
-- Retro Football Wear — 002: primera contraseña por email y recuperación por email o SMS
-- Ejecutar después de schema.sql. Idempotente.
--
-- · Un administrador puede crear cuentas sin contraseña: al intentar entrar por primera vez, el usuario
--   recibe un email para crearla (profiles.needs_password).
-- · Cada cuenta puede tener teléfono para recuperar la contraseña por SMS (si se activa un proveedor de SMS
--   en Supabase y la opción «smsEnabled» en los ajustes de la app).
-- · Cualquier administrador puede crear otros administradores.
-- =====================================================================

alter table public.profiles add column if not exists needs_password boolean not null default false;
alter table public.profiles add column if not exists phone text;

-- Teléfono normalizado tal y como lo guarda Supabase Auth: solo dígitos con prefijo de país (ej. 34600111222).
create or replace function public.normalize_phone(p text) returns text
language sql immutable as $$
  select nullif(case when regexp_replace(coalesce(p, ''), '\D', '', 'g') ~ '^\d{9}$'
                     then '34' || regexp_replace(p, '\D', '', 'g')
                     else regexp_replace(coalesce(p, ''), '\D', '', 'g') end, '');
$$;

-- Estado de una cuenta para la pantalla de acceso (por usuario o email): si debe crear contraseña,
-- y si puede recuperarla por SMS. No revela nada de cuentas desactivadas o inexistentes.
create or replace function public.login_status(p_identifier text)
returns table (email text, needs_password boolean, sms_available boolean)
language sql stable security definer set search_path = public as $$
  select p.email, p.needs_password,
         coalesce(p.phone, '') <> '' and coalesce((select (s.data->>'smsEnabled')::boolean from public.settings s where s.id = 1), false)
  from public.profiles p
  where p.active and (lower(p.username) = lower(trim(p_identifier)) or lower(p.email) = lower(trim(p_identifier)))
  limit 1;
$$;
grant execute on function public.login_status(text) to anon, authenticated;

-- El propio usuario marca que ya ha creado su contraseña.
create or replace function public.mark_password_set() returns void
language sql security definer set search_path = public as $$
  update public.profiles set needs_password = false where id = auth.uid();
$$;
revoke all on function public.mark_password_set() from public, anon;
grant execute on function public.mark_password_set() to authenticated;

-- Alta/edición de usuarios (sustituye a la versión de schema.sql: añade teléfono y contraseña opcional).
drop function if exists public.admin_save_user(uuid, text, text, text, text, text, boolean);
create or replace function public.admin_save_user(
  p_id uuid, p_email text, p_password text, p_name text, p_username text, p_role text,
  p_active boolean default true, p_phone text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions, auth as $$
declare
  uid uuid := coalesce(p_id, gen_random_uuid());
  ph text := public.normalize_phone(p_phone);
  no_pw boolean := coalesce(p_password, '') = '';
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'Solo un administrador puede gestionar usuarios'; end if;
  if p_role not in ('admin', 'user') then raise exception 'Rol no válido'; end if;
  if exists (select 1 from public.profiles where lower(username) = lower(p_username) and id <> uid) then raise exception 'Ese nombre de usuario ya existe'; end if;
  if exists (select 1 from auth.users where lower(email) = lower(p_email) and id <> uid) then raise exception 'Ese email ya está en uso'; end if;
  if ph is not null and exists (select 1 from auth.users where phone = ph and id <> uid) then raise exception 'Ese teléfono ya está en uso'; end if;
  if not no_pw and length(p_password) < 6 then raise exception 'La contraseña debe tener al menos 6 caracteres'; end if;

  if p_id is null then
    insert into auth.users (instance_id, id, aud, role, email, phone, encrypted_password, email_confirmed_at, phone_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, email_change, email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', lower(p_email), ph,
            crypt(case when no_pw then encode(gen_random_bytes(24), 'base64') else p_password end, gen_salt('bf')),
            now(), case when ph is null then null else now() end,
            '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', lower(p_email), 'email_verified', true), 'email', now(), now(), now());
    insert into public.profiles (id, name, username, email, role, active, phone, needs_password)
    values (uid, p_name, p_username, lower(p_email), p_role, p_active, ph, no_pw);
  else
    if p_id = auth.uid() and (p_role <> 'admin' or not p_active) then raise exception 'No puedes quitarte el rol de administrador ni desactivarte'; end if;
    if (p_role <> 'admin' or not p_active) and public.is_admin_user(p_id)
       and (select count(*) from public.profiles where role = 'admin' and active) < 2 then raise exception 'Debe quedar al menos un administrador activo'; end if;
    update public.profiles set name = p_name, username = p_username, email = lower(p_email), role = p_role, active = p_active, phone = ph,
                               needs_password = case when no_pw then needs_password else false end
    where id = p_id;
    update auth.users set email = lower(p_email), phone = ph, phone_confirmed_at = case when ph is null then null else coalesce(phone_confirmed_at, now()) end,
                          updated_at = now() where id = p_id;
    update auth.identities set identity_data = identity_data || jsonb_build_object('email', lower(p_email)) where user_id = p_id and provider = 'email';
    if not no_pw then
      update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = p_id;
    end if;
  end if;
  return uid;
end $$;
revoke all on function public.admin_save_user(uuid, text, text, text, text, text, boolean, text) from public, anon;
grant execute on function public.admin_save_user(uuid, text, text, text, text, text, boolean, text) to authenticated;

-- La cuenta de administrador inicial se creó con una contraseña aleatoria: la crea al entrar por primera vez.
update public.profiles set needs_password = true where username = 'admin' and email = 'alvaro.gago@ecocomputer.net';
update public.settings set data = data || '{"smsEnabled": false}' where id = 1 and not (data ? 'smsEnabled');
