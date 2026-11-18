-- ============================================================================
-- 0004 — Auth-Bindung (M1)
--
-- 1) Zu jedem auth.users-Eintrag entsteht automatisch ein Profil. Damit ist die
--    FK von devices.user_id erfüllbar, ohne dass die Route Profile schreiben muss.
-- 2) register_device() bekommt ein Gerätelimit — ein Konto kann den Pool nicht
--    mit beliebig vielen Geräten leerziehen.
-- 3) Die Funktion bleibt ausschließlich für service_role ausführbar. Ein Client
--    mit Nutzer-JWT kann sie NICHT aufrufen und damit auch keine fremde user_id
--    einschleusen — die Identität kommt immer aus dem serverseitig geprüften Token.
-- ============================================================================

-- --- Profil automatisch anlegen -------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Bestehende Nutzer nachziehen (idempotent).
insert into public.profiles (user_id, email)
select id, email from auth.users
on conflict (user_id) do nothing;

-- --- Registrierung mit Gerätelimit ----------------------------------------
-- Signatur ändert sich (zusätzlicher Parameter) -> alte Funktion explizit
-- entfernen, sonst entsteht eine Überladung mit mehrdeutigen Defaults.
drop function if exists public.register_device(uuid, text, public.device_platform, text, text, boolean);

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
  'Legt Gerät und IP-Zuweisung atomar an; idempotent über den Public Key, mit Gerätelimit.';

revoke execute on function public.register_device(uuid, text, public.device_platform, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.register_device(uuid, text, public.device_platform, text, text, boolean, integer) to service_role;
