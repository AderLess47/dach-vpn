-- ============================================================================
-- 0002 — IPAM (M1)
--
-- Vergabe von 10.8.0.x-Adressen ohne Kollisionen unter Last.
-- Serialisierung über pg_advisory_xact_lock je Knoten: kein Tabellen-Lock,
-- keine Lost-Updates, keine Doppelvergabe — auch bei parallelen Requests.
-- ============================================================================

-- --- Pool befüllen --------------------------------------------------------
create or replace function public.seed_ip_pool(p_node_id text, p_cidr cidr)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
  v_hosts    integer;
begin
  v_hosts := (broadcast(p_cidr) - network(p_cidr))::bigint::integer - 1;

  if v_hosts < 1 then
    raise exception 'POOL_TOO_SMALL: % enthält keine nutzbaren Hosts', p_cidr
      using errcode = 'P0001';
  end if;

  insert into public.ip_pool (node_id, address)
  select p_node_id, (network(p_cidr) + host_offset)::inet
  from generate_series(1, v_hosts) as series(host_offset)
  on conflict (node_id, address) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

comment on function public.seed_ip_pool(text, cidr) is
  'Legt alle nutzbaren Host-Adressen eines Netzes für einen Knoten an (idempotent).';

-- --- Adresse vergeben -----------------------------------------------------
create or replace function public.allocate_ip(p_node_id text, p_device_id uuid default null)
returns inet
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_address inet;
begin
  -- Advisory Lock je Knoten (Transaktions-scoped, automatische Freigabe).
  perform pg_advisory_xact_lock(hashtextextended('ip_pool:' || p_node_id, 0));

  -- Idempotenz: ein Gerät behält seine Adresse, solange es sie hält.
  if p_device_id is not null then
    select address into v_address
    from public.ip_pool
    where device_id = p_device_id and state = 'assigned'
    limit 1;

    if v_address is not null then
      return v_address;
    end if;
  end if;

  select address into v_address
  from public.ip_pool
  where node_id = p_node_id and state = 'free'
  order by address
  limit 1
  for update skip locked;

  if v_address is null then
    raise exception 'IP_POOL_EXHAUSTED' using
      errcode = 'P0001',
      hint = 'Kein freier Adressbereich für diesen Knoten.';
  end if;

  update public.ip_pool
     set state = 'assigned',
         device_id = p_device_id,
         assigned_at = now()
   where node_id = p_node_id
     and address = v_address;

  return v_address;
end;
$$;

comment on function public.allocate_ip(text, uuid) is
  'Vergibt die niedrigste freie Adresse eines Knotens; serialisiert per Advisory Lock.';

-- --- Adresse freigeben ----------------------------------------------------
create or replace function public.release_ip(p_device_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.ip_pool
     set state = 'free',
         device_id = null,
         assigned_at = null
   where device_id = p_device_id
     and state = 'assigned';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- --- Gerät widerrufen -----------------------------------------------------
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
         revoked_at = now()
   where id = p_device_id
     and status = 'active';

  v_released := public.release_ip(p_device_id);
  return v_released;
end;
$$;

-- --- Ausführungsrechte ----------------------------------------------------
-- Diese Funktionen dürfen nur mit Service-Role laufen, nicht aus dem Browser.
revoke execute on function public.seed_ip_pool(text, cidr) from public, anon, authenticated;
revoke execute on function public.allocate_ip(text, uuid) from public, anon, authenticated;
revoke execute on function public.release_ip(uuid) from public, anon, authenticated;
revoke execute on function public.revoke_device(uuid) from public, anon, authenticated;

grant execute on function public.seed_ip_pool(text, cidr) to service_role;
grant execute on function public.allocate_ip(text, uuid) to service_role;
grant execute on function public.release_ip(uuid) to service_role;
grant execute on function public.revoke_device(uuid) to service_role;
