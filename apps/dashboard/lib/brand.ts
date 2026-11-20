import { headers } from "next/headers";
import { normalizeHost, resolveBrandForTenant, type Brand } from "@dachvpn/shared";
import { serviceClient } from "./api-auth";

/**
 * Marke pro Request — Auflösung über den Host, ohne Rebuild.
 *
 * Reihenfolge: Mandant aus der Datenbank (Domain → Marke) → `NEXT_PUBLIC_APP_NAME`
 * → Default. Der Name wird damit zur Laufzeit bestimmt; ein neuer Mandant ist
 * eine Zeile in `tenant_domains` plus ein Cache-Ablauf, kein Deployment.
 *
 * Sicherheit: Der Host-Header ist vom Client wählbar und entscheidet hier
 * ausschließlich über die *Darstellung*. Er ist keine Autorisierung — Daten
 * bleiben durch RLS und die serverseitig geprüfte Nutzer-ID geschützt.
 *
 * Robustheit: Ohne konfiguriertes Supabase (Trockenlauf, CI-Build) oder bei
 * einem Datenbankfehler wird nie geworfen, sondern auf die Env-Marke
 * zurückgefallen. Ein Markenproblem darf die Seite nicht unbrauchbar machen.
 */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;
const LOOKUP_TIMEOUT_MS = 1_000;

const cache = new Map<string, { brand: Brand; expiresAt: number }>();
/** Laufende Auflösungen: Metadata und Seite fragen im selben Request parallel. */
const inflight = new Map<string, Promise<Brand>>();

async function lookupTenantBrand(
  domain: string,
  fallbackName: string | null,
): Promise<Brand> {
  const client = serviceClient();
  if (!client) return resolveBrandForTenant(null, fallbackName);

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const lookup = client
      .rpc("resolve_tenant_brand", { p_domain: domain })
      .then(({ data, error }) => (error ? null : data));

    // Ein hängender Datenbankaufruf darf das Rendern nicht blockieren.
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
    });

    const row = await Promise.race([lookup, timeout]);
    return resolveBrandForTenant(row, fallbackName);
  } catch {
    return resolveBrandForTenant(null, fallbackName);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Marke für einen Host. Unbekannte oder ungültige Hosts bekommen die Standardmarke. */
export async function brandForHost(host: string | null): Promise<Brand> {
  const fallbackName = process.env.NEXT_PUBLIC_APP_NAME ?? null;
  const domain = normalizeHost(host);
  if (!domain) return resolveBrandForTenant(null, fallbackName);

  const cached = cache.get(domain);
  if (cached && cached.expiresAt > Date.now()) return cached.brand;

  // Ohne diese Zusammenfassung fragt jeder Request zweimal: einmal für die
  // Metadata, einmal für die Seite — beide starten vor dem ersten Cache-Eintrag.
  const pending = inflight.get(domain);
  if (pending) return pending;

  const brand = lookupTenantBrand(domain, fallbackName)
    .then((resolved) => {
      // Auch Fehlschläge werden kurz gecacht: sonst erzeugt jede Anfrage mit
      // erfundenem Host eine Datenbankabfrage.
      cache.set(domain, { brand: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
      if (cache.size > CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      return resolved;
    })
    .finally(() => {
      inflight.delete(domain);
    });

  inflight.set(domain, brand);
  return brand;
}

/** Marke des aktuellen Requests (Server Components, Metadata, Route Handler). */
export async function getRequestBrand(): Promise<Brand> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");

  return brandForHost(host);
}
