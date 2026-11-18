import { describe, expect, it } from "vitest";
import {
  HANDLED_STRIPE_EVENTS,
  isCancelAtPeriodEnd,
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

describe("isCancelAtPeriodEnd", () => {
  // Werte aus einem echten Portal-Lauf (billing_mode: flexible): gekündigt am
  // 17.11.2026, Periodenende 17.12.2026.
  const periodEnd = 1797534826;

  it("erkennt das klassische Flag", () => {
    expect(
      isCancelAtPeriodEnd({ cancel_at_period_end: true, cancel_at: null, period_end: periodEnd }),
    ).toBe(true);
  });

  it("erkennt flexible Abos über cancel_at am Periodenende", () => {
    expect(
      isCancelAtPeriodEnd({
        cancel_at_period_end: false,
        cancel_at: periodEnd,
        period_end: periodEnd,
      }),
    ).toBe(true);
  });

  it("erkennt ein cancel_at vor dem Periodenende", () => {
    expect(
      isCancelAtPeriodEnd({
        cancel_at_period_end: false,
        cancel_at: periodEnd - 86_400,
        period_end: periodEnd,
      }),
    ).toBe(true);
  });

  it("wertet ein cancel_at nach dem Periodenende nicht als Kündigung zum Periodenende", () => {
    expect(
      isCancelAtPeriodEnd({
        cancel_at_period_end: false,
        cancel_at: periodEnd + 86_400,
        period_end: periodEnd,
      }),
    ).toBe(false);
  });

  it("meldet ohne Kündigung false", () => {
    expect(
      isCancelAtPeriodEnd({ cancel_at_period_end: false, cancel_at: null, period_end: periodEnd }),
    ).toBe(false);
    expect(isCancelAtPeriodEnd({})).toBe(false);
  });

  it("bleibt ohne Periodenende beim Flag", () => {
    expect(
      isCancelAtPeriodEnd({ cancel_at_period_end: false, cancel_at: periodEnd, period_end: null }),
    ).toBe(false);
    expect(
      isCancelAtPeriodEnd({ cancel_at_period_end: true, cancel_at: periodEnd, period_end: null }),
    ).toBe(true);
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
