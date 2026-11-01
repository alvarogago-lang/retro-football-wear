-- =====================================================================
-- La Prima Mery — 005: consultas de contacto e invitaciones a amigos
-- Ejecutar después de 004_inactividad.sql. Idempotente.
--
-- · contact: una fila por consulta (hilo). data = { id, userId, userName, subject, status, at, updatedAt,
--   readUser, readAdmin, messages: [{ from: 'user'|'admin', by, name, body, at }] }
--   El usuario ve y escribe en las suyas; los administradores, en todas.
-- · invitations: registro de invitaciones enviadas (lo escribe la Edge Function send-mail, con límite diario).
-- =====================================================================

create table if not exists public.contact (
  id text primary key, data jsonb not null,
  user_id uuid generated always as ((data->>'userId')::uuid) stored
);
create index if not exists contact_user_idx on public.contact (user_id);
alter table public.contact enable row level security;
drop policy if exists contact_read on public.contact;
drop policy if exists contact_insert on public.contact;
drop policy if exists contact_update on public.contact;
drop policy if exists contact_delete on public.contact;
create policy contact_read on public.contact for select to authenticated using ((user_id = auth.uid() and public.is_active()) or public.is_admin());
create policy contact_insert on public.contact for insert to authenticated with check ((user_id = auth.uid() and public.is_active()) or public.is_admin());
create policy contact_update on public.contact for update to authenticated
  using ((user_id = auth.uid() and public.is_active()) or public.is_admin())
  with check ((user_id = auth.uid() and public.is_active()) or public.is_admin());
create policy contact_delete on public.contact for delete to authenticated using (public.is_admin());

create table if not exists public.invitations (
  id bigserial primary key,
  user_id uuid not null references public.profiles on delete cascade,
  email text not null,
  at timestamptz not null default now()
);
alter table public.invitations enable row level security;
drop policy if exists invitations_read on public.invitations;
create policy invitations_read on public.invitations for select to authenticated using (user_id = auth.uid() or public.is_admin());
-- sin políticas de escritura: solo la Edge Function (con la clave de servicio) registra invitaciones

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'contact') then
    alter publication supabase_realtime add table public.contact;
  end if;
end $$;
