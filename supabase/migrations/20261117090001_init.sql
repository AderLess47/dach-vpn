-- ============================================================================
-- 0001 — Basis-Schema M1 (Sprint 1)
-- profiles, subscriptions, devices, ip_pool
--
-- Grundsatz: In `devices` steht ausschließlich der Public Key. Es gibt keine
-- Spalte, in der ein privater Schlüssel abgelegt werden könnte — das ist
-- Absicht und Teil des Audit-Nachweises (Angebot, AP 1.6 / 5.2).
-- ============================================================================

create extension if not exists pgcrypto;

-- --- Enums ----------------------------------------------------------------
create type public.device_platform as enum ('web', 'ios', 'android', 'tvos', 'firetv');
create type public.device_status as enum ('active', 'revoked');
create type public.subscription_status as enum ('incomplete', 'active', 'past_due', 'canceled');
create type public.ip_state as enum ('free', 'assigned', 'reserved');

-- --- profiles -------------------------------------------------------------
create table public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  locale     text not null default 'de',
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'Minimalprofil. Bewusst ohne IP-Adressen, ohne Verbindungsdaten (No-Log).';

-- --- subscriptions --------------------------------------------------------
create table public.subscriptions (
  user_id                uuid primary key references public.profiles (user_id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  status                 public.subscription_status not null default 'incomplete',
  pihole_addon_active    boolean not null default false,
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);

-- --- devices --------------------------------------------------------------
create table public.devices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (user_id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 64),
  platform       public.device_platform not null,
  -- 32 Byte Curve25519, Base64 (44 Zeichen inkl. Padding). Nur Public Key.
  public_key     text not null unique check (public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  node_id        text,
  assigned_ip    inet,
  pihole_enabled boolean not null default false,
  status         public.device_status not null default 'active',
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz
);

create index devices_user_id_idx on public.devices (user_id);
create index devices_active_idx on public.devices (node_id) where status = 'active';

-- --- ip_pool --------------------------------------------------------------
create table public.ip_pool (
  id          bigserial primary key,
  node_id     text not null,
  address     inet not null,
  state       public.ip_state not null default 'free',
  device_id   uuid references public.devices (id) on delete set null,
  assigned_at timestamptz,
  constraint ip_pool_node_address_unique unique (node_id, address)
);

-- Ein Gerät darf höchstens eine Adresse gleichzeitig halten.
create unique index ip_pool_one_per_device_idx
  on public.ip_pool (device_id)
  where device_id is not null;

create index ip_pool_free_idx
  on public.ip_pool (node_id, address)
  where state = 'free';

-- --- updated_at -----------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- --- Row Level Security ---------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.subscriptions enable row level security;
alter table public.devices       enable row level security;
alter table public.ip_pool       enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated using (auth.uid() = user_id);

create policy profiles_update_own on public.profiles
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (auth.uid() = user_id);

create policy devices_select_own on public.devices
  for select to authenticated using (auth.uid() = user_id);

create policy devices_insert_own on public.devices
  for insert to authenticated with check (auth.uid() = user_id);

create policy devices_update_own on public.devices
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy devices_delete_own on public.devices
  for delete to authenticated using (auth.uid() = user_id);

-- ip_pool hat bewusst KEINE Policy für Endnutzer: Adressvergabe läuft
-- ausschließlich über die SECURITY-DEFINER-Funktionen (0002) mit Service-Role.

-- --- Grants ---------------------------------------------------------------
grant select, insert, update, delete on public.profiles      to authenticated;
grant select, insert, update, delete on public.devices       to authenticated;
grant select on public.subscriptions                         to authenticated;
grant all on public.profiles, public.devices, public.subscriptions, public.ip_pool to service_role;
grant usage, select on sequence public.ip_pool_id_seq to service_role;
