-- ============================================================================
-- 0009 — Zugangs-Gate: Geräte nur mit laufendem Abo, Add-on nur bei Buchung
--
-- Bisher vergab `register_device` jedem angemeldeten Konto ein Gerät samt
-- Pool-Adresse — auch ohne Abo. Damit war das Abo nicht durchsetzbar: ein
-- kostenloses Konto bekam denselben WireGuard-Zugang wie ein zahlendes.
--
-- Regeln (eine Stelle, serverseitig, nicht umgehbar):
--   1. Neue Geräte und Schlüsselwechsel setzen ein Abo mit Status `active`
--      oder `past_due` voraus. `past_due` ist bewusst Kulanz: Stripe mahnt
--      nach einer fehlgeschlagenen Zahlung weiter und kündigt erst danach
--      (`canceled`) — ein sofortiger Cutoff beim ersten Fehlschlag wäre für
--      zahlende Kunden schlechter als das Risiko weniger Mahntage.
--   2. `pihole_enabled = true` setzt ein gebuchtes Add-on voraus
--      (`pihole_addon_active`). Sonst würde ein Basis-Abo den Filter nutzen.
--   3. Wird das Add-on abbestellt, verlieren bestehende Geräte die
--      Pi-hole-Einstellung (Trigger). Sonst zeigte die Config weiter DNS
--      10.9.0.1, obwohl niemand mehr dafür zahlt.
--
-- Nicht Teil dieser Migration: das Widerrufen bestehender Geräte bei Ablauf.
-- Das braucht den Pull-Agenten (M2), der den Soll-Zustand auf dem Knoten
-- entfernt; bis dahin bleiben bereits ausgegebene Configs gültig.
-- ============================================================================

create or replace function public.register_device(
  p_user_id        uuid,
  p_name           text,
  p_platform       public.device_platform,
  p_public_key     text,
  p_node_id        text,
  p_pihole_enabled boolean default false,
  p_max_devices    integer default 5
)
returns table (device_id uuid, assigned_ip inet, reused boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.devices%rowtype;
  v_device_id uuid;
  v_ip        inet;
  v_active    integer;
  v_status    public.subscription_status;
  v_addon     boolean;
begin
  -- Idempotenz zuerst: ein Retry mit demselben Public Key liefert das
  -- bestehende Gerät zurück, auch wenn das Abo inzwischen abgelaufen ist.
  -- Sonst würde ein Reload im Dashboard ein „Abo fehlt" zeigen, obwohl das
  -- Gerät längst existiert.
  select * into v_existing
  from public.devices
  where public_key = p_public_key;

  if found then
    if v_existing.status = 'revoked' then
      raise exception 'DEVICE_REVOKED' using
        errcode = 'P0002',
        hint = 'Für dieses Gerät muss ein neues Schlüsselpaar erzeugt werden.';
    end if;

    if v_existing.user_id <> p_user_id then
      -- Ein Public Key gehört genau einem Konto. Kein Hinweis auf den Besitzer.
      raise exception 'DEVICE_KEY_CONFLICT' using
        errcode = 'P0004',
        hint = 'Dieser Public Key ist bereits einem anderen Konto zugeordnet.';
    end if;

    return query select v_existing.id, v_existing.assigned_ip, true;
    return;
  end if;

  -- --- Zugangs-Gate -------------------------------------------------------
  select s.status, s.pihole_addon_active
    into v_status, v_addon
  from public.subscriptions s
  where s.user_id = p_user_id;

  if v_status is null or v_status not in ('active', 'past_due') then
    raise exception 'SUBSCRIPTION_REQUIRED' using
      errcode = 'P0006',
      hint = 'Für die Geräteregistrierung ist ein aktives Abo erforderlich.';
  end if;

  if coalesce(p_pihole_enabled, false) and not coalesce(v_addon, false) then
    raise exception 'ADDON_NOT_BOOKED' using
      errcode = 'P0007',
      hint = 'Das Pi-hole-Add-on ist für dieses Konto nicht gebucht.';
  end if;

  if p_max_devices is not null then
    select count(*) into v_active
    from public.devices
    where user_id = p_user_id and status = 'active';

    if v_active >= p_max_devices then
      raise exception 'DEVICE_LIMIT_REACHED' using
        errcode = 'P0003',
        hint = 'Gerätelimit des Kontos erreicht.';
    end if;
  end if;

  insert into public.devices (user_id, name, platform, public_key, node_id, pihole_enabled)
  values (p_user_id, p_name, p_platform, p_public_key, p_node_id, coalesce(p_pihole_enabled, false))
  returning id into v_device_id;

  -- Advisory Lock + freie Adresse; wirft IP_POOL_EXHAUSTED, wenn nichts frei ist.
  v_ip := public.allocate_ip(p_node_id, v_device_id);

  update public.devices
     set assigned_ip = v_ip
   where id = v_device_id;

  return query select v_device_id, v_ip, false;
end;
$$;

comment on function public.register_device(uuid, text, public.device_platform, text, text, boolean, integer) is
  'Legt Gerät und IP-Zuweisung atomar an; verlangt aktives Abo und für Pi-hole ein gebuchtes Add-on.';

-- --- Schlüsselwechsel ebenfalls hinter dem Gate ----------------------------
-- Reihenfolge: Besitz → Widerruf → Abo. Fremde und unbekannte Geräte bleiben
-- von eigenen unterscheidbar (DEVICE_NOT_FOUND), ein widerrufenes Gerät meldet
-- DEVICE_REVOKED — erst danach entscheidet das Abo.
create or replace function public.rebind_device_key(
  p_user_id    uuid,
  p_device_id  uuid,
  p_public_key text
)
returns table (device_id uuid, assigned_ip inet)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_device public.devices%rowtype;
  v_status public.subscription_status;
begin
  select * into v_device
  from public.devices
  where id = p_device_id;

  if not found or v_device.user_id <> p_user_id then
    raise exception 'DEVICE_NOT_FOUND' using
      errcode = 'P0005',
      hint = 'Gerät gehört nicht zu diesem Konto.';
  end if;

  if v_device.status <> 'active' then
    raise exception 'DEVICE_REVOKED' using
      errcode = 'P0002',
      hint = 'Widerrufene Geräte nehmen keinen neuen Schlüssel an.';
  end if;

  select s.status into v_status
  from public.subscriptions s
  where s.user_id = p_user_id;

  if v_status is null or v_status not in ('active', 'past_due') then
    raise exception 'SUBSCRIPTION_REQUIRED' using
      errcode = 'P0006',
      hint = 'Für den Schlüsselwechsel ist ein aktives Abo erforderlich.';
  end if;

  -- Ist der Key bereits an ein anderes Gerät gebunden, greift der Unique-Index
  -- auf devices.public_key (23505); die Route beantwortet das als Konflikt.
  update public.devices
     set public_key = p_public_key
   where id = p_device_id;

  return query select v_device.id, v_device.assigned_ip;
end;
$$;

-- --- Add-on abbestellt → Geräte verlieren die Einstellung ------------------
create or replace function public.sync_device_addon_flag()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.pihole_addon_active is false
     and old.pihole_addon_active is distinct from new.pihole_addon_active then
    update public.devices
       set pihole_enabled = false
     where user_id = new.user_id
       and pihole_enabled;
  end if;

  return new;
end;
$$;

comment on function public.sync_device_addon_flag() is
  'Setzt pihole_enabled bestehender Geräte zurück, wenn das Add-on abbestellt wurde.';

drop trigger if exists subscriptions_sync_device_addon on public.subscriptions;
create trigger subscriptions_sync_device_addon
  after update of pihole_addon_active on public.subscriptions
  for each row execute function public.sync_device_addon_flag();

-- --- Rechte (unverändert eng) ---------------------------------------------
revoke execute on function public.register_device(uuid, text, public.device_platform, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.register_device(uuid, text, public.device_platform, text, text, boolean, integer) to service_role;

revoke execute on function public.rebind_device_key(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rebind_device_key(uuid, uuid, text) to service_role;

revoke execute on function public.sync_device_addon_flag() from public, anon, authenticated;
