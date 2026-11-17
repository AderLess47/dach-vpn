#!/usr/bin/env node
/**
 * Prüft die Konfiguration, ohne Werte auszugeben.
 *
 * Liest zusätzlich die Env-Dateien, die Next.js selbst lädt — in dieser
 * Umgebung werden Projekt-Secrets nicht in die Shell injiziert, deshalb ist
 * `apps/dashboard/.env.local` der realistische Ort.
 *
 * Absichtlich nur: gesetzt/leer, Quelle, Länge und strukturelle Plausibilität.
 * Niemals der Wert selbst — dieses Skript darf in Logs und CI laufen.
 */
import { existsSync, readFileSync } from "node:fs";

const ENV_FILES = [
  "apps/dashboard/.env.local",
  "apps/dashboard/.env",
  ".env.local",
  ".env",
];

/** Lädt KEY=VALUE-Zeilen; vorhandene Prozesswerte gewinnen. */
function loadEnvFiles() {
  const sources = new Map();
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, name, rawValue] = match;
      if (process.env[name] !== undefined) continue;
      process.env[name] = rawValue.replace(/^["']|["']$/g, "").trim();
      sources.set(name, file);
    }
  }
  return sources;
}

const sources = loadEnvFiles();
const found = ENV_FILES.filter((file) => existsSync(file));

// Die App liest den Browser-Client aus NEXT_PUBLIC_*, server-seitig mit Fallback.
const REQUIRED = [
  {
    label: "SUPABASE_URL",
    names: ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"],
    plausible: (v) => /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(v),
    hint: "https://<projekt-ref>.supabase.co",
  },
  {
    label: "SUPABASE_ANON_KEY",
    names: ["SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
    plausible: (v) => v.startsWith("sb_publishable_") || v.split(".").length === 3,
    hint: "sb_publishable_… oder JWT",
  },
  {
    label: "SUPABASE_SERVICE_ROLE_KEY",
    names: ["SUPABASE_SERVICE_ROLE_KEY"],
    plausible: (v) => v.startsWith("sb_secret_") || v.split(".").length === 3,
    hint: "sb_secret_… oder JWT",
  },
];

const OPTIONAL = [
  { label: "DATABASE_URL", names: ["DATABASE_URL"], plausible: (v) => v.startsWith("postgres"), hint: "nur Migrationen/CI" },
  { label: "STRIPE_SECRET_KEY", names: ["STRIPE_SECRET_KEY"], plausible: (v) => /^(sk|rk)_(test|live)_/.test(v), hint: "Testmodus: sk_test_…" },
  { label: "STRIPE_WEBHOOK_SECRET", names: ["STRIPE_WEBHOOK_SECRET"], plausible: (v) => v.startsWith("whsec_"), hint: "aus dem Webhook-Endpunkt" },
  { label: "STRIPE_PRICE_ID_BASE", names: ["STRIPE_PRICE_ID_BASE"], plausible: (v) => v.startsWith("price_"), hint: "Basis-Abo" },
  { label: "STRIPE_PRICE_ID_PIHOLE", names: ["STRIPE_PRICE_ID_PIHOLE"], plausible: (v) => v.startsWith("price_"), hint: "Pi-hole-Add-on" },
  { label: "ADMIN_USER_IDS", names: ["ADMIN_USER_IDS"], plausible: (v) => /^[0-9a-f-]{36}(,[0-9a-f-]{36})*$/i.test(v), hint: "Supabase-User-UUID(s)" },
  { label: "DEMO_USER_ID", names: ["DEMO_USER_ID"], plausible: (v) => /^[0-9a-f-]{36}$/i.test(v), hint: "nur PoC-Edge-Function" },
  { label: "NEXT_PUBLIC_APP_URL", names: ["NEXT_PUBLIC_APP_URL"], plausible: (v) => /^https?:\/\//.test(v), hint: "öffentliche Basis-URL" },
  { label: "SENTRY_DSN", names: ["SENTRY_DSN"], plausible: (v) => /^https:\/\/[^@]+@/.test(v), hint: "optional, self-hosted" },
];

let missing = 0;
let suspicious = 0;
const usedAlias = [];

function resolve(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return { name, value };
  }
  return null;
}

function report(entry, required) {
  const hit = resolve(entry.names);
  if (!hit) {
    if (required) missing += 1;
    console.log(`${required ? "✗" : "·"} ${entry.label}: ${required ? "fehlt" : "nicht gesetzt"}`);
    return;
  }

  if (hit.name !== entry.label) usedAlias.push(`${entry.label} ← ${hit.name}`);
  const source = sources.get(hit.name) ?? "Prozess-Env";
  if (entry.plausible(hit.value)) {
    console.log(`✓ ${entry.label}: gesetzt (${hit.value.length} Zeichen, ${source})`);
  } else {
    suspicious += 1;
    console.log(
      `! ${entry.label}: gesetzt (${hit.value.length} Zeichen, ${source}), Form unerwartet — erwartet ${entry.hint}`,
    );
  }
}

console.log(
  found.length > 0 ? `Gelesene Env-Dateien: ${found.join(", ")}` : "Keine Env-Datei gefunden (nur Prozess-Env).",
);
console.log("\nPflicht:");
for (const entry of REQUIRED) report(entry, true);
console.log("\nOptional:");
for (const entry of OPTIONAL) report(entry, false);

if (usedAlias.length > 0) {
  console.log(`\nAlias verwendet: ${usedAlias.join(", ")}`);
}

console.log(`\nErgebnis: ${missing} Pflichtvariable(n) fehlen, ${suspicious} auffällig.`);
if (missing > 0) {
  console.log("Werte gehören in apps/dashboard/.env.local oder Projekt-Secrets — niemals in den Chat oder in Commits.");
}
process.exit(missing > 0 ? 1 : 0);
