"use client";

import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "../lib/supabase-browser";

interface SubscriptionRow {
  status: string;
  pihole_addon_active: boolean;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  stripe_customer_id: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  active: "Aktiv",
  trialing: "Testphase",
  past_due: "Zahlung offen",
  canceled: "Beendet",
  incomplete: "Unvollständig",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function SubscriptionCard({ accessToken }: { accessToken: string | null }) {
  const [row, setRow] = useState<SubscriptionRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [addon, setAddon] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabaseBrowser || !accessToken) {
      setLoading(false);
      return;
    }
    const { data, error: loadError } = await supabaseBrowser
      .from("subscriptions")
      .select("status, pihole_addon_active, current_period_end, cancel_at_period_end, stripe_customer_id")
      .maybeSingle();

    if (loadError) setError(loadError.message);
    else setRow((data as SubscriptionRow | null) ?? null);
    setLoading(false);
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(url: string, body: unknown) {
    if (!accessToken) {
      setError("Bitte zuerst anmelden.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as {
        url?: string;
        code?: string;
        message?: string;
        reason?: string;
      };

      if (response.status === 202) {
        setNotice("Stripe ist nicht konfiguriert — der Abo-Flow läuft im Trockenlauf.");
        return;
      }
      if (!response.ok) {
        setError(`${response.status} ${data.code ?? "FEHLER"}: ${data.message ?? ""}`.trim());
        return;
      }
      if (data.url) {
        window.location.assign(data.url);
        return;
      }
      setNotice("Erledigt.");
      void load();
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Netzwerkfehler");
    } finally {
      setBusy(false);
    }
  }

  const active = row?.status === "active";
  const hasCustomer = Boolean(row?.stripe_customer_id);

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium text-slate-100">Abo</h2>
        <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">
          {loading ? "lädt…" : (STATUS_LABEL[row?.status ?? "incomplete"] ?? row?.status ?? "kein Abo")}
        </span>
      </div>

      {row ? (
        <dl className="grid grid-cols-2 gap-2 text-sm text-slate-400">
          <dt>Pi-hole Add-on</dt>
          <dd className="text-slate-200">{row.pihole_addon_active ? "aktiv" : "nicht aktiv"}</dd>
          <dt>Verlängert/endet</dt>
          <dd className="text-slate-200">
            {formatDate(row.current_period_end)}
            {row.cancel_at_period_end ? " (gekündigt zum Periodenende)" : ""}
          </dd>
        </dl>
      ) : (
        <p className="text-sm text-slate-400">
          Noch kein Abo. Der Checkout läuft über Stripe; Kündigung später zum Periodenende.
        </p>
      )}

      {!active && (
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={addon}
            onChange={(event) => setAddon(event.target.checked)}
            className="h-4 w-4 rounded border-slate-700 bg-slate-950"
          />
          Pi-hole Add-on mitbuchen
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        {!active && (
          <button
            type="button"
            disabled={busy || !accessToken}
            onClick={() => void post("/api/stripe/checkout", { addon })}
            className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-40"
          >
            {busy ? "Bitte warten…" : "Abo abschließen"}
          </button>
        )}
        {hasCustomer && (
          <button
            type="button"
            disabled={busy || !accessToken}
            onClick={() => void post("/api/stripe/portal", {})}
            className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500 disabled:opacity-40"
          >
            Abo verwalten / kündigen
          </button>
        )}
      </div>

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
