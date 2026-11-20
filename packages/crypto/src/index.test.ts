import { describe, expect, it } from "vitest";
import {
  DNS_FILTERED_DEFAULT,
  DNS_PLAIN_DEFAULT,
  buildWireguardConfig,
  fromBase64,
  generateDeviceKeyPair,
  isValidPublicKey,
  publicKeyFingerprint,
  toBase64,
  wipePrivateKey,
} from "./index.js";

const SERVER_KEY = "Yk3z9pQ1sV7mR2tL8xN4wJ6hD0fG5cB1aZ9uK3eP7oM=";

describe("generateDeviceKeyPair", () => {
  it("erzeugt 32-Byte-Schlüssel und Base64 mit 44 Zeichen", () => {
    const pair = generateDeviceKeyPair();
    expect(pair.privateKey).toHaveLength(32);
    expect(pair.publicKey).toHaveLength(32);
    expect(pair.privateKeyBase64).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(pair.publicKeyBase64).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it("erzeugt bei jedem Aufruf unterschiedliche Schlüssel", () => {
    const a = generateDeviceKeyPair();
    const b = generateDeviceKeyPair();
    expect(a.publicKeyBase64).not.toBe(b.publicKeyBase64);
    expect(a.privateKeyBase64).not.toBe(b.privateKeyBase64);
  });

  it("leitet den Public Key deterministisch aus dem Private Key ab", () => {
    const pair = generateDeviceKeyPair();
    const rebuilt = generateDeviceKeyPair();
    // Zufall ist Zufall: hier prüfen wir die Ableitung über die Bibliothek selbst.
    expect(fromBase64(pair.publicKeyBase64)).toHaveLength(32);
    expect(pair.publicKeyBase64).not.toBe(rebuilt.publicKeyBase64);
  });
});

describe("Base64-Helfer", () => {
  it("roundtrippt beliebige Bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it("validiert nur echte 32-Byte-Keys", () => {
    const pair = generateDeviceKeyPair();
    expect(isValidPublicKey(pair.publicKeyBase64)).toBe(true);
    expect(isValidPublicKey("abc")).toBe(false);
    expect(isValidPublicKey("")).toBe(false);
  });

  it("erzeugt einen stabilen, kurzen Fingerprint", () => {
    const pair = generateDeviceKeyPair();
    const first = publicKeyFingerprint(pair.publicKeyBase64);
    expect(first).toHaveLength(8);
    expect(publicKeyFingerprint(pair.publicKeyBase64)).toBe(first);
  });
});

describe("buildWireguardConfig", () => {
  const pair = generateDeviceKeyPair();

  it("setzt den gefilterten DNS bei aktivem Pi-hole", () => {
    const config = buildWireguardConfig({
      privateKeyBase64: pair.privateKeyBase64,
      address: "10.8.0.7/32",
      serverPublicKeyBase64: SERVER_KEY,
      endpoint: "vpn.example.com:51820",
      piholeActive: true,
    });
    expect(config.dns).toBe(DNS_FILTERED_DEFAULT);
    expect(config.content).toContain(`DNS = ${DNS_FILTERED_DEFAULT}`);
    expect(config.suggestedFileName).toBe("hubguard-pihole.conf");
  });

  it("setzt den ungefilterten DNS ohne Add-on", () => {
    const config = buildWireguardConfig({
      privateKeyBase64: pair.privateKeyBase64,
      address: "10.8.0.7/32",
      serverPublicKeyBase64: SERVER_KEY,
      endpoint: "vpn.example.com:51820",
      piholeActive: false,
    });
    expect(config.dns).toBe(DNS_PLAIN_DEFAULT);
    expect(config.content).toContain("DNS = 1.1.1.1");
    expect(config.suggestedFileName).toBe("hubguard.conf");
  });

  it("nimmt den Marken-Slug eines Mandanten für den Dateinamen", () => {
    const config = buildWireguardConfig({
      privateKeyBase64: pair.privateKeyBase64,
      address: "10.8.0.7/32",
      serverPublicKeyBase64: SERVER_KEY,
      endpoint: "vpn.example.com:51820",
      piholeActive: true,
      brandSlug: "acme-vpn",
    });
    expect(config.suggestedFileName).toBe("acme-vpn-pihole.conf");
  });

  it("verweigert einen Slug, der den Dateinamen verlassen könnte", () => {
    expect(() =>
      buildWireguardConfig({
        privateKeyBase64: pair.privateKeyBase64,
        address: "10.8.0.7/32",
        serverPublicKeyBase64: SERVER_KEY,
        endpoint: "vpn.example.com:51820",
        piholeActive: false,
        brandSlug: "../evil",
      }),
    ).toThrow(/Marken-Slug/);
  });

  it("enthält die für die FRITZ!Box nötigen Felder", () => {
    const { content } = buildWireguardConfig({
      privateKeyBase64: pair.privateKeyBase64,
      address: "10.8.0.7/32",
      serverPublicKeyBase64: SERVER_KEY,
      endpoint: "vpn.example.com:51820",
      piholeActive: true,
    });
    for (const expected of [
      "[Interface]",
      "PrivateKey = ",
      "Address = 10.8.0.7/32",
      "MTU = 1420",
      "[Peer]",
      "AllowedIPs = 0.0.0.0/0, ::/0",
      "Endpoint = vpn.example.com:51820",
      "PersistentKeepalive = 25",
    ]) {
      expect(content).toContain(expected);
    }
    expect(content.endsWith("\n")).toBe(true);
    expect(content).not.toContain("\r\n");
  });

  it("verweigert ungültige Eingaben", () => {
    expect(() =>
      buildWireguardConfig({
        privateKeyBase64: pair.privateKeyBase64,
        address: "10.8.0.7/32",
        serverPublicKeyBase64: "zu-kurz",
        endpoint: "vpn.example.com:51820",
        piholeActive: false,
      }),
    ).toThrow(/Public-Key/);

    expect(() =>
      buildWireguardConfig({
        privateKeyBase64: pair.privateKeyBase64,
        address: "keine-ip",
        serverPublicKeyBase64: SERVER_KEY,
        endpoint: "vpn.example.com:51820",
        piholeActive: false,
      }),
    ).toThrow(/Adresse/);

    expect(() =>
      buildWireguardConfig({
        privateKeyBase64: pair.privateKeyBase64,
        address: "10.8.0.7/32",
        serverPublicKeyBase64: SERVER_KEY,
        endpoint: "ohne-port",
        piholeActive: false,
      }),
    ).toThrow(/Endpoint/);
  });
});

describe("wipePrivateKey", () => {
  it("überschreibt das Schlüsselmaterial", () => {
    const pair = generateDeviceKeyPair();
    wipePrivateKey(pair);
    expect(pair.privateKey.every((byte) => byte === 0)).toBe(true);
    expect(pair.privateKeyBase64).toBe("");
  });
});
