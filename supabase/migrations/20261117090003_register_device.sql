-- ============================================================================
-- 0003 — Atomare Geräteregistrierung (M1)
--
-- Gerät anlegen und Adresse vergeben müssen in EINER Transaktion passieren.
-- Sonst entstehen bei einem Fehler dazwischen Geräte ohne Adresse oder
-- (schlimmer) verbrauchte Adressen ohne Gerät — bei einem IP-Pool, der
-- erschöpfen kann, ist das ein schleichender Ausfall.
--
-- Läuft die Vergabe in den leeren Pool, wirft allocate_ip eine Exception.
-- Da beide Schritte in derselben Transaktion liegen, wird auch das Gerät
-- zurückgerollt: entweder beides oder nichts.
-- ============================================================================

create or replace function public.register_device(
  p_user_id        uuid,
  p_name           text,
  p_platform       public.device_platform,
  p_public_key     text,
  p_node_id        text,
  p_pihole_enabled boolean default false
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
begin
  -- Idempotenz über den Public Key: ein Retry darf kein zweites Gerät
  -- und keine zweite Adresse erzeugen.
  select * into v_existing
  from public.devices
  where public_key = p_public_key;

  if found then
    if v_existing.status = 'revoked' then
      raise exception 'DEVICE_REVOKED' using
        errcode = 'P0002',
        hint = 'Für dieses Gerät wurde ein neues Schlüsselpaar erzeugt werden.';
    end if;

    return query select v_existing.id, v_existing.assigned_ip, true;
    return;
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

comment on function public.register_device(uuid, text, public.device_platform, text, text, boolean) is
  'Legt Gerät und IP-Zuweisung atomar an; idempotent über den Public Key.';

-- --- Widerruf: Adresse vollständig lösen ----------------------------------
create or replace function public.revoke_device(p_device_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_released integer;
begin
  update public.devices
     set status = 'revoked',
         revoked_at = now(),
         assigned_ip = null
   where id = p_device_id
     and status = 'active';

  v_released := public.release_ip(p_device_id);
  return v_released;
end;
$$;

revoke execute on function public.register_device(uuid, text, public.device_platform, text, text, boolean) from public, anon, authenticated;
grant execute on function public.register_device(uuid, text, public.device_platform, text, text, boolean) to service_role;
