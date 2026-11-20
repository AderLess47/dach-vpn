/**
 * Zentrale Marke (Single Source of Truth).
 *
 * Der Anzeigename erscheint an mehreren Stellen: Metadata der Seite, Kopfzeile
 * im Dashboard, Dateiname der WireGuard-Konfiguration und später in den
 * Mail-Templates und der Mobile-App. Ein zweiter, kopierter String wäre genau
 * die Drift, die wir beim Private-Key-Guard vermeiden — deshalb steht der Name
 * genau hier.
 *
 * Bewusst rein: keine `process.env`-Zugriffe, keine Laufzeit-Abhängigkeiten.
 * Die Umgebung liest ausschließlich der Rand (`apps/dashboard/lib/brand.ts`);
 * Browser, Next.js und Tests sehen dieselbe Funktion. Damit ist dieses Modul
 * auch der Anschlusspunkt für White-Label-Mandanten: statt der Env-Variable
 * kommt später der Tenant-Datensatz (Domain → Marke) herein, ohne dass UI- oder
 * Krypto-Code sich ändern.
 */

export interface Brand {
  /** Anzeigename, z. B. "HubGuard". */
  name: string;
  /** Datei- und URL-sicherer Slug, z. B. "hubguard". */
  slug: string;
  /** Kurzbeschreibung für Metadata und Fußzeilen. */
  tagline: string;
}

/** Marke, die gilt, wenn weder Env-Variable noch Mandant etwas anderes sagen. */
export const DEFAULT_BRAND: Brand = Object.freeze({
  name: "HubGuard",
  slug: "hubguard",
  tagline: "No-Log-VPN mit Pi-hole-Add-on",
});

export const BRAND_NAME_MAX_LENGTH = 48;
export const BRAND_SLUG_MAX_LENGTH = 32;
export const BRAND_TAGLINE_MAX_LENGTH = 120;

/**
 * Überschreibungen eines Mandanten.
 *
 * Alle Felder sind optional: fehlt eines, greift der Default. `null` wird wie
 * "nicht gesetzt" behandelt, damit ein leerer Datenbankwert keinen leeren Namen
 * in die UI schreibt.
 */
export interface BrandOverrides {
  name?: string | null;
  slug?: string | null;
  tagline?: string | null;
}

const UMLAUTS: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  Ä: "Ae",
  Ö: "Oe",
  Ü: "Ue",
  ß: "ss",
};

/**
 * Macht aus beliebigem Text einen Dateinamen-Slug.
 *
 * Der Slug landet im Dateinamen der WireGuard-Konfiguration. Deshalb werden
 * alle Zeichen außer `a-z`, `0-9` und `-` ersetzt: ein Name wie
 * `../../etc/passwd` darf keinen Pfadanteil in den Download bringen.
 * Umlaute werden transliteriert, damit der Name lesbar bleibt ("Müller" →
 * "mueller" statt "m-ller").
 */
export function brandSlug(value: string): string {
  const transliterated = value.replace(/[äöüÄÖÜß]/g, (char) => UMLAUTS[char] ?? char);
  const ascii = transliterated.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, BRAND_SLUG_MAX_LENGTH)
    .replace(/-+$/, "");

  return slug;
}

function cleanText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0 || collapsed.length > maxLength) return null;
  return collapsed;
}

/**
 * Erzeugt die gültige Marke aus optionalen Überschreibungen.
 *
 * Reihenfolge beim Slug: expliziter Slug → aus dem Namen abgeleitet → Default.
 * Ein ungültiger oder leerer Wert führt zum Default statt zu einem leeren
 * Namen in der Oberfläche; die Funktion wirft nie, weil sie beim Rendern läuft.
 */
export function resolveBrand(overrides: BrandOverrides = {}): Brand {
  const name = cleanText(overrides.name, BRAND_NAME_MAX_LENGTH) ?? DEFAULT_BRAND.name;
  const explicitSlug = typeof overrides.slug === "string" ? brandSlug(overrides.slug) : "";
  const slug = explicitSlug || brandSlug(name) || DEFAULT_BRAND.slug;
  const tagline =
    cleanText(overrides.tagline, BRAND_TAGLINE_MAX_LENGTH) ?? DEFAULT_BRAND.tagline;

  return { name, slug, tagline };
}

/** Maximal erlaubte Länge eines Hostnamens (RFC 1035). */
export const HOST_MAX_LENGTH = 253;

const HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Normalisiert den Request-Host für die Mandanten-Auflösung.
 *
 * Der Host-Header ist vom Client frei wählbar. Er entscheidet hier nur über die
 * *Darstellung* (welche Marke gerendert wird), nie über Berechtigungen — trotzdem
 * wird streng validiert: kein Port, keine Pfade, keine Benutzeranteile, keine
 * IPv6-Literale, nur `a-z`, `0-9`, `-` und `.`, maximal 253 Zeichen. Was nicht
 * passt, liefert `null` und fällt auf die Standardmarke zurück.
 *
 * `x-forwarded-host` kann eine Liste enthalten; ausgewertet wird der erste
 * Eintrag (der Host, den der Client angefragt hat).
 */
export function normalizeHost(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const first = value.split(",")[0] ?? "";
  let host = first.trim().toLowerCase();

  if (host.startsWith("[")) return null;

  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);

  host = host.replace(/\.$/, "");

  if (host.length === 0 || host.length > HOST_MAX_LENGTH) return null;
  if (!HOST_PATTERN.test(host)) return null;

  return host;
}

/**
 * Liest Markenfelder aus einer Datenbankzeile (oder einem RPC-Ergebnis).
 *
 * Nur Zeichenketten werden übernommen; alles andere — Zahlen, Objekte,
 * Prototype-Anteile — fällt weg. So kann ein manipulierter oder unerwarteter
 * Datensatz keine ungültige Marke in die Oberfläche schreiben.
 */
export function brandOverridesFromRow(row: unknown): BrandOverrides {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return {};

  const source = row as Record<string, unknown>;
  const overrides: BrandOverrides = {};
  if (typeof source.name === "string") overrides.name = source.name;
  if (typeof source.slug === "string") overrides.slug = source.slug;
  if (typeof source.tagline === "string") overrides.tagline = source.tagline;

  return overrides;
}

/**
 * Marke für einen Request: Mandant hat Vorrang, sonst die Env-Variable, sonst
 * der Default. Ein Mandant ohne brauchbare Felder zählt als "kein Mandant".
 */
export function resolveBrandForTenant(
  tenantRow: unknown,
  fallbackName?: string | null,
): Brand {
  const overrides = brandOverridesFromRow(tenantRow);

  if (overrides.name || overrides.slug || overrides.tagline) {
    return resolveBrand(overrides);
  }

  return resolveBrand({ name: fallbackName ?? null });
}
