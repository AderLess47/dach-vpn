#!/usr/bin/env bun
/**
 * Rendert die Marke in die Supabase-Mail-Vorlagen.
 *
 * Warum ein Skript und kein zweiter Name im HTML: Supabase speichert die
 * Vorlagen als statisches HTML, kann aber keine Umgebungsvariablen einsetzen.
 * Der Name stünde damit ein zweites Mal im Code — genau die Drift, die das
 * Brand-Modul verhindert. Deshalb stehen im HTML Marker-Kommentare, und dieses
 * Skript setzt den Namen aus `packages/shared/src/brand.ts` ein.
 *
 * Aufruf (Projektwurzel):
 *   bun run mail:render                                 # schreibt die Vorlagen
 *   NEXT_PUBLIC_APP_NAME="Acme VPN" bun run mail:render  # Mandant
 *   bun run mail:check                                  # prüft nur (CI), Exit 1 bei Abweichung
 *
 * Die Marker bleiben in der Datei, damit ein zweiter Lauf mit anderer Marke
 * wieder greift. Sie sind HTML-Kommentare und für Mail-Clients unsichtbar.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolveBrand } from "../packages/shared/src/brand.ts";

const ROOT = new URL("../", import.meta.url);
const TEMPLATES = ["confirmation.html", "reset-password.html"].map((name) => ({
  url: new URL(`supabase/templates/${name}`, ROOT),
  label: `supabase/templates/${name}`,
}));

const checkOnly = process.argv.includes("--check");
const brand = resolveBrand({ name: process.env.NEXT_PUBLIC_APP_NAME });

/** Markenwerte landen als Text im HTML — `&` und `<` dürfen es nicht sprengen. */
function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const REGIONS = {
  name: { value: escapeHtml(brand.name), label: "Markenname" },
  footer: {
    value: `${escapeHtml(brand.name)} · ${escapeHtml(brand.tagline)}`,
    label: "Fußzeile",
  },
};

function render(html, file) {
  let rendered = html;

  for (const [key, region] of Object.entries(REGIONS)) {
    const pattern = new RegExp(
      `(<!-- brand:${key} -->)[\\s\\S]*?(<!-- /brand:${key} -->)`,
      "g",
    );

    if (!pattern.test(rendered)) {
      throw new Error(
        `${file}: ${region.label} fehlt (erwartet <!-- brand:${key} --> … <!-- /brand:${key} -->).`,
      );
    }

    // Funktion als Ersatz: ein Wert mit `$&` darf nicht als Muster wirken.
    rendered = rendered.replace(
      pattern,
      (_match, open, close) => `${open}${region.value}${close}`,
    );
  }

  return rendered;
}

let updated = 0;
let failed = 0;

for (const { url, label } of TEMPLATES) {
  let before;
  try {
    before = readFileSync(url, "utf8");
  } catch {
    console.error(`FEHLT      ${label}`);
    failed += 1;
    continue;
  }

  let after;
  try {
    after = render(before, label);
  } catch (error) {
    console.error(`FEHLER     ${error instanceof Error ? error.message : error}`);
    failed += 1;
    continue;
  }

  if (before === after) {
    console.log(`OK         ${label}`);
    continue;
  }

  if (checkOnly) {
    console.error(`ABWEICHUNG ${label} — "bun run mail:render" ausführen und committen`);
    failed += 1;
    continue;
  }

  writeFileSync(url, after, "utf8");
  console.log(`GERENDERT  ${label}`);
  updated += 1;
}

const source = process.env.NEXT_PUBLIC_APP_NAME ? "NEXT_PUBLIC_APP_NAME" : "Default";
console.log(`\nMarke: ${brand.name} (Slug ${brand.slug}, Quelle: ${source})`);

if (failed > 0) {
  console.error(`${failed} Vorlage(n) nicht in Ordnung.`);
  process.exit(1);
}

console.log(
  checkOnly
    ? `Alle ${TEMPLATES.length} Vorlagen entsprechen der Marke.`
    : updated === 0
      ? "Nichts zu tun."
      : `${updated} Vorlage(n) aktualisiert — im Supabase-Dashboard neu einfügen (siehe supabase/templates/README.md).`,
);
