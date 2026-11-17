-- Nur für lokale Tests / CI: bildet die Supabase-Objekte nach, auf die die
-- Migrationen verweisen (auth.users, auth.uid(), Rollen). Wird NICHT in Supabase
-- eingespielt — dort existieren diese Objekte bereits.

create schema if not exists auth;

-- Supabase-Rollen, auf die die Grants der Migrationen verweisen.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- Wie in Supabase: die Nutzer-ID kommt aus dem JWT der Session
-- (`request.jwt.claims`), damit RLS-Policies im Test echt greifen.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;
