/**
 * Stripe-Abbildung ohne SDK-Abhängigkeit.
 *
 * Der Webhook bekommt die Rohdaten von Stripe; welche Statuswerte in unsere
 * `subscription_status`-Enum gehören, entscheidet ausschließlich diese Funktion.
 * Sie ist absichtlich frei von Seiteneffekten, damit sie testbar bleibt.
 */

export type DbSubscriptionStatus = "incomplete" | "active" | "past_due" | "canceled";

const STATUS_MAP: Record<string, DbSubscriptionStatus> = {
  active: "active",
  trialing: "active",
  past_due: "past_due",
  unpaid: "past_due",
  canceled: "canceled",
  incomplete_expired: "canceled",
  incomplete: "incomplete",
};

export function mapSubscriptionStatus(
  stripeStatus: string | null | undefined,
): DbSubscriptionStatus | null {
  if (!stripeStatus) return null;
  return STATUS_MAP[stripeStatus] ?? null;
}

export const HANDLED_STRIPE_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
] as const;

export function isHandledStripeEvent(type: string): boolean {
  return (HANDLED_STRIPE_EVENTS as readonly string[]).includes(type);
}

export interface CancelStateInput {
  cancel_at_period_end?: boolean | null;
  cancel_at?: number | null;
  /** Ende der laufenden Periode als Unix-Sekunden. */
  period_end?: number | null;
}

/**
 * Erkennt eine Kündigung zum Periodenende.
 *
 * Stripe schreibt das je nach Abrechnungsmodell unterschiedlich: klassische
 * Abos setzen `cancel_at_period_end`, Abos mit `billing_mode: "flexible"`
 * setzen beim Kündigen über das Customer-Portal nur `cancel_at` auf das
 * Periodenende — das Flag bleibt dort `false`. Es ist seit dem Changelog
 * 2025-05-28 als Parameter abgekündigt und laut Stripe mit den neuen
 * `cancel_at`-Helfern (`min_period_end`, `max_period_end`) nicht kompatibel.
 *
 * Deshalb zählt beides: gesetztes Flag oder ein `cancel_at`, das nicht nach dem
 * Periodenende liegt. Ist das Periodenende unbekannt, bleibt es beim Flag —
 * lieber keine Kündigung anzeigen als eine erfundene.
 */
export function isCancelAtPeriodEnd(input: CancelStateInput): boolean {
  if (input.cancel_at_period_end === true) return true;

  const cancelAt = input.cancel_at;
  const periodEnd = input.period_end;
  if (typeof cancelAt !== "number" || typeof periodEnd !== "number") {
    return false;
  }

  return cancelAt <= periodEnd;
}
