-- ============================================================================
-- 0005 — Abo-Zustand aus Stripe und Admin-Kennzahlen (M1)
--
-- Stripe-Webhooks sind die einzige Quelle für den Abo-Status. `stripe_events`
-- dient der Idempotenz: jede Event-ID wird genau einmal verarbeitet, ein
-- erneuter Zustellversuch ändert nichts. Die Tabelle enthält bewusst keine
-- Nutzdaten und keine E-Mail-Adressen (No-Log).
-- ============================================================================

alter table public.subscriptions
  add column if not exists cancel_at_period_end boolean not null default false;

create table if not exists public.stripe_events (
  event_id     text primary key,
  type         text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  error        text
);

comment on table public.stripe_events is
  'Idempotenz-Log der Stripe-Events. Nur Event-ID, Typ und Zeitstempel — keine Nutzdaten.';

alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from anon, authenticated;
grant all on public.stripe_events to service_role;

-- --- Abo-Zustand setzen (nur Service-Role) --------------------------------
create or replace function public.apply_subscription_state(
  p_user_id             uuid,
  p_customer_id         text,
  p_subscription_id     text,
  p_status              public.subscription_status,
  p_pihole              boolean default false,
  p_period_end          timestamptz default null,
  p_cancel_at_period_end boolean default false
)
returns public.subscriptions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.subscriptions;
begin
  if p_user_id is null then
    raise exception 'USER_ID_REQUIRED' using errcode = 'P0001';
  end if;

  insert into public.subscriptions (
    user_id, stripe_customer_id, stripe_subscription_id, status,
    pihole_addon_active, current_period_end, cancel_at_period_end
  )
  values (
    p_user_id, p_customer_id, p_subscription_id, p_status,
    coalesce(p_pihole, false), p_period_end, coalesce(p_cancel_at_period_end, false)
  )
  on conflict (user_id) do update
    set stripe_customer_id     = coalesce(excluded.stripe_customer_id, public.subscriptions.stripe_customer_id),
        stripe_subscription_id = coalesce(excluded.stripe_subscription_id, public.subscriptions.stripe_subscription_id),
        status                 = excluded.status,
        pihole_addon_active    = excluded.pihole_addon_active,
        current_period_end     = coalesce(excluded.current_period_end, public.subscriptions.current_period_end),
        cancel_at_period_end   = excluded.cancel_at_period_end
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.apply_subscription_state(
  uuid, text, text, public.subscription_status, boolean, timestamptz, boolean
) from public, anon, authenticated;

grant execute on function public.apply_subscription_state(
  uuid, text, text, public.subscription_status, boolean, timestamptz, boolean
) to service_role;

-- --- Admin-Kennzahlen (nur Aggregate) -------------------------------------
-- Bewusst ohne Personenbezug: keine Nutzer-IDs, keine E-Mails, keine Adressen.
create or replace function public.admin_metrics()
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'subscriptions', jsonb_build_object(
      'active',   (select count(*) from public.subscriptions where status = 'active'),
      'pastDue',  (select count(*) from public.subscriptions where status = 'past_due'),
      'canceled', (select count(*) from public.subscriptions where status = 'canceled'),
      'incomplete', (select count(*) from public.subscriptions where status = 'incomplete'),
      'piholeAddon', (select count(*) from public.subscriptions
                       where status = 'active' and pihole_addon_active)
    ),
    'devices', jsonb_build_object(
      'active',  (select count(*) from public.devices where status = 'active'),
      'revoked', (select count(*) from public.devices where status = 'revoked')
    ),
    'nodes', coalesce((
      select jsonb_object_agg(node_id, jsonb_build_object('free', free, 'assigned', assigned))
      from (
        select node_id,
               count(*) filter (where state = 'free')::int     as free,
               count(*) filter (where state = 'assigned')::int as assigned
        from public.ip_pool
        group by node_id
      ) per_node
    ), '{}'::jsonb)
  );
$$;

revoke execute on function public.admin_metrics() from public, anon, authenticated;
grant execute on function public.admin_metrics() to service_role;
