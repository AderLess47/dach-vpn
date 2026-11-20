/**
 * Gerätelimit aus der Umgebung lesen — an einer Stelle.
 *
 * Route und Edge Function haben das Limit vorher getrennt behandelt: die Route
 * las `MAX_DEVICES_PER_USER`, die Edge Function hatte eine feste `5`. Solche
 * Abweichungen fallen erst auf, wenn ein Konto mit erhöhtem Limit über den
 * anderen Pfad registriert und plötzlich abgewiesen wird.
 *
 * Die Funktion ist rein (kein `process.env`, kein `Deno.env`) — die Aufrufer
 * lesen ihre Umgebung selbst und übergeben den String. Damit bleibt sie in
 * Tests und in beiden Laufzeiten gleich.
 */

export const DEFAULT_MAX_DEVICES = 5;

/**
 * Nimmt ausschließlich positive Ganzzahlen an. Alles andere — leer, `"abc"`,
 * `"0"`, `"-3"`, `"12.5"`, unsichere Größen — fällt auf den Default zurück,
 * statt ein Gerätelimit von 0 oder NaN an die RPC zu geben.
 */
export function parseMaxDevices(raw?: string | null): number {
  if (raw === undefined || raw === null) return DEFAULT_MAX_DEVICES;

  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return DEFAULT_MAX_DEVICES;

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_MAX_DEVICES;

  return parsed;
}
