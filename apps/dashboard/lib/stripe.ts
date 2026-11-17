import Stripe from "stripe";

let client: Stripe | null = null;

/** Stripe-Client oder null im Trockenlauf (keine Keys gesetzt). */
export function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!client) client = new Stripe(key);
  return client;
}

export function stripePrices() {
  return {
    base: process.env.STRIPE_PRICE_ID_BASE ?? null,
    pihole: process.env.STRIPE_PRICE_ID_PIHOLE ?? null,
  };
}

/** Basis-URL für Checkout-Rücksprünge; bewusst nicht aus dem Host abgeleitet. */
export function appUrl(request: Request): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
}
