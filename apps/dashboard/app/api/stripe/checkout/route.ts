import { NextResponse } from "next/server";
import { authenticate, serviceClient } from "../../../../lib/api-auth";
import { appUrl, stripeClient, stripePrices } from "../../../../lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Startet den Abo-Checkout.
 *
 * Die Nutzer-ID kommt aus dem verifizierten Token, nicht aus dem Body. Der
 * Stripe-Customer wird idempotent an das Konto gebunden; die Zuordnung
 * `user_id` steht zusätzlich in den Subscription-Metadaten, damit der Webhook
 * ohne Datenbank-Lookup zuordnen kann.
 */
export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (auth.kind === "unconfigured") {
    return NextResponse.json(
      { persisted: false, reason: "SUPABASE_NOT_CONFIGURED" },
      { status: 202 },
    );
  }
  if (auth.kind === "unauthenticated") {
    return NextResponse.json(
      { code: auth.code, message: "Für den Checkout ist eine Anmeldung erforderlich." },
      { status: 401 },
    );
  }

  const stripe = stripeClient();
  const prices = stripePrices();
  const admin = serviceClient();
  const missing = [
    !stripe ? "STRIPE_SECRET_KEY" : null,
    !prices.base ? "STRIPE_PRICE_ID_BASE" : null,
    !admin ? "SUPABASE_SERVICE_ROLE_KEY" : null,
  ].filter(Boolean);

  if (!stripe || !prices.base || !admin) {
    return NextResponse.json(
      {
        persisted: false,
        reason: "STRIPE_NOT_CONFIGURED",
        message: "Stripe ist nicht konfiguriert; der Checkout läuft im Trockenlauf.",
        missing,
      },
      { status: 202 },
    );
  }

  let addon = false;
  try {
    const body = (await request.json()) as { addon?: unknown };
    addon = body?.addon === true;
  } catch {
    addon = false;
  }

  try {
    const { data: existing, error: readError } = await admin
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (readError) throw new Error(readError.message);

    let customerId: string | null = existing?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: auth.email ?? undefined,
        metadata: { user_id: auth.userId },
      });
      customerId = customer.id;
      const { error: writeError } = await admin
        .from("subscriptions")
        .upsert({ user_id: auth.userId, stripe_customer_id: customerId }, { onConflict: "user_id" });
      if (writeError) throw new Error(writeError.message);
    }

    const lineItems = [{ price: prices.base, quantity: 1 }];
    if (addon && prices.pihole) lineItems.push({ price: prices.pihole, quantity: 1 });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: lineItems,
      client_reference_id: auth.userId,
      subscription_data: { metadata: { user_id: auth.userId } },
      success_url: `${appUrl(request)}/?checkout=success`,
      cancel_url: `${appUrl(request)}/?checkout=cancel`,
    });

    return NextResponse.json({ url: session.url }, { status: 200 });
  } catch {
    return NextResponse.json(
      { code: "CHECKOUT_FAILED", message: "Checkout konnte nicht erstellt werden." },
      { status: 502 },
    );
  }
}
