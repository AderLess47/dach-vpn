import { describe, expect, it } from "vitest";
import {
  brandOverridesFromRow,
  brandSlug,
  BRAND_NAME_MAX_LENGTH,
  BRAND_SLUG_MAX_LENGTH,
  DEFAULT_BRAND,
  normalizeHost,
  resolveBrand,
  resolveBrandForTenant,
} from "./brand.js";

describe("brandSlug", () => {
  it("macht aus einem Namen einen Dateinamen-Slug", () => {
    expect(brandSlug("Acme VPN")).toBe("acme-vpn");
  });

  it("transliteriert deutsche Umlaute und ß", () => {
    expect(brandSlug("Müller & Söhne")).toBe("mueller-soehne");
    expect(brandSlug("Weiß")).toBe("weiss");
  });

  it("entfernt Pfadanteile, damit kein Verzeichnis im Dateinamen landet", () => {
    expect(brandSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(brandSlug("a/b\\c")).toBe("a-b-c");
  });

  it("kürzt auf die maximale Länge und endet nicht mit einem Bindestrich", () => {
    const cutOnDash = brandSlug("a".repeat(BRAND_SLUG_MAX_LENGTH - 1) + " b");
    expect(cutOnDash.length).toBeLessThanOrEqual(BRAND_SLUG_MAX_LENGTH);
    expect(cutOnDash.endsWith("-")).toBe(false);
  });

  it("liefert für leere Eingaben einen leeren Slug", () => {
    expect(brandSlug("")).toBe("");
    expect(brandSlug("   ")).toBe("");
    expect(brandSlug("---")).toBe("");
  });
});

describe("resolveBrand", () => {
  it("nutzt HubGuard als Default", () => {
    expect(resolveBrand()).toEqual({
      name: "HubGuard",
      slug: "hubguard",
      tagline: DEFAULT_BRAND.tagline,
    });
  });

  it("übernimmt einen Mandantennamen und leitet den Slug ab", () => {
    expect(resolveBrand({ name: "Acme VPN" })).toEqual({
      name: "Acme VPN",
      slug: "acme-vpn",
      tagline: DEFAULT_BRAND.tagline,
    });
  });

  it("bevorzugt einen expliziten Slug vor dem Namen", () => {
    expect(resolveBrand({ name: "Acme VPN", slug: "tv-guard" }).slug).toBe("tv-guard");
  });

  it("fällt bei leerem explizitem Slug auf den Namen zurück", () => {
    expect(resolveBrand({ name: "Acme VPN", slug: "  " }).slug).toBe("acme-vpn");
  });

  it("normalisiert Leerraum im Namen", () => {
    expect(resolveBrand({ name: "  Acme   VPN  " }).name).toBe("Acme VPN");
  });

  it("fällt bei leerem, nicht-zeichenkettigem oder überlangem Namen auf den Default zurück", () => {
    expect(resolveBrand({ name: "   " }).name).toBe("HubGuard");
    expect(resolveBrand({ name: null }).name).toBe("HubGuard");
    expect(resolveBrand({ name: "x".repeat(BRAND_NAME_MAX_LENGTH + 1) }).name).toBe("HubGuard");
  });

  it("übernimmt eine eigene Tagline, fällt sonst auf den Default zurück", () => {
    expect(resolveBrand({ tagline: "TV & Streaming" }).tagline).toBe("TV & Streaming");
    expect(resolveBrand({ tagline: "" }).tagline).toBe(DEFAULT_BRAND.tagline);
    expect(resolveBrand({ tagline: "x".repeat(121) }).tagline).toBe(DEFAULT_BRAND.tagline);
  });

  it("verändert den Default nicht", () => {
    resolveBrand({ name: "Acme", slug: "acme", tagline: "anders" });
    expect(DEFAULT_BRAND).toEqual({
      name: "HubGuard",
      slug: "hubguard",
      tagline: "No-Log-VPN mit Pi-hole-Add-on",
    });
  });
});

describe("normalizeHost", () => {
  it("entfernt Port, Leerraum und Großschreibung", () => {
    expect(normalizeHost("TV.Example.NET:3000")).toBe("tv.example.net");
    expect(normalizeHost("  tv.example.net  ")).toBe("tv.example.net");
  });

  it("nimmt aus einer x-forwarded-host-Liste den ersten Eintrag", () => {
    expect(normalizeHost("tv.example.net, proxy.internal")).toBe("tv.example.net");
  });

  it("entfernt den abschließenden FQDN-Punkt", () => {
    expect(normalizeHost("tv.example.net.")).toBe("tv.example.net");
  });

  it("akzeptiert IPv4 und einzelne Labels (lokale Entwicklung)", () => {
    expect(normalizeHost("127.0.0.1:3001")).toBe("127.0.0.1");
    expect(normalizeHost("localhost")).toBe("localhost");
  });

  it("weist IPv6-Literale, Pfade und Benutzeranteile ab", () => {
    expect(normalizeHost("[::1]:3000")).toBeNull();
    expect(normalizeHost("example.net/pfad")).toBeNull();
    expect(normalizeHost("user@example.net")).toBeNull();
  });

  it("weist Header-Injection und ungültige Zeichen ab", () => {
    expect(normalizeHost("evil.example\r\nHost: intern")).toBeNull();
    expect(normalizeHost("ev il.example")).toBeNull();
    expect(normalizeHost("bad_domain.example")).toBeNull();
    expect(normalizeHost("-bad.example")).toBeNull();
  });

  it("weist leere und überlange Werte ab", () => {
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost(undefined)).toBeNull();
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("   ")).toBeNull();
    expect(normalizeHost(`${"a".repeat(250)}.example`)).toBeNull();
  });
});

describe("brandOverridesFromRow", () => {
  it("übernimmt ausschließlich Zeichenketten", () => {
    expect(
      brandOverridesFromRow({ name: "Acme", slug: "acme", tagline: "TV" }),
    ).toEqual({ name: "Acme", slug: "acme", tagline: "TV" });

    expect(brandOverridesFromRow({ name: 42, slug: {}, tagline: null })).toEqual({});
  });

  it("ignoriert fremde Felder und Nicht-Objekte", () => {
    const overrides = brandOverridesFromRow({ name: "Acme", role: "admin" });
    expect(Object.keys(overrides)).toEqual(["name"]);

    for (const value of [null, undefined, "Acme", 7, ["Acme"]]) {
      expect(brandOverridesFromRow(value)).toEqual({});
    }
  });
});

describe("resolveBrandForTenant", () => {
  it("gibt dem Mandanten Vorrang vor der Env-Variable", () => {
    expect(
      resolveBrandForTenant(
        { name: "Acme VPN", slug: "acme-vpn", tagline: "Streaming ohne Umwege" },
        "Fallback",
      ),
    ).toEqual({
      name: "Acme VPN",
      slug: "acme-vpn",
      tagline: "Streaming ohne Umwege",
    });
  });

  it("nutzt die Env-Variable, wenn kein Mandant gefunden wurde", () => {
    expect(resolveBrandForTenant(null, "Fallback VPN").name).toBe("Fallback VPN");
  });

  it("fällt ohne Mandant und ohne Env auf den Default zurück", () => {
    expect(resolveBrandForTenant(null, null).name).toBe("HubGuard");
    expect(resolveBrandForTenant(undefined, undefined).name).toBe("HubGuard");
  });

  it("behandelt einen Mandanten mit leeren Feldern wie keinen Mandanten", () => {
    expect(resolveBrandForTenant({ name: "", slug: "", tagline: "" }, "Fallback").name).toBe(
      "Fallback",
    );
  });
});
