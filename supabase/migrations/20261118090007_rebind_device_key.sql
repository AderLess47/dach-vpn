-- ============================================================================
-- 0007 — Schlüsselwechsel an einem bestehenden Gerät
--
-- Der private Schlüssel wird bewusst nie gespeichert (Zero-Knowledge): nach
-- einem Reload existiert nur noch der Public Key in der Datenbank. Bisherigen
-- Geräten ließ sich deshalb kein neues Schlüsselpaar zuordnen; ein erneutes
-- Registrieren legte ein zweites Gerät mit einer zweiten Adresse an und fraß
-- Pool-Adressen.
--
-- rebind_device_key() ersetzt ausschließlich public_key einer Zeile. id, Name,
-- Knoten, Adresse, Pi-hole-Einstellung und created_at bleiben unverändert, und
-- es wird keine neue Adresse vergeben.
--
-- Wie register_device ist die Funktion nur für service_role ausführbar: die
-- Nutzer-ID kommt aus dem serverseitig geprüften Token, nie aus dem Body. Die
-- Besitzprüfung steht zusätzlich hier, damit ein Fehler in der Route keinen
-- fremden Datensatz umschreiben kann.
-- ============================================================================

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
begin
  select * into v_device
  from public.devices
  where id = p_device_id;

  -- Fremdes und nicht vorhandenes Gerät sind von außen nicht unterscheidbar:
  -- sonst wäre die Funktion eine Sonde auf fremde Geräte-IDs.
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

  -- Ist der Key bereits an ein anderes Gerät gebunden, greift der Unique-Index
  -- auf devices.public_key (23505); die Route beantwortet das als Konflikt.
  update public.devices
     set public_key = p_public_key
   where id = p_device_id;

  return query select v_device.id, v_device.assigned_ip;
end;
$$;

comment on function public.rebind_device_key(uuid, uuid, text) is
  'Bindet einen neuen Public Key an ein bestehendes Gerät; Adresse und Geräte-ID bleiben.';

revoke execute on function public.rebind_device_key(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rebind_device_key(uuid, uuid, text) to service_role;
