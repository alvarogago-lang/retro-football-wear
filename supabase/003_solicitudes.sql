-- =====================================================================
-- La Prima Mery — 003: solicitudes de cuenta validadas por un administrador
-- Ejecutar después de 002_contrasenas.sql. Idempotente.
--
-- Flujo:
--  1. El usuario rellena «Crear cuenta» (nombre, usuario, email y teléfono). La app llama a
--     supabase.auth.signUp con esos datos y una contraseña aleatoria que nadie conoce.
--     Supabase envía el email «Confirm signup» (texto: solicitud recibida, pendiente de validación).
--  2. El disparador de abajo crea el perfil como PENDIENTE (inactivo) y avisa a los administradores.
--  3. Un administrador aprueba (admin_approve_user) o rechaza (admin_delete_user).
--  4. Al aprobar, la app envía el email de contraseña («Reset password»): el usuario la crea y entra.
--
-- Además, todo el acceso a datos exige un perfil ACTIVO (is_active): una cuenta pendiente o
-- desactivada no puede ver el catálogo ni pedir aunque consiga iniciar sesión.
-- =====================================================================

alter table public.profiles add column if not exists pending boolean not null default false;

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and not pending);
$$;

-- Comprobación previa para el formulario (mensajes claros antes de crear nada).
create or replace function public.signup_check(p_username text, p_email text) returns text
language sql stable security definer set search_path = public, auth as $$
  select case
    when coalesce(trim(p_username), '') !~ '^[A-Za-z0-9._-]{3,30}$' then 'El usuario debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo.'
    when exists (select 1 from public.profiles where lower(username) = lower(trim(p_username))) then 'Ese nombre de usuario ya está cogido. Prueba con otro.'
    when exists (select 1 from auth.users where lower(email) = lower(trim(p_email))) then 'Ya existe una cuenta o una solicitud con ese email. Si es tuya, usa «¿Olvidaste tu contraseña?».'
    else null end;
$$;
grant execute on function public.signup_check(text, text) to anon, authenticated;

-- Al registrarse alguien desde «Crear cuenta», se crea su perfil pendiente y se avisa a los administradores.
create or replace function public.on_signup_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}');
  uname text := trim(meta->>'username');
  fname text := trim(meta->>'name');
  ph text := public.normalize_phone(meta->>'phone');
  a record;
  stamp text := to_char(now(), 'YYYYMMDDHH24MISSMS');
begin
  if coalesce(meta->>'signup_request', '') <> 'true' then return new; end if;
  if coalesce(fname, '') = '' or coalesce(uname, '') = '' or ph is null then raise exception 'Faltan datos obligatorios'; end if;
  if exists (select 1 from public.profiles where lower(username) = lower(uname)) then raise exception 'Ese nombre de usuario ya existe'; end if;

  insert into public.profiles (id, name, username, email, role, active, pending, phone, needs_password)
  values (new.id, fname, uname, lower(new.email), 'user', false, true, ph, true);

  for a in select id from public.profiles where role = 'admin' and active and not pending loop
    insert into public.notifications (id, data) values ('n_sol_' || stamp || '_' || left(a.id::text, 8), jsonb_build_object(
      'id', 'n_sol_' || stamp || '_' || left(a.id::text, 8), 'to', a.id, 'kind', 'signup', 'userId', new.id,
      'title', 'Nueva solicitud de cuenta',
      'body', fname || ' (@' || uname || ') quiere crear una cuenta. Revísala en Usuarios.',
      'at', now(), 'read', false));
    insert into public.emails (id, data) values ('e_sol_' || stamp || '_' || left(a.id::text, 8), jsonb_build_object(
      'id', 'e_sol_' || stamp || '_' || left(a.id::text, 8), 'toUserId', a.id,
      'to', (select email from public.profiles where id = a.id),
      'subject', '[La Prima Mery] Nueva solicitud de cuenta: ' || fname,
      'body', 'Hola:' || chr(10) || chr(10) || fname || ' ha solicitado una cuenta.' || chr(10)
              || 'Usuario: @' || uname || chr(10) || 'Email: ' || lower(new.email) || chr(10) || 'Teléfono: +' || ph || chr(10) || chr(10)
              || 'Apruébala o recházala en la pestaña Usuarios → Solicitudes pendientes.' || chr(10) || chr(10) || '— La Prima Mery',
      'at', now()));
  end loop;
  return new;
end $$;

drop trigger if exists on_signup_request on auth.users;
create trigger on_signup_request after insert on auth.users for each row execute function public.on_signup_request();

-- Aprobar una solicitud: la cuenta pasa a activa (como cualquier usuario creado por un administrador).
create or replace function public.admin_approve_user(p_id uuid) returns text
language plpgsql security definer set search_path = public, auth as $$
declare p public.profiles;
begin
  if not public.is_admin() then raise exception 'Solo un administrador puede validar cuentas'; end if;
  select * into p from public.profiles where id = p_id and pending;
  if not found then raise exception 'Esa solicitud ya no está pendiente'; end if;
  update public.profiles set pending = false, active = true, needs_password = true where id = p_id;
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()),
         phone = case when p.phone is not null and not exists (select 1 from auth.users where phone = p.phone and id <> p_id) then p.phone else phone end,
         phone_confirmed_at = case when p.phone is not null then coalesce(phone_confirmed_at, now()) else phone_confirmed_at end,
         updated_at = now()
  where id = p_id;
  update public.notifications set data = data || '{"read": true}' where data->>'kind' = 'signup' and data->>'userId' = p_id::text;
  return p.email;
end $$;
revoke all on function public.admin_approve_user(uuid) from public, anon;
grant execute on function public.admin_approve_user(uuid) to authenticated;

-- La pantalla de acceso distingue las cuentas pendientes de validación.
drop function if exists public.login_status(text);
create or replace function public.login_status(p_identifier text)
returns table (email text, needs_password boolean, sms_available boolean, pending boolean)
language sql stable security definer set search_path = public as $$
  select p.email, p.needs_password,
         coalesce(p.phone, '') <> '' and coalesce((select (s.data->>'smsEnabled')::boolean from public.settings s where s.id = 1), false),
         p.pending
  from public.profiles p
  where (p.active or p.pending) and (lower(p.username) = lower(trim(p_identifier)) or lower(p.email) = lower(trim(p_identifier)))
  limit 1;
$$;
grant execute on function public.login_status(text) to anon, authenticated;

-- El inicio de sesión por usuario no debe resolver cuentas pendientes.
create or replace function public.email_for_username(p_username text) returns text
language sql stable security definer set search_path = public as $$
  select email from public.profiles where lower(username) = lower(trim(p_username)) and active and not pending limit 1;
$$;

-- Las reglas de acceso exigen ahora un perfil activo (además de lo que ya pedían).
drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select to authenticated using (public.is_active());
drop policy if exists models_read on public.models;
create policy models_read on public.models for select to authenticated using (public.is_active());
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated using (public.is_active());
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select to authenticated using ((user_id = auth.uid() and public.is_active()) or public.is_admin());
drop policy if exists orders_insert on public.orders;
create policy orders_insert on public.orders for insert to authenticated with check ((user_id = auth.uid() and status = 'pendiente' and public.is_active()) or public.is_admin());
drop policy if exists orders_update on public.orders;
create policy orders_update on public.orders for update to authenticated
  using ((user_id = auth.uid() and status = 'pendiente' and public.is_active()) or public.is_admin())
  with check ((user_id = auth.uid() and public.is_active()) or public.is_admin());
drop policy if exists orders_delete on public.orders;
create policy orders_delete on public.orders for delete to authenticated using ((user_id = auth.uid() and status = 'pendiente' and public.is_active()) or public.is_admin());
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select to authenticated using ((user_id = auth.uid() and public.is_active()) or public.is_admin());
drop policy if exists payments_insert on public.payments;
create policy payments_insert on public.payments for insert to authenticated with check ((user_id = auth.uid() and public.is_active()) or public.is_admin());
drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications for insert to authenticated with check (public.is_admin() or (public.is_active() and public.is_admin_user(to_user)));
drop policy if exists emails_insert on public.emails;
create policy emails_insert on public.emails for insert to authenticated with check (public.is_admin() or (public.is_active() and public.is_admin_user(to_user)));
