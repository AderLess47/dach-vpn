import { describe, expect, it } from "vitest";
import { findPrivateKeyMaterial, guardRegisterDevice } from "./index.js";

const PUBLIC_KEY = "Yk3z9pQ1sV7mR2tL8xN4wJ6hD0fG5cB1aZ9uK3eP7oM=";

describe("guardRegisterDevice", () => {
  it("akzeptiert einen minimalen, gültigen Payload", () => {
    const result = guardRegisterDevice({
      name: "Wohnzimmer-TV",
      platform: "firetv",
      publicKey: PUBLIC_KEY,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("Wohnzimmer-TV");
      expect(result.data.platform).toBe("firetv");
      expect(result.data.publicKey).toBe(PUBLIC_KEY);
    }
  });

  it("lehnt einen Payload mit privateKey-Feld mit 422 ab", () => {
    const result = guardRegisterDevice({
      name: "TV",
      platform: "web",
      publicKey: PUBLIC_KEY,
      privateKey: "geheim",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("PRIVATE_KEY_MATERIAL");
      expect(result.fields).toContain("$.privateKey");
    }
  });

  it("findet privates Material auch verschachtelt", () => {
    const hits = findPrivateKeyMaterial({
      name: "TV",
      meta: { nested: [{ secret: "x" }] },
    });
    expect(hits).toEqual(["$.meta.nested[0].secret"]);
  });

  it("erkennt PEM-Private-Key-Blöcke in Werten", () => {
    const result = guardRegisterDevice({
      name: "-----BEGIN PRIVATE KEY-----",
      platform: "web",
      publicKey: PUBLIC_KEY,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("PRIVATE_KEY_MATERIAL");
    }
  });

  it("lehnt unbekannte Felder ab, statt sie zu ignorieren", () => {
    const result = guardRegisterDevice({
      name: "TV",
      platform: "web",
      publicKey: PUBLIC_KEY,
      dnsServer: "8.8.8.8",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_FIELD");
      expect(result.fields).toEqual(["dnsServer"]);
    }
  });

  it("lehnt zu kurze oder falsch kodierte Public Keys ab", () => {
    for (const publicKey of ["", "abc", PUBLIC_KEY.slice(0, 43)]) {
      const result = guardRegisterDevice({
        name: "TV",
        platform: "web",
        publicKey,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("lehnt unbekannte Plattformen ab", () => {
    const result = guardRegisterDevice({
      name: "TV",
      platform: "windows",
      publicKey: PUBLIC_KEY,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("platform");
  });

  it("lehnt Nicht-Objekte ab", () => {
    for (const payload of [null, [], "string", 42]) {
      expect(guardRegisterDevice(payload).ok).toBe(false);
    }
  });

  it("akzeptiert optionales piholeEnabled", () => {
    const result = guardRegisterDevice({
      name: "TV",
      platform: "android",
      publicKey: PUBLIC_KEY,
      piholeEnabled: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.piholeEnabled).toBe(true);
  });
});
