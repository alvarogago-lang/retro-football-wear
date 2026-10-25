-- =====================================================================
-- Retro Football Wear — esquema de Supabase
-- Ejecutar una vez en el SQL Editor del proyecto. Es idempotente: se puede volver a lanzar.
--
-- Diseño: cada entidad de la app se guarda tal cual en una columna jsonb "data" (mismo formato que
-- usa el cliente) y las columnas que necesitan las reglas de seguridad (RLS) se generan a partir de ella.
-- Los usuarios viven en auth.users (inicio de sesión) + public.profiles (nombre, rol, estado).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- tablas ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  username text not null unique,
  email text not null,
  role text not null default 'user' check (role in ('admin', 'user')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.categories (id text primary key, data jsonb not null);
create table if not exists public.models     (id text primary key, data jsonb not null);
create table if not exists public.orders (
  id text primary key, data jsonb not null,
  user_id uuid generated always as ((data->>'userId')::uuid) stored,
  status text generated always as (data->>'status') stored
);
create table if not exists public.payments (
  id text primary key, data jsonb not null,
  user_id uuid generated always as ((data->>'userId')::uuid) stored
);
create table if not exists public.notifications (
  id text primary key, data jsonb not null,
  to_user uuid generated always as ((data->>'to')::uuid) stored
);
create table if not exists public.emails (
  id text primary key, data jsonb not null,
  to_user uuid generated always as ((data->>'toUserId')::uuid) stored
);
create table if not exists public.settings (id int primary key default 1 check (id = 1), data jsonb not null default '{}');

create index if not exists orders_user_idx on public.orders (user_id);
create index if not exists notifications_to_idx on public.notifications (to_user);
create index if not exists emails_to_idx on public.emails (to_user);

-- ---------- utilidades ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active);
$$;

create or replace function public.is_admin_user(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = uid and role = 'admin' and active);
$$;

-- Permite iniciar sesión con el nombre de usuario: devuelve el email asociado (solo de cuentas activas).
create or replace function public.email_for_username(p_username text) returns text
language sql stable security definer set search_path = public as $$
  select email from public.profiles where lower(username) = lower(trim(p_username)) and active limit 1;
$$;

-- Alta o edición de usuarios por el administrador (también desde el SQL Editor, donde auth.uid() es nulo).
create or replace function public.admin_save_user(
  p_id uuid, p_email text, p_password text, p_name text, p_username text, p_role text, p_active boolean default true
) returns uuid
language plpgsql security definer set search_path = public, extensions, auth as $$
declare uid uuid := coalesce(p_id, gen_random_uuid());
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'Solo el administrador puede gestionar usuarios'; end if;
  if p_role not in ('admin', 'user') then raise exception 'Rol no válido'; end if;
  if exists (select 1 from public.profiles where lower(username) = lower(p_username) and id <> uid) then raise exception 'Ese nombre de usuario ya existe'; end if;
  if exists (select 1 from auth.users where lower(email) = lower(p_email) and id <> uid) then raise exception 'Ese email ya está en uso'; end if;

  if p_id is null then
    if coalesce(length(p_password), 0) < 6 then raise exception 'La contraseña debe tener al menos 6 caracteres'; end if;
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, email_change, email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', lower(p_email),
            crypt(p_password, gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', lower(p_email), 'email_verified', true), 'email', now(), now(), now());
    insert into public.profiles (id, name, username, email, role, active) values (uid, p_name, p_username, lower(p_email), p_role, p_active);
  else
    if p_id = auth.uid() and (p_role <> 'admin' or not p_active) then raise exception 'No puedes quitarte el rol de administrador ni desactivarte'; end if;
    if (p_role <> 'admin' or not p_active) and public.is_admin_user(p_id)
       and (select count(*) from public.profiles where role = 'admin' and active) < 2 then raise exception 'Debe quedar al menos un administrador activo'; end if;
    update public.profiles set name = p_name, username = p_username, email = lower(p_email), role = p_role, active = p_active where id = p_id;
    update auth.users set email = lower(p_email), updated_at = now() where id = p_id;
    update auth.identities set identity_data = identity_data || jsonb_build_object('email', lower(p_email)) where user_id = p_id and provider = 'email';
    if coalesce(p_password, '') <> '' then
      if length(p_password) < 6 then raise exception 'La contraseña debe tener al menos 6 caracteres'; end if;
      update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = p_id;
    end if;
  end if;
  return uid;
end $$;

create or replace function public.admin_delete_user(p_id uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'Solo el administrador puede eliminar usuarios'; end if;
  if p_id = auth.uid() then raise exception 'No puedes eliminar tu propia cuenta'; end if;
  if public.is_admin_user(p_id) and (select count(*) from public.profiles where role = 'admin' and active) < 2 then raise exception 'Debe quedar al menos un administrador'; end if;
  delete from public.orders where user_id = p_id;          -- el registro de pagos se conserva
  delete from public.notifications where to_user = p_id;
  delete from public.emails where to_user = p_id;
  delete from auth.users where id = p_id;                   -- borra también el perfil (cascade)
end $$;

revoke all on function public.admin_save_user(uuid, text, text, text, text, text, boolean) from public, anon;
revoke all on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_save_user(uuid, text, text, text, text, text, boolean) to authenticated;
grant execute on function public.admin_delete_user(uuid) to authenticated;
grant execute on function public.email_for_username(text) to anon, authenticated;

-- ---------- seguridad por filas (RLS) ----------
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.models enable row level security;
alter table public.orders enable row level security;
alter table public.payments enable row level security;
alter table public.notifications enable row level security;
alter table public.emails enable row level security;
alter table public.settings enable row level security;

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
           and tablename in ('profiles','categories','models','orders','payments','notifications','emails','settings') loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- perfiles: cada uno ve el suyo y los de los administradores (para poder avisarles); el admin ve todos.
create policy profiles_read on public.profiles for select to authenticated using (id = auth.uid() or role = 'admin' or public.is_admin());

-- catálogo y ajustes: lectura para cualquier usuario con sesión, escritura solo admin.
create policy categories_read on public.categories for select to authenticated using (true);
create policy categories_admin on public.categories for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy models_read on public.models for select to authenticated using (true);
create policy models_admin on public.models for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy settings_read on public.settings for select to authenticated using (true);
create policy settings_admin on public.settings for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- pedidos: el usuario ve y gestiona los suyos mientras estén pendientes; el admin, todos.
create policy orders_read on public.orders for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy orders_insert on public.orders for insert to authenticated with check ((user_id = auth.uid() and status = 'pendiente') or public.is_admin());
create policy orders_update on public.orders for update to authenticated
  using ((user_id = auth.uid() and status = 'pendiente') or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
create policy orders_delete on public.orders for delete to authenticated using ((user_id = auth.uid() and status = 'pendiente') or public.is_admin());

-- pagos: cada uno registra y ve los suyos; el admin, todos.
create policy payments_read on public.payments for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy payments_insert on public.payments for insert to authenticated with check (user_id = auth.uid() or public.is_admin());
create policy payments_update on public.payments for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- avisos y correos: cada uno ve los suyos; un usuario solo puede enviarlos a administradores.
create policy notifications_read on public.notifications for select to authenticated using (to_user = auth.uid());
create policy notifications_insert on public.notifications for insert to authenticated with check (public.is_admin() or public.is_admin_user(to_user));
create policy notifications_update on public.notifications for update to authenticated using (to_user = auth.uid()) with check (to_user = auth.uid());
create policy notifications_delete on public.notifications for delete to authenticated using (to_user = auth.uid() or public.is_admin());
create policy emails_read on public.emails for select to authenticated using (to_user = auth.uid());
create policy emails_insert on public.emails for insert to authenticated with check (public.is_admin() or public.is_admin_user(to_user));
create policy emails_delete on public.emails for delete to authenticated using (public.is_admin());

-- ---------- tiempo real ----------
do $$ declare t text; begin
  foreach t in array array['profiles','categories','models','orders','payments','notifications','emails','settings'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- fotos (Storage) ----------
insert into storage.buckets (id, name, public) values ('fotos', 'fotos', true) on conflict (id) do update set public = true;
drop policy if exists fotos_admin_insert on storage.objects;
drop policy if exists fotos_admin_update on storage.objects;
drop policy if exists fotos_admin_delete on storage.objects;
create policy fotos_admin_insert on storage.objects for insert to authenticated with check (bucket_id = 'fotos' and public.is_admin());
create policy fotos_admin_update on storage.objects for update to authenticated using (bucket_id = 'fotos' and public.is_admin());
create policy fotos_admin_delete on storage.objects for delete to authenticated using (bucket_id = 'fotos' and public.is_admin());
