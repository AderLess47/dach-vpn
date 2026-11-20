-- ============================================================================
-- 0008 — Mandanten (White-Label): Domain → Marke
--
-- Bisher kam der Anzeigename aus `NEXT_PUBLIC_APP_NAME` und war damit beim Build
-- eingebacken. Für echte Mandanten muss die Marke pro Request aus dem Host
-- entstehen — ohne Rebuild. Diese Migration legt die Registry dafür an.
--
-- Kein Personenbezug: Hier stehen Firmennamen, Domains und Markentexte, keine
-- Nutzer-, Geräte- oder Verbindungsdaten. Die Tabellen sind für Endnutzer
-- vollständig gesperrt; gelesen wird ausschließlich über
-- `resolve_tenant_brand()` mit Service-Role, serverseitig in der Dashboard-App.
-- ============================================================================

create table if not exists public.tenants (
  id         uuid primary key default gen_random_uuid(),
  -- Muss zum Slug-Format des Brand-Moduls passen (packages/shared/src/brand.ts).
  slug       text not null unique
             check (slug ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  name       text not null
             check (char_length(btrim(name)) between 1 and 48),
  tagline    text not null default 'No-Log-VPN mit Pi-hole-Add-on'
             check (char_length(tagline) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tenants is
  'White-Label-Mandanten. Marke und Texte je Mandant; keine Nutzerdaten.';

create table if not exists public.tenant_domains (
  -- Ein Host gehört genau einem Mandanten. Der Wert ist bereits normalisiert
  -- (klein, ohne Port) — dieselbe Form, die normalizeHost() serverseitig bildet.
  domain     text primary key
             check (
               domain = lower(domain)
               and char_length(domain) <= 253
               and domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'
             ),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.tenant_domains is
  'Host → Mandant. Wird pro Request gelesen, enthält keine IP-Adressen.';

create index if not exists tenant_domains_tenant_idx
  on public.tenant_domains (tenant_id);

drop trigger if exists tenants_set_updated_at on public.tenants;
create trigger tenants_set_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

-- --- Zugriff ---------------------------------------------------------------
-- RLS an, bewusst ohne Policy: Endnutzer und `anon` lesen nichts. Die App liest
-- serverseitig über die Funktion unten mit Service-Role.
alter table public.tenants        enable row level security;
alter table public.tenant_domains enable row level security;

revoke all on public.tenants, public.tenant_domains from public, anon, authenticated;
grant all on public.tenants, public.tenant_domains to service_role;

-- --- Auflösung -------------------------------------------------------------
-- Eine schmale Funktion statt Tabellenzugriff: kein Weg für den Browser, die
-- Mandantenliste zu enumerieren. Unbekannte Domains liefern NULL.
create or replace function public.resolve_tenant_brand(p_domain text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('name', t.name, 'slug', t.slug, 'tagline', t.tagline)
  from public.tenant_domains d
  join public.tenants t on t.id = d.tenant_id
  where d.domain = lower(btrim(p_domain))
$$;

comment on function public.resolve_tenant_brand(text) is
  'Marke eines Hosts für die serverseitige Auflösung; nur Service-Role, NULL wenn unbekannt.';

revoke execute on function public.resolve_tenant_brand(text) from public, anon, authenticated;
grant execute on function public.resolve_tenant_brand(text) to service_role;
