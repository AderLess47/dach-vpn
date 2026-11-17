import { describe, expect, it } from "vitest";
import {
  HANDLED_STRIPE_EVENTS,
  isHandledStripeEvent,
  mapSubscriptionStatus,
} from "./stripe";

describe("mapSubscriptionStatus", () => {
  it("bildet aktive und testende Abos auf active ab", () => {
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("trialing")).toBe("active");
  });

  it("behandelt Zahlungsverzug als past_due", () => {
    expect(mapSubscriptionStatus("past_due")).toBe("past_due");
    expect(mapSubscriptionStatus("unpaid")).toBe("past_due");
  });

  it("behandelt beendete Abos als canceled", () => {
    expect(mapSubscriptionStatus("canceled")).toBe("canceled");
    expect(mapSubscriptionStatus("incomplete_expired")).toBe("canceled");
  });

  it("behält incomplete bei", () => {
    expect(mapSubscriptionStatus("incomplete")).toBe("incomplete");
  });

  it("liefert null für unbekannte oder fehlende Werte", () => {
    expect(mapSubscriptionStatus(null)).toBeNull();
    expect(mapSubscriptionStatus(undefined)).toBeNull();
    expect(mapSubscriptionStatus("paused")).toBeNull();
    expect(mapSubscriptionStatus("")).toBeNull();
  });
});

describe("isHandledStripeEvent", () => {
  it("verarbeitet genau die dokumentierten Events", () => {
    for (const type of HANDLED_STRIPE_EVENTS) {
      expect(isHandledStripeEvent(type)).toBe(true);
    }
    expect(HANDLED_STRIPE_EVENTS).toHaveLength(5);
  });

  it("ignoriert alles andere", () => {
    expect(isHandledStripeEvent("customer.created")).toBe(false);
    expect(isHandledStripeEvent("")).toBe(false);
  });
});
