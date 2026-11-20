"use client";

import { useEffect, useState } from "react";
import {
  buildWireguardConfig,
  generateDeviceKeyPair,
  isValidPublicKey,
  publicKeyFingerprint,
  wipePrivateKey,
  type DeviceKeyPair,
} from "@dachvpn/crypto";
import {
  hasVpnEntitlement,
  PLATFORMS,
  type Brand,
  type Platform,
} from "@dachvpn/shared";
import { supabaseBrowser } from "../lib/supabase-browser";

interface RegisterResponse {
  persisted?: boolean;
  reason?: string;
  code?: string;
  message?: string;
  device?: { id: string; assignedIp: string | null; reused: boolean };
}

interface DeviceOption {
  id: string;
  name: string;
  assignedIp: string | null;
}

interface SubscriptionState {
  status: string;
  pihole_addon_active: boolean;
}

const PLATFORM_LABELS: Record<Platform, string> = {
  web: "Web",
  ios: "iOS",
  android: "Android",
  tvos: "tvOS",
  firetv: "Fire TV",
};

/**
 * Formt die vom Server vergebene Adresse in die Host-Adresse für den Tunnel um.
 * Der Pool weist seit Migration 0006 /32-Adressen zu; ein mitgeliefertes
 * Präfix wird dennoch entfernt, damit nie eine Netzmaske in der Config landet.
 */
function wireguardClientAddress(assignedIp: string | null | undefined): string | null {
  if (!assignedIp) return null;
  const host = assignedIp.split("/")[0]?.trim() ?? "";
  const octets = host.split(".");
  const validIpv4 =
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
  return validIpv4 ? `${host}/32` : null;
}

export function KeyGenPanel({
  accessToken,
  onRegistered,
  brand,
}: {
  accessToken: string | null;
  onRegistered?: () => void;
  /** Marke des Mandanten; kommt vom Server, weil sie vom Host abhängt. */
  brand: Brand;
}) {
  const [name, setName] = useState("Wohnzimmer-TV");
  const [platform, setPlatform] = useState<Platform>("firetv");
  const [piholeEnabled, setPiholeEnabled] = useState(false);
  const [pair, setPair] = useState<DeviceKeyPair | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RegisterResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [devicesVersion, setDevicesVersion] = useState(0);
  const [subscription, setSubscription] = useState<SubscriptionState | null>(null);

  const selectedDevice = devices.find((device) => device.id === deviceId) ?? null;
  // Adresse bevorzugt aus der Geräteliste: sie überlebt einen Reload, die
  // Antwort der Registrierung nicht.
  const clientAddress = wireguardClientAddress(
    selectedDevice?.assignedIp ?? result?.device?.assignedIp,
  );

  // Zugangsregeln: Das Abo entscheidet, ob registriert werden darf, das Add-on,
  // ob der Filter verfügbar ist. Die Durchsetzung passiert serverseitig; hier
  // wird nur erklärt und verhindert, dass man in eine 403 läuft. Ohne Sitzung
  // (Trockenlauf) bleibt beides frei, damit die PoC-Seite bedienbar ist.
  const signedIn = Boolean(accessToken);
  const entitled = !signedIn || hasVpnEntitlement(subscription?.status);
  const addonActive = !signedIn || subscription?.pihole_addon_active === true;
  const piholeActive = addonActive && piholeEnabled;

  // Eigene Geräte für die Auswahl laden; RLS liefert nur die des Kontos.
  useEffect(() => {
    let cancelled = false;

    async function loadDevices() {
      if (!supabaseBrowser || !accessToken) {
        if (!cancelled) {
          setDevices([]);
          setSubscription(null);
        }
        return;
      }

      // Beides in einem Durchgang: Geräteauswahl und Abo-Status (RLS liefert
      // nur die eigenen Zeilen). Ohne Abo-Zeile bleibt `subscription` null.
      const [{ data }, { data: subscriptionRow }] = await Promise.all([
        supabaseBrowser
          .from("devices")
          .select("id, name, assigned_ip, status")
          .eq("status", "active")
          .order("created_at", { ascending: false }),
        supabaseBrowser
          .from("subscriptions")
          .select("status, pihole_addon_active")
          .maybeSingle(),
      ]);

      if (cancelled) return;
      const rows =
        (data as { id: string; name: string; assigned_ip: string | null }[] | null) ?? [];
      setDevices(
        rows.map((row) => ({ id: row.id, name: row.name, assignedIp: row.assigned_ip })),
      );
      setSubscription((subscriptionRow as SubscriptionState | null) ?? null);
    }

    void loadDevices();
    return () => {
      cancelled = true;
    };
  }, [accessToken, devicesVersion]);

  function handleGenerate() {
    setError(null);
    setResult(null);
    setDownloaded(false);
    if (pair) wipePrivateKey(pair);
    const next = generateDeviceKeyPair();
    setPair(next);
    setFingerprint(publicKeyFingerprint(next.publicKeyBase64));
  }

  async function handleRegister(event: React.FormEvent) {
    event.preventDefault();
    if (!pair) {
      setError("Bitte zuerst ein Schlüsselpaar erzeugen.");
      return;
    }

    setBusy(true);
    setError(null);
    setResult(null);

    // Zwei Wege: an ein bestehendes Gerät binden (dann zählt nur der neue
    // Public Key, Adresse und Name bleiben) oder ein neues Gerät anlegen.
    // Bewusst explizit aufgebaut: der Request enthält genau diese Felder.
    // Der private Schlüssel existiert in dieser Funktion nicht als Variable,
    // die in den Body gelangen könnte.
    const payload = selectedDevice
      ? { deviceId: selectedDevice.id, publicKey: pair.publicKeyBase64 }
      : {
          name,
          platform,
          publicKey: pair.publicKeyBase64,
          piholeEnabled: piholeActive,
        };

    try {
      const response = await fetch(
        selectedDevice ? "/api/devices/rebind" : "/api/devices/register",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify(payload),
        },
      );
      const data = (await response.json()) as RegisterResponse;
      if (!response.ok) {
        setError(`${response.status} ${data.code ?? "FEHLER"}: ${data.message ?? "Unbekannter Fehler"}`);
        setResult(data);
      } else {
        setResult(data);
        if (data.persisted) {
          onRegistered?.();
          setDevicesVersion((value) => value + 1);
        }
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Netzwerkfehler");
    } finally {
      setBusy(false);
    }
  }

  function handleDownload() {
    if (!pair) {
      setError("Bitte zuerst ein Schlüsselpaar erzeugen.");
      return;
    }

    // Die Adresse kommt aus der Geräteliste bzw. aus der Antwort des Servers:
    // ohne vergebene Adresse gibt es keine gültige Tunnel-Konfiguration.
    if (!clientAddress) {
      setError(
        "Für den Config-Download muss das Gerät registriert sein — die Client-Adresse vergibt der Pool erst dabei.",
      );
      return;
    }

    const serverPublicKey = process.env.NEXT_PUBLIC_WG_SERVER_PUBLIC_KEY ?? "";
    const endpoint = process.env.NEXT_PUBLIC_WG_ENDPOINT ?? "";

    if (!isValidPublicKey(serverPublicKey) || endpoint.length === 0) {
      setError(
        "Für den Config-Download fehlen NEXT_PUBLIC_WG_SERVER_PUBLIC_KEY und NEXT_PUBLIC_WG_ENDPOINT (siehe .env.example).",
      );
      return;
    }

    try {
      const config = buildWireguardConfig({
        privateKeyBase64: pair.privateKeyBase64,
        address: clientAddress,
        serverPublicKeyBase64: serverPublicKey,
        endpoint,
        piholeActive,
        brandSlug: brand.slug,
      });

      const blob = new Blob([config.content], {
        type: "application/x-wireguard-config",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = config.suggestedFileName;
      link.click();
      URL.revokeObjectURL(url);

      setDownloaded(true);
      // Nach dem Download nicht mehr benötigt: Private Key aus dem Speicher werfen.
      wipePrivateKey(pair);
      setPair(null);
      setError(null);
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : "Config-Fehler");
    }
  }

  return (
    <section className="flex flex-col gap-5 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
      {signedIn && !entitled && (
        <p className="rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-sm text-amber-200">
          Für die Geräteregistrierung ist ein aktives Abo erforderlich. Schließe
          zuerst das Abo in der Karte oben ab — der Server weist neue Geräte
          sonst mit 403 ab.
        </p>
      )}

      <form onSubmit={handleRegister} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-300">Gerätename</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={64}
              required
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-300">Plattform</span>
            <select
              value={platform}
              onChange={(event) => setPlatform(event.target.value as Platform)}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
            >
              {PLATFORMS.map((value) => (
                <option key={value} value={value}>
                  {PLATFORM_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {devices.length > 0 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-300">Ziel</span>
            <select
              value={deviceId}
              onChange={(event) => {
                setDeviceId(event.target.value);
                setResult(null);
                setDownloaded(false);
                setError(null);
              }}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
            >
              <option value="">— neues Gerät anlegen —</option>
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} · {device.assignedIp ?? "keine Adresse"}
                </option>
              ))}
            </select>
          </label>
        )}

        {selectedDevice && (
          <p className="text-xs text-slate-400">
            Der neue Public Key ersetzt den bisherigen; Name, Plattform,
            Pi-hole-Einstellung und die Adresse{" "}
            <span className="font-mono text-slate-200">
              {selectedDevice.assignedIp ?? "—"}
            </span>{" "}
            bleiben unverändert.
          </p>
        )}

        <label
          className={`flex items-center gap-2 text-sm ${addonActive ? "text-slate-300" : "text-slate-500"}`}
        >
          <input
            type="checkbox"
            checked={piholeActive}
            disabled={!addonActive}
            onChange={(event) => setPiholeEnabled(event.target.checked)}
            className="h-4 w-4 rounded border-slate-700 bg-slate-950 disabled:opacity-40"
          />
          Pi-hole-Add-on aktiv (DNS 10.9.0.1 statt 1.1.1.1)
        </label>
        {signedIn && !addonActive && (
          <p className="text-xs text-slate-400">
            Das Pi-hole-Add-on ist nicht gebucht. Im Abo hinzufügen, dann steht
            der Filter hier zur Verfügung.
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={handleGenerate}
            className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white"
          >
            Schlüsselpaar erzeugen
          </button>
          <button
            type="submit"
            disabled={busy || !pair || !entitled}
            className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy
              ? "Registriere…"
              : selectedDevice
                ? "Neuen Key an Gerät binden"
                : "Public Key registrieren"}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={!pair}
            className="rounded-md border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            FRITZ!Box-Konfiguration laden
          </button>
        </div>
      </form>

      {pair && (
        <dl className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm">
          <div>
            <dt className="text-slate-400">Public Key (verlässt den Browser)</dt>
            <dd className="mt-1 break-all font-mono text-xs text-sky-300">
              {pair.publicKeyBase64}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Fingerprint</dt>
            <dd className="mt-1 font-mono text-xs text-slate-200">{fingerprint}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Private Key</dt>
            <dd className="mt-1 text-xs text-amber-300">
              bleibt im Browser, wird nicht angezeigt, nicht gesendet und nach
              dem Download aus dem Speicher gelöscht
            </dd>
          </div>
        </dl>
      )}

      {error && (
        <p className="rounded-lg border border-rose-900 bg-rose-950/50 p-3 text-sm text-rose-200">
          {error}
        </p>
      )}

      {result && !error && (
        <p className="rounded-lg border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-200">
          {result.persisted
            ? `Gerät gespeichert: ${result.device?.id ?? "—"}${
                result.device?.assignedIp
                  ? ` · Adresse ${result.device.assignedIp}`
                  : ""
              }${result.device?.reused ? " (bereits registriert)" : ""}`
            : `Serverseitig akzeptiert, aber nicht persistiert (${result.reason ?? "SUPABASE nicht konfiguriert"}).`}
        </p>
      )}

      {!accessToken && (
        <p className="text-xs text-slate-400">
          Ohne Anmeldung läuft die Registrierung im Trockenlauf — es wird kein
          Gerät gespeichert und keine Adresse vergeben.
        </p>
      )}

      {downloaded && (
        <p className="text-xs text-slate-400">
          Konfiguration erzeugt und privater Schlüssel verworfen. Für einen
          weiteren Download neu erzeugen.
        </p>
      )}
    </section>
  );
}
