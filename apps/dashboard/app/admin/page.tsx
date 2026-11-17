"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "../../components/auth-gate";

interface Metrics {
  subscriptions: {
    active: number;
    pastDue: number;
    canceled: number;
    incomplete: number;
    piholeAddon: number;
  };
  devices: { active: number; revoked: number };
  nodes: Record<string, { free: number; assigned: number }>;
}

type View =
  | { kind: "loading" }
  | { kind: "ready"; metrics: Metrics; fetchedAt: Date }
  | { kind: "blocked"; title: string; detail: string };

const SUBSCRIPTION_LABELS: Array<[keyof Metrics["subscriptions"], string]> = [
  ["active", "Aktiv"],
  ["pastDue", "Zahlung offen"],
  ["canceled", "Gekündigt"],
  ["incomplete", "Unvollständig"],
  ["piholeAddon", "Pi-hole-Add-on"],
];

function Card({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <p className="text-xs uppercase tracking-[0.15em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-50">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function AdminMetrics({ accessToken }: { accessToken: string | null }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!accessToken) {
      setView({
        kind: "blocked",
        title: "Nicht angemeldet",
        detail: "Melde dich an, um die Kennzahlen zu sehen.",
      });
      return;
    }

    let cancelled = false;

    async function load() {
      setBusy(true);
      try {
        const response = await fetch("/api/admin/metrics", {
          headers: { authorization: `Bearer ${accessToken}` },
          cache: "no-store",
        });
        const body = (await response.json().catch(() => ({}))) as {
          metrics?: Metrics;
          code?: string;
          reason?: string;
          message?: string;
        };
        if (cancelled) return;

        if (response.ok && body.metrics) {
          setView({ kind: "ready", metrics: body.metrics, fetchedAt: new Date() });
          return;
        }

        if (response.status === 202 || body.reason === "SUPABASE_NOT_CONFIGURED") {
          setView({
            kind: "blocked",
            title: "Nicht konfiguriert",
            detail:
              "Dem Server fehlen Supabase-Zugangsdaten. Kennzahlen gibt es erst mit konfigurierter Datenbank.",
          });
          return;
        }
        if (response.status === 403) {
          setView({
            kind: "blocked",
            title: "Kein Zugriff",
            detail:
              "Dieses Konto steht nicht in ADMIN_USER_IDS. Die Kennzahlen sind nur für Administratoren sichtbar.",
          });
          return;
        }
        if (response.status === 401) {
          setView({
            kind: "blocked",
            title: "Sitzung ungültig",
            detail: "Bitte melde dich neu an.",
          });
          return;
        }
        if (response.status === 503) {
          setView({
            kind: "blocked",
            title: "Gerade nicht prüfbar",
            detail:
              "Die Anmeldung konnte nicht geprüft werden. In wenigen Sekunden erneut versuchen — die Sitzung bleibt gültig.",
          });
          return;
        }

        setView({
          kind: "blocked",
          title: "Kennzahlen nicht abrufbar",
          detail: `Der Server antwortete mit HTTP ${response.status}${body.code ? ` (${body.code})` : ""}.`,
        });
      } catch {
        if (cancelled) return;
        setView({
          kind: "blocked",
          title: "Keine Verbindung",
          detail: "Der Aufruf ist auf dem Weg zum Server gescheitert.",
        });
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, reloadKey]);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-slate-100">Kennzahlen</h2>
          <p className="text-sm text-slate-400">
            Nur Aggregate — keine Nutzer-IDs, E-Mails oder IP-Adressen.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((value) => value + 1)}
          disabled={busy || !accessToken}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-sky-600 hover:text-sky-300 disabled:opacity-40"
        >
          {busy ? "Lädt…" : "Aktualisieren"}
        </button>
      </div>

      <div aria-live="polite" className="flex flex-col gap-6">
        {view.kind === "loading" && (
          <p className="text-sm text-slate-400">Kennzahlen werden geladen…</p>
        )}

        {view.kind === "blocked" && (
          <div className="rounded-xl border border-amber-900 bg-amber-950/40 p-4 text-sm">
            <p className="font-medium text-amber-200">{view.title}</p>
            <p className="mt-1 text-amber-100/80">{view.detail}</p>
          </div>
        )}

        {view.kind === "ready" && (
          <>
            <div>
              <h3 className="mb-3 text-sm font-medium text-slate-300">Abos</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {SUBSCRIPTION_LABELS.map(([key, label]) => (
                  <Card key={key} label={label} value={view.metrics.subscriptions[key]} />
                ))}
              </div>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-medium text-slate-300">Geräte</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Card label="Aktiv" value={view.metrics.devices.active} />
                <Card label="Widerrufen" value={view.metrics.devices.revoked} />
              </div>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-medium text-slate-300">IP-Pool je Knoten</h3>
              {Object.keys(view.metrics.nodes).length === 0 ? (
                <p className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400">
                  Noch kein Knoten angelegt. Ohne Pool kann die Registrierung keine
                  Adresse vergeben.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-900/80 text-left text-xs uppercase tracking-[0.12em] text-slate-500">
                      <tr>
                        <th className="px-4 py-2 font-medium">Knoten</th>
                        <th className="px-4 py-2 text-right font-medium">Frei</th>
                        <th className="px-4 py-2 text-right font-medium">Vergeben</th>
                        <th className="px-4 py-2 text-right font-medium">Gesamt</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 text-slate-200">
                      {Object.entries(view.metrics.nodes).map(([nodeId, pool]) => (
                        <tr key={nodeId}>
                          <td className="px-4 py-2 font-mono text-xs text-slate-300">{nodeId}</td>
                          <td className="px-4 py-2 text-right">{pool.free}</td>
                          <td className="px-4 py-2 text-right">{pool.assigned}</td>
                          <td className="px-4 py-2 text-right text-slate-400">
                            {pool.free + pool.assigned}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <p className="text-xs text-slate-500">
              Stand{" "}
              {view.fetchedAt.toLocaleTimeString("de-DE", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}{" "}
              Uhr.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

export default function AdminPage() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-400">
          Administration
        </p>
        <h1 className="text-3xl font-semibold text-slate-50">Kennzahlen</h1>
        <p className="text-slate-300">
          Abos, Geräte und Adresspool in Zahlen. Zugriff über die Allowlist
          {" "}
          <code className="rounded bg-slate-900 px-1 py-0.5 text-xs text-slate-300">
            ADMIN_USER_IDS
          </code>
          , nicht über eine eigene Rolle — und bewusst ohne jeden Personenbezug.
        </p>
        <a className="text-sm text-sky-400 hover:text-sky-300" href="/">
          ← Zurück zum Dashboard
        </a>
      </header>

      <AuthGate>
        {(session) => <AdminMetrics accessToken={session?.access_token ?? null} />}
      </AuthGate>
    </main>
  );
}
