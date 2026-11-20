import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { isCancelAtPeriodEnd, isHandledStripeEvent, mapSubscriptionStatus } from "@dachvpn/shared";
import { serviceClient } from "../../../../lib/api-auth";
import { stripeClient, stripePrices } from "../../../../lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe-Webhook.
 *
 * - Signatur wird über den **Rohbody** geprüft; ohne gültige Signatur kein Effekt.
 * - `stripe_events` ist die Idempotenzsperre: jede Event-ID wird genau einmal
 *   verarbeitet, ein Retry von Stripe ändert nichts.
 * - Es werden keine Nutzdaten gespeichert, nur Event-ID, Typ und Zeitstempel.
 */
export async function POST(request: Request) {
  const stripe = stripeClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const admin = serviceClient();

  if (!stripe || !secret || !admin) {
    return NextResponse.json(
      { received: false, reason: "STRIPE_NOT_CONFIGURED" },
      { status: 202 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ code: "MISSING_SIGNATURE" }, { status: 400 });
  }

  const payload = await request.text();
  let event: Stripe.Event;
  try {
    // Async, weil Bun/das Worker-Build des SDK keinen synchronen HMAC anbietet
    // (`constructEvent` wirft dort CryptoProviderOnlySupportsAsyncError). Die
    // Prüfung ist dieselbe: Signatur über den Rohbody, Toleranz 300 s.
    event = await stripe.webhooks.constructEventAsync(payload, signature, secret);
  } catch {
    return NextResponse.json({ code: "INVALID_SIGNATURE" }, { status: 400 });
  }

  const { error: insertError } = await admin
    .from("stripe_events")
    .insert({ event_id: event.id, type: event.type });

  if (insertError) {
    if (insertError.code === "23505") {
      // Bekannte Event-ID: endgültig Duplikat ist sie nur, wenn der erste
      // Versuch durchgelaufen ist. Ein gescheiterter Versuch hinterlässt eine
      // Zeile ohne `processed_at` — die darf erneut verarbeitet werden.
      const { data: existing, error: lookupError } = await admin
        .from("stripe_events")
        .select("processed_at")
        .eq("event_id", event.id)
        .maybeSingle();

      if (lookupError) {
        return NextResponse.json({ code: "EVENT_LOG_FAILED" }, { status: 502 });
      }
      if (existing?.processed_at) {
        return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
      }
    } else {
      return NextResponse.json({ code: "EVENT_LOG_FAILED" }, { status: 502 });
    }
  }

  try {
    const prices = stripePrices();

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : (session.subscription?.id ?? null);
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          await applySubscription(subscription, prices.pihole);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await applySubscription(event.data.object as Stripe.Subscription, prices.pihole);
        break;
      }
      case "invoice.payment_failed": {
        await markPastDue(event.data.object as Stripe.Invoice, prices.pihole);
        break;
      }
      default:
        // Nicht behandelte Events bleiben im Log, ändern aber nichts.
        break;
    }

    await admin
      .from("stripe_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("event_id", event.id);

    return NextResponse.json({ received: true, handled: isHandledStripeEvent(event.type) });
  } catch (error) {
    await admin
      .from("stripe_events")
      .update({ error: error instanceof Error ? error.message.slice(0, 200) : "unbekannt" })
      .eq("event_id", event.id);
    // 500, damit Stripe erneut zustellt. Die Sperrzeile bleibt ohne
    // `processed_at`, der nächste Versuch verarbeitet das Event erneut.
    return NextResponse.json({ code: "PROCESSING_FAILED" }, { status: 500 });
  }

  async function applySubscription(
    subscription: Stripe.Subscription,
    piholePrice: string | null,
    options: { status?: ReturnType<typeof mapSubscriptionStatus>; requireUser?: boolean } = {},
  ) {
    const userId = subscription.metadata?.user_id ?? null;
    const status = options.status ?? mapSubscriptionStatus(subscription.status);
    if (!userId || !status) {
      // Beim Nachziehen aus Stripe ist ein fehlendes `user_id` ein echter
      // Fehler: lieber 500 und ein späterer Zustellversuch als ein stiller
      // Verlust des Verzugs.
      if (options.requireUser) {
        throw new Error(!userId ? "SUBSCRIPTION_WITHOUT_USER_ID" : "SUBSCRIPTION_STATUS_UNKNOWN");
      }
      return;
    }

    const piholeActive = piholePrice
      ? subscription.items.data.some((item) => item.price?.id === piholePrice)
      : false;

    const periodEndSeconds = subscriptionPeriodEndSeconds(subscription);

    const { error } = await admin!.rpc("apply_subscription_state", {
      p_user_id: userId,
      p_customer_id:
        typeof subscription.customer === "string"
          ? subscription.customer
          : (subscription.customer?.id ?? null),
      p_subscription_id: subscription.id,
      p_status: status,
      p_pihole: piholeActive,
      p_period_end: periodEndSeconds === null ? null : new Date(periodEndSeconds * 1000).toISOString(),
      // Flexible Abos setzen beim Kündigen nur `cancel_at`, nicht das Flag.
      p_cancel_at_period_end: isCancelAtPeriodEnd({
        cancel_at_period_end: subscription.cancel_at_period_end,
        cancel_at: subscription.cancel_at,
        period_end: periodEndSeconds,
      }),
    });

    if (error) throw new Error(error.message);
  }

  async function markPastDue(invoice: Stripe.Invoice, piholePrice: string | null) {
    const subscriptionId = subscriptionIdFromInvoice(invoice);
    if (!subscriptionId) return;

    const { data } = await admin!
      .from("subscriptions")
      .select("user_id, stripe_customer_id, pihole_addon_active, current_period_end, cancel_at_period_end")
      .eq("stripe_subscription_id", subscriptionId)
      .maybeSingle();

    if (data) {
      const { error } = await admin!.rpc("apply_subscription_state", {
        p_user_id: data.user_id,
        p_customer_id: data.stripe_customer_id,
        p_subscription_id: subscriptionId,
        p_status: "past_due",
        p_pihole: data.pihole_addon_active,
        p_period_end: data.current_period_end,
        p_cancel_at_period_end: data.cancel_at_period_end,
      });

      if (error) throw new Error(error.message);
      return;
    }

    // Noch keine Zeile: Das Event kann vor `customer.subscription.created`
    // eintreffen. Den Zustand deshalb aus Stripe nachziehen, statt den Verzug
    // wirkungslos zu quittieren. Den Status setzt das fehlgeschlagene
    // Inkasso; ein späteres `customer.subscription.*` korrigiert ihn wieder.
    const subscription = await stripe!.subscriptions.retrieve(subscriptionId);
    await applySubscription(subscription, piholePrice, {
      status: "past_due",
      requireUser: true,
    });
  }
}

/** Periodenende liegt pro Item; maßgeblich ist das späteste Datum (Unix-Sekunden). */
function subscriptionPeriodEndSeconds(subscription: Stripe.Subscription): number | null {
  const stamps = subscription.items.data
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === "number");

  if (stamps.length === 0) return null;
  return Math.max(...stamps);
}

/** Die Subscription-ID am Invoice hat in neueren API-Versionen zwei Orte. */
function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const raw = invoice as unknown as {
    subscription?: string | { id?: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id?: string } | null } | null } | null;
  };

  const reference = raw.subscription ?? raw.parent?.subscription_details?.subscription ?? null;
  if (!reference) return null;
  return typeof reference === "string" ? reference : (reference.id ?? null);
}
