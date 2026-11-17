/**
 * Gemeinsamer Vertrag für die Geräteregistrierung (M1).
 *
 * Bewusst ohne Laufzeit-Abhängigkeiten: derselbe Code läuft im Next.js-Route-Handler
 * und in der Supabase Edge Function (Deno). Ein Sicherheits-Guard, der in zwei
 * Implementierungen existiert, driftet — deshalb genau eine Quelle.
 *
 * Schutzziel: Der Server akzeptiert ausschließlich Public Keys. Alles, was nach
 * privatem Schlüsselmaterial aussieht, wird verworfen — und zwar bevor validiert,
 * gespeichert oder geloggt wird.
 */

export const PLATFORMS = ["web", "ios", "android", "tvos", "firetv"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface RegisterDeviceRequest {
  name: string;
  platform: Platform;
  /** 32-Byte-Curve25519-Public-Key, Base64 (44 Zeichen, ein '=' Padding). */
  publicKey: string;
  piholeEnabled?: boolean;
}

export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

const ALLOWED_FIELDS = ["name", "platform", "publicKey", "piholeEnabled"] as const;
const PRIVATE_KEY_FIELD = /(private|priv_?key|secret|seed|mnemonic|passphrase)/i;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const MAX_DEPTH = 8;
const NAME_MAX_LENGTH = 64;

export type GuardCode =
  | "INVALID_PAYLOAD"
  | "UNKNOWN_FIELD"
  | "PRIVATE_KEY_MATERIAL";

export type GuardResult =
  | { ok: true; data: RegisterDeviceRequest }
  | {
      ok: false;
      status: 400 | 422;
      code: GuardCode;
      message: string;
      fields?: string[];
    };

/**
 * Sucht rekursiv nach privatem Schlüsselmaterial.
 * Erkennt (a) Feldnamen, die auf private/secret/seed deuten und (b) PEM-Blöcke in Werten.
 */
export function findPrivateKeyMaterial(
  input: unknown,
  path = "$",
  depth = 0,
): string[] {
  if (depth > MAX_DEPTH) return [`${path}:max-depth-exceeded`];

  if (typeof input === "string") {
    return PEM_PRIVATE_KEY.test(input) ? [path] : [];
  }

  if (Array.isArray(input)) {
    return input.flatMap((value, index) =>
      findPrivateKeyMaterial(value, `${path}[${index}]`, depth + 1),
    );
  }

  if (input !== null && typeof input === "object") {
    return Object.entries(input as Record<string, unknown>).flatMap(
      ([key, value]) => {
        const childPath = `${path}.${key}`;
        const hits = PRIVATE_KEY_FIELD.test(key) ? [childPath] : [];
        return [...hits, ...findPrivateKeyMaterial(value, childPath, depth + 1)];
      },
    );
  }

  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Prüft einen Registrierungs-Payload vollständig.
 *
 * Reihenfolge ist Absicht: erst Private-Key-Scan (422), dann Struktur (400).
 * Ein Request, der einen privaten Schlüssel enthält, wird nie mit "Felder fehlen"
 * beantwortet — er ist ein Sicherheitsereignis, kein Tippfehler.
 */
export function guardRegisterDevice(payload: unknown): GuardResult {
  const privateHits = findPrivateKeyMaterial(payload);
  if (privateHits.length > 0) {
    return {
      ok: false,
      status: 422,
      code: "PRIVATE_KEY_MATERIAL",
      message:
        "Der Payload enthält privates Schlüsselmaterial. Der Server akzeptiert ausschließlich Public Keys; die Schlüsselerzeugung findet im Client statt.",
      fields: privateHits,
    };
  }

  if (!isPlainObject(payload)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_PAYLOAD",
      message: "Erwartet wird ein JSON-Objekt.",
    };
  }

  const unknownFields = Object.keys(payload).filter(
    (key) => !(ALLOWED_FIELDS as readonly string[]).includes(key),
  );
  if (unknownFields.length > 0) {
    return {
      ok: false,
      status: 400,
      code: "UNKNOWN_FIELD",
      message: `Unbekannte Felder: ${unknownFields.join(", ")}. Erlaubt sind: ${ALLOWED_FIELDS.join(", ")}.`,
      fields: unknownFields,
    };
  }

  const errors: string[] = [];

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (name.length < 1 || name.length > NAME_MAX_LENGTH) {
    errors.push(`name: 1 bis ${NAME_MAX_LENGTH} Zeichen`);
  }

  const platform = payload.platform;
  if (
    typeof platform !== "string" ||
    !(PLATFORMS as readonly string[]).includes(platform)
  ) {
    errors.push(`platform: einer von ${PLATFORMS.join(", ")}`);
  }

  const publicKey = payload.publicKey;
  if (typeof publicKey !== "string" || !PUBLIC_KEY_PATTERN.test(publicKey)) {
    errors.push("publicKey: 32 Byte Curve25519 als Base64 (44 Zeichen)");
  }

  if (
    payload.piholeEnabled !== undefined &&
    typeof payload.piholeEnabled !== "boolean"
  ) {
    errors.push("piholeEnabled: boolean");
  }

  if (errors.length > 0) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_PAYLOAD",
      message: `Ungültiger Payload: ${errors.join("; ")}.`,
    };
  }

  const data: RegisterDeviceRequest = {
    name,
    platform: platform as Platform,
    publicKey: publicKey as string,
  };
  if (payload.piholeEnabled !== undefined) {
    data.piholeEnabled = payload.piholeEnabled as boolean;
  }

  return { ok: true, data };
}

/**
 * Liest den Bearer-Token aus dem Authorization-Header.
 *
 * Bewusst streng: nur `Bearer <token>`, keine Toleranz für andere Schemata
 * oder mehrere Werte. Ein leerer/ungültiger Header bedeutet "nicht angemeldet"
 * und wird von der Route als 401 behandelt — niemals als anonymer Zugriff.
 */
export * from "./stripe";

export function parseBearerToken(
  header: string | null | undefined,
): string | null {
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9._-]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * DNS-Ziel abhängig vom Pi-hole-Add-on.
 * Wird clientseitig (Config) und serverseitig (Soll-Zustand für den Agenten) genutzt.
 */
export function resolveDns(piholeActive: boolean): string {
  return piholeActive
    ? (process.env.WG_DNS_FILTERED ?? "10.9.0.1")
    : (process.env.WG_DNS_PLAIN ?? "1.1.1.1");
}
