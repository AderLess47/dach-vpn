import { NextResponse } from "next/server";
import { authenticate, authUnavailableResponse, serviceClient } from "../../../../lib/api-auth";
import { appUrl, stripeClient } from "../../../../lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Öffnet das Customer-Portal; Kündigung wirkt dort zum Periodenende. */
export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (auth.kind === "unconfigured") {
    return NextResponse.json(
      { persisted: false, reason: "SUPABASE_NOT_CONFIGURED" },
      { status: 202 },
    );
  }
  if (auth.kind === "unavailable") return authUnavailableResponse();
  if (auth.kind === "unauthenticated") {
    return NextResponse.json(
      { code: auth.code, message: "Für das Abo-Portal ist eine Anmeldung erforderlich." },
      { status: 401 },
    );
  }

  const stripe = stripeClient();
  const admin = serviceClient();
  if (!stripe || !admin) {
    return NextResponse.json(
      { persisted: false, reason: "STRIPE_NOT_CONFIGURED" },
      { status: 202 },
    );
  }

  try {
    const { data } = await admin
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (!data?.stripe_customer_id) {
      return NextResponse.json(
        {
          code: "NO_CUSTOMER",
          message: "Für dieses Konto existiert noch kein Stripe-Kunde. Bitte zuerst ein Abo starten.",
        },
        { status: 409 },
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: `${appUrl(request)}/`,
    });

    return NextResponse.json({ url: session.url }, { status: 200 });
  } catch {
    return NextResponse.json(
      { code: "PORTAL_FAILED", message: "Abo-Portal konnte nicht geöffnet werden." },
      { status: 502 },
    );
  }
}
