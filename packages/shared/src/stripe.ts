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
