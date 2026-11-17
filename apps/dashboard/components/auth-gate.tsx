"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabaseBrowser, supabaseConfigured } from "../lib/supabase-browser";

type Mode = "signin" | "signup";

export function AuthGate({
  children,
}: {
  children: (session: Session | null) => React.ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabaseBrowser) return;

    supabaseBrowser.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabaseBrowser.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!supabaseBrowser) return;

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      if (mode === "signin") {
        const { error: signInError } = await supabaseBrowser.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) setError(signInError.message);
      } else {
        const { data, error: signUpError } = await supabaseBrowser.auth.signUp({
          email,
          password,
        });
        if (signUpError) {
          setError(signUpError.message);
        } else if (!data.session) {
          setMessage(
            "Konto erstellt. Bitte bestätige die E-Mail, bevor du dich anmeldest.",
          );
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    await supabaseBrowser?.auth.signOut();
    setSession(null);
  }

  if (!supabaseConfigured) {
    return (
      <div className="flex flex-col gap-4">
        <p className="rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-sm text-amber-200">
          Supabase Auth ist nicht konfiguriert (`NEXT_PUBLIC_SUPABASE_URL`,
          `NEXT_PUBLIC_SUPABASE_ANON_KEY`). Die Registrierung läuft im
          Trockenlauf und speichert nichts.
        </p>
        {children(null)}
      </div>
    );
  }

  if (!session) {
    return (
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-6"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-slate-100">
            {mode === "signin" ? "Anmelden" : "Konto erstellen"}
          </h2>
          <button
            type="button"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
              setMessage(null);
            }}
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            {mode === "signin" ? "Noch kein Konto?" : "Schon registriert?"}
          </button>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-300">E-Mail</span>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-300">Passwort</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-40"
        >
          {busy ? "Bitte warten…" : mode === "signin" ? "Anmelden" : "Registrieren"}
        </button>

        {error && (
          <p className="rounded-lg border border-rose-900 bg-rose-950/50 p-3 text-sm text-rose-200">
            {error}
          </p>
        )}
        {message && (
          <p className="rounded-lg border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-200">
            {message}
          </p>
        )}
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm">
        <span className="text-slate-300">
          Angemeldet als{" "}
          <span className="font-medium text-slate-100">{session.user.email}</span>
        </span>
        <button
          type="button"
          onClick={handleSignOut}
          className="text-xs text-slate-400 hover:text-slate-200"
        >
          Abmelden
        </button>
      </div>
      {children(session)}
    </div>
  );
}
