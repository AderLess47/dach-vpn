-- ============================================================================
-- 0006 — IPAM: Pool speichert Host-Adressen
--
-- `network(p_cidr) + offset` erbt die Netzmaske: 10.9.0.0/27 + 1 ergibt
-- 10.9.0.1/27, und `inet` gibt den Präfix aus, sobald er nicht 32 ist. Die API
-- lieferte deshalb „10.9.0.1/27“ statt einer Host-Adresse; eine
-- WireGuard-Konfiguration hätte daraus `Address = 10.9.0.1/27` gebaut.
--
-- Der Pool hält jetzt Adressen mit /32. Bestehende Zeilen ziehen nach; auf
-- einer frischen Datenbank sind beide Updates No-Ops.
-- ============================================================================

update public.ip_pool
   set address = set_masklen(address, 32)
 where masklen(address) <> 32;

update public.devices
   set assigned_ip = set_masklen(assigned_ip, 32)
 where assigned_ip is not null
   and masklen(assigned_ip) <> 32;

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
  select p_node_id, set_masklen(network(p_cidr) + host_offset, 32)
  from generate_series(1, v_hosts) as series(host_offset)
  on conflict (node_id, address) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

comment on function public.seed_ip_pool(text, cidr) is
  'Legt alle nutzbaren Host-Adressen eines Netzes für einen Knoten an (idempotent).';
