"use client";

import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "../lib/supabase-browser";

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  status: string;
  assigned_ip: string | null;
  pihole_enabled: boolean;
  created_at: string;
}

export function DeviceList({
  accessToken,
  reloadKey,
}: {
  accessToken: string | null;
  reloadKey: number;
}) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabaseBrowser || !accessToken) {
      setLoading(false);
      return;
    }

    // RLS liefert ausschließlich die eigenen Geräte.
    const { data, error: loadError } = await supabaseBrowser
      .from("devices")
      .select("id, name, platform, status, assigned_ip, pihole_enabled, created_at")
      .order("created_at", { ascending: false });

    if (loadError) setError(loadError.message);
    else setDevices((data as DeviceRow[] | null) ?? []);
    setLoading(false);
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  async function revoke(deviceId: string) {
    if (!accessToken) {
      setError("Bitte zuerst anmelden.");
      return;
    }
    setBusyId(deviceId);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/devices/revoke", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ deviceId }),
      });
      const data = (await response.json()) as { code?: string; message?: string };

      if (response.status === 202) {
        setNotice("Supabase ist nicht konfiguriert — nichts gespeichert.");
        return;
      }
      if (!response.ok) {
        setError(`${response.status} ${data.code ?? "FEHLER"}: ${data.message ?? ""}`.trim());
        return;
      }
      setNotice("Gerät widerrufen; die IP-Adresse ist wieder frei.");
      await load();
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Netzwerkfehler");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-lg font-medium text-slate-100">Meine Geräte</h2>

      {loading ? (
        <p className="text-sm text-slate-400">lädt…</p>
      ) : devices.length === 0 ? (
        <p className="text-sm text-slate-400">Noch keine Geräte registriert.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-slate-800">
          {devices.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex flex-col">
                <span className="text-sm text-slate-100">
                  {device.name}
                  <span className="ml-2 text-xs text-slate-500">{device.platform}</span>
                </span>
                <span className="text-xs text-slate-400">
                  {device.assigned_ip ?? "keine Adresse"} ·{" "}
                  {device.pihole_enabled ? "Pi-hole aktiv" : "ohne Add-on"} ·{" "}
                  {device.status === "active" ? "aktiv" : "widerrufen"}
                </span>
              </div>
              {device.status === "active" && (
                <button
                  type="button"
                  disabled={busyId === device.id}
                  onClick={() => void revoke(device.id)}
                  className="rounded-md border border-rose-900 px-3 py-1 text-xs text-rose-300 hover:border-rose-600 disabled:opacity-40"
                >
                  {busyId === device.id ? "wird widerrufen…" : "Widerrufen"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {notice && (
        <p className="rounded-lg border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-200">
          {notice}
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-rose-900 bg-rose-950/50 p-3 text-sm text-rose-200">
          {error}
        </p>
      )}
    </section>
  );
}
