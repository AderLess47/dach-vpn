/**
 * Zugangsregel für das VPN — eine Definition für UI und Tests.
 *
 * Die Durchsetzung passiert in der Datenbank (`register_device`,
 * `rebind_device_key`, Migration 0009). Diese Datei bildet dieselbe Regel für
 * die Oberfläche ab, damit dort kein zweiter, abweichender Statuskatalog
 * entsteht. Ändert sich die Politik, muss sie an beiden Stellen geändert
 * werden — bewusst, weil nur die Datenbank sie erzwingen kann.
 */

/**
 * `active` ist der Normalfall, `past_due` ist Kulanz: Stripe mahnt nach einer
 * fehlgeschlagenen Zahlung weiter und kündigt erst danach. `incomplete`
 * (Checkout begonnen, nicht bezahlt) und `canceled` haben keinen Zugang.
 */
export const ENTITLED_SUBSCRIPTION_STATUSES = ["active", "past_due"] as const;

export type EntitledSubscriptionStatus =
  (typeof ENTITLED_SUBSCRIPTION_STATUSES)[number];

/** Darf dieses Konto Geräte registrieren bzw. Schlüssel wechseln? */
export function hasVpnEntitlement(status: string | null | undefined): boolean {
  if (typeof status !== "string") return false;
  return (ENTITLED_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}
