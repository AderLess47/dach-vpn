/**
 * Client-seitige Curve25519-Erzeugung und WireGuard-Konfiguration (M1).
 *
 * Diese Datei ist für die Ausführung im Browser gedacht. Sie erzeugt das
 * Schlüsselpaar lokal und baut die .conf für die FRITZ!Box zusammen — der
 * private Schlüssel muss dafür keinen Server sehen (siehe Angebot, Abschnitt 3.1).
 */

import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

export const DNS_FILTERED_DEFAULT = "10.9.0.1";
export const DNS_PLAIN_DEFAULT = "1.1.1.1";
export const DEFAULT_MTU = 1420;
export const DEFAULT_KEEPALIVE = 25;

export interface DeviceKeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  /** Base64 des privaten Schlüssels — nur für die lokale .conf, nie für den Server. */
  privateKeyBase64: string;
  /** Base64 des öffentlichen Schlüssels — das ist der einzige Wert, der das Gerät verlässt. */
  publicKeyBase64: string;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Erzeugt ein neues Curve25519-Schlüsselpaar im aktuellen Kontext.
 * `crypto.getRandomValues` ist die einzige Zufallsquelle — kein Math.random.
 */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const privateKey = new Uint8Array(32);
  crypto.getRandomValues(privateKey);
  const publicKey = x25519.getPublicKey(privateKey);

  return {
    privateKey,
    publicKey,
    privateKeyBase64: toBase64(privateKey),
    publicKeyBase64: toBase64(publicKey),
  };
}

/** Prüft, ob ein Base64-String ein gültiger X25519-Public-Key ist. */
export function isValidPublicKey(publicKeyBase64: string): boolean {
  try {
    const bytes = fromBase64(publicKeyBase64);
    return bytes.length === 32 && toBase64(bytes) === publicKeyBase64;
  } catch {
    return false;
  }
}

/**
 * Kurzer Fingerprint zur Anzeige im Dashboard (keine Rückschlüsse auf den Key).
 * 8 Zeichen Base64 aus SHA-256 — genug zur Wiedererkennung, zu wenig zum Angriff.
 */
export function publicKeyFingerprint(publicKeyBase64: string): string {
  const digest = sha256(fromBase64(publicKeyBase64));
  return toBase64(digest).slice(0, 8);
}

export interface WireguardConfigInput {
  privateKeyBase64: string;
  /** Client-Adresse aus dem IP-Pool, z. B. "10.8.0.7/32". */
  address: string;
  serverPublicKeyBase64: string;
  /** z. B. "vpn.example.com:51820". */
  endpoint: string;
  /** Pi-hole aktiv? Entscheidet über den DNS-Eintrag. */
  piholeActive: boolean;
  dnsFiltered?: string;
  dnsPlain?: string;
  allowedIps?: string;
  mtu?: number;
  keepalive?: number;
}

export interface WireguardConfig {
  /** Fertiger Dateiinhalt — enthält den privaten Schlüssel, bleibt im Client. */
  content: string;
  /** DNS-Eintrag, der in der Datei gelandet ist (für Anzeige und Tests). */
  dns: string;
  suggestedFileName: string;
}

/**
 * Baut die WireGuard-Konfiguration für die FRITZ!Box.
 *
 * Die FRITZ!Box importiert ausschließlich Dateien mit privatem Schlüssel —
 * genau deshalb entsteht diese Datei im Browser und wird nie hochgeladen.
 */
export function buildWireguardConfig(
  input: WireguardConfigInput,
): WireguardConfig {
  if (!isValidPublicKey(input.serverPublicKeyBase64)) {
    throw new Error("serverPublicKeyBase64 ist kein gültiger X25519-Public-Key.");
  }
  if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(input.address)) {
    throw new Error(`Ungültige Client-Adresse: ${input.address}`);
  }
  if (!/^[^\s]+:\d{1,5}$/.test(input.endpoint)) {
    throw new Error(`Ungültiger Endpoint: ${input.endpoint}`);
  }

  const dns = input.piholeActive
    ? (input.dnsFiltered ?? DNS_FILTERED_DEFAULT)
    : (input.dnsPlain ?? DNS_PLAIN_DEFAULT);

  const lines = [
    "[Interface]",
    `PrivateKey = ${input.privateKeyBase64}`,
    `Address = ${input.address}`,
    `DNS = ${dns}`,
    `MTU = ${input.mtu ?? DEFAULT_MTU}`,
    "",
    "[Peer]",
    `PublicKey = ${input.serverPublicKeyBase64}`,
    `AllowedIPs = ${input.allowedIps ?? "0.0.0.0/0, ::/0"}`,
    `Endpoint = ${input.endpoint}`,
    `PersistentKeepalive = ${input.keepalive ?? DEFAULT_KEEPALIVE}`,
    "",
  ];

  return {
    content: lines.join("\n"),
    dns,
    suggestedFileName: input.piholeActive
      ? "dachvpn-pihole.conf"
      : "dachvpn.conf",
  };
}

/** Erzwingt das Verwerfen des privaten Schlüssels aus dem Speicher (nach Download). */
export function wipePrivateKey(pair: DeviceKeyPair): void {
  pair.privateKey.fill(0);
  pair.privateKeyBase64 = "";
}
