import { describe, expect, it } from "vitest";
import { ENTITLED_SUBSCRIPTION_STATUSES, hasVpnEntitlement } from "./entitlement.js";

describe("hasVpnEntitlement", () => {
  it("erlaubt aktive Abos", () => {
    expect(hasVpnEntitlement("active")).toBe(true);
  });

  it("erlaubt die Kulanzphase past_due", () => {
    expect(hasVpnEntitlement("past_due")).toBe(true);
  });

  it("sperrt unbezahlte und beendete Abos", () => {
    for (const status of ["incomplete", "canceled"]) {
      expect(hasVpnEntitlement(status)).toBe(false);
    }
  });

  it("sperrt fehlende und unbekannte Werte", () => {
    for (const status of [null, undefined, "", "trialing", "ACTIVE", " active"]) {
      expect(hasVpnEntitlement(status)).toBe(false);
    }
  });

  it("hält den Statuskatalog stabil", () => {
    expect([...ENTITLED_SUBSCRIPTION_STATUSES]).toEqual(["active", "past_due"]);
  });
});
