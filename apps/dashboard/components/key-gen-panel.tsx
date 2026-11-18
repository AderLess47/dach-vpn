"use client";

import { useState } from "react";
import {
  buildWireguardConfig,
  generateDeviceKeyPair,
  isValidPublicKey,
  publicKeyFingerprint,
  wipePrivateKey,
  type DeviceKeyPair,
} from "@dachvpn/crypto";
import { PLATFORMS, type Platform } from "@dachvpn/shared";

interface RegisterResponse {
  persisted?: boolean;
  reason?: string;
  code?: string;
  message?: string;
  device?: { id: string; assignedIp: string | null; reused: boolean };
}

const PLATFORM_LABELS: Record<Platform, string> = {
  web: "Web",
  ios: "iOS",
  android: "Android",
  tvos: "tvOS",
  firetv: "Fire TV",
};

export function KeyGenPanel({
  accessToken,
  onRegistered,
}: {
  accessToken: string | null;
  onRegistered?: () => void;
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

    // Bewusst explizit aufgebaut: der Request enthält genau diese vier Felder.
    // Der private Schlüssel existiert in dieser Funktion nicht als Variable,
    // die in den Body gelangen könnte.
    const payload = {
      name,
      platform,
      publicKey: pair.publicKeyBase64,
      piholeEnabled,
    };

    try {
      const response = await fetch("/api/devices/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as RegisterResponse;
      if (!response.ok) {
        setError(`${response.status} ${data.code ?? "FEHLER"}: ${data.message ?? "Unbekannter Fehler"}`);
        setResult(data);
      } else {
        setResult(data);
        if (data.persisted) onRegistered?.();
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
        address: "10.8.0.2/32",
        serverPublicKeyBase64: serverPublicKey,
        endpoint,
        piholeActive: piholeEnabled,
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

        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={piholeEnabled}
            onChange={(event) => setPiholeEnabled(event.target.checked)}
            className="h-4 w-4 rounded border-slate-700 bg-slate-950"
          />
          Pi-hole-Add-on aktiv (DNS 10.9.0.1 statt 1.1.1.1)
        </label>

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
            disabled={busy || !pair}
            className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Registriere…" : "Public Key registrieren"}
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
