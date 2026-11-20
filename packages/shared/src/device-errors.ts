/**
 * Abbildung von Datenbankfehlern der Geräte-RPCs auf HTTP-Antworten.
 *
 * Vorher lag dieselbe Logik dreimal vor: Register-Route, Rebind-Route und Edge
 * Function. Sie lief bereits auseinander — die Edge Function fasste
 * `DEVICE_REVOKED` und `DEVICE_KEY_CONFLICT` zu einem Code zusammen, die Route
 * unterschied sie. Solche Unterschiede sind genau das, was Clients falsch
 * behandeln lässt. Deshalb gibt es jetzt eine Quelle; die drei Aufrufer
 * entscheiden nur noch über die Operation.
 *
 * Grundsätze:
 * - Erkannt wird an den Markern aus den `raise exception`-Aufrufen der
 *   Migrationen (P0001–P0007) und an Postgres-Fehlercodes (23503, 23505).
 * - Nach außen gehen feste, handlungsorientierte Texte — niemals DB-Fehlertexte,
 *   die Constraints verraten könnten.
 * - Unbekanntes endet als 502: lieber ein ehrlicher Serverfehler als eine
 *   erfundene Ursache.
 */

export type DeviceErrorCode =
  | "POOL_EXHAUSTED"
  | "DEVICE_LIMIT_REACHED"
  | "SUBSCRIPTION_REQUIRED"
  | "ADDON_NOT_BOOKED"
  | "DEVICE_REVOKED"
  | "DEVICE_EXISTS"
  | "PROFILE_MISSING"
  | "DEVICE_NOT_FOUND"
  | "PERSIST_FAILED";

export type DeviceErrorStatus = 403 | 404 | 409 | 502 | 503;

/** Welche Operation lief? Sie entscheidet nur über den Text. */
export type DeviceOperation = "register" | "rebind";

export interface DeviceFailure {
  /** `error.message` — enthält bei den RPCs den Marker (z. B. `DEVICE_REVOKED`). */
  message?: string | null;
  /** `error.code` — Postgres-Code, z. B. `23505` bei Unique-Verletzung. */
  code?: string | null;
}

export interface DeviceErrorResponse {
  status: DeviceErrorStatus;
  code: DeviceErrorCode;
  message: string;
}

const FAILED_MESSAGE: Record<DeviceOperation, string> = {
  register: "Gerät konnte nicht gespeichert werden.",
  rebind: "Der Schlüssel konnte nicht gebunden werden.",
};

const SUBSCRIPTION_MESSAGE: Record<DeviceOperation, string> = {
  register: "Für die Geräteregistrierung ist ein aktives Abo erforderlich.",
  rebind: "Für den Schlüsselwechsel ist ein aktives Abo erforderlich.",
};

const REVOKED_MESSAGE: Record<DeviceOperation, string> = {
  register: "Dieses Gerät wurde widerrufen. Bitte ein neues Schlüsselpaar erzeugen.",
  rebind: "Dieses Gerät wurde widerrufen. Bitte ein neues Gerät registrieren.",
};

function has(message: string, marker: string): boolean {
  return message.includes(marker);
}

/**
 * Übersetzt einen DB-Fehler in Status, Code und Text.
 * Die Reihenfolge ist stabil: erst die spezifischen RPC-Marker, dann
 * Constraint-Codes, zuletzt der generische Fall.
 */
export function describeDeviceFailure(
  failure: DeviceFailure | null | undefined,
  operation: DeviceOperation,
): DeviceErrorResponse {
  const message = failure?.message ?? "";
  const code = failure?.code ?? "";

  if (has(message, "IP_POOL_EXHAUSTED")) {
    return {
      status: 503,
      code: "POOL_EXHAUSTED",
      message:
        "Für diesen Knoten ist aktuell keine freie Adresse verfügbar. Bitte später erneut versuchen.",
    };
  }

  if (has(message, "SUBSCRIPTION_REQUIRED")) {
    return {
      status: 403,
      code: "SUBSCRIPTION_REQUIRED",
      message: SUBSCRIPTION_MESSAGE[operation],
    };
  }

  if (has(message, "ADDON_NOT_BOOKED")) {
    return {
      status: 403,
      code: "ADDON_NOT_BOOKED",
      message: "Das Pi-hole-Add-on ist für dieses Konto nicht gebucht.",
    };
  }

  if (has(message, "DEVICE_LIMIT_REACHED")) {
    return {
      status: 409,
      code: "DEVICE_LIMIT_REACHED",
      message: "Die maximale Geräteanzahl dieses Kontos ist erreicht.",
    };
  }

  if (has(message, "DEVICE_REVOKED")) {
    return {
      status: 409,
      code: "DEVICE_REVOKED",
      message: REVOKED_MESSAGE[operation],
    };
  }

  if (has(message, "DEVICE_NOT_FOUND")) {
    return {
      status: 404,
      code: "DEVICE_NOT_FOUND",
      message: "Dieses Gerät gehört nicht zu deinem Konto.",
    };
  }

  // Unique-Index auf devices.public_key — der Schlüssel hängt an einem Gerät.
  if (code === "23505" || has(message, "DEVICE_KEY_CONFLICT")) {
    return {
      status: 409,
      code: "DEVICE_EXISTS",
      message: "Dieser Schlüssel ist bereits registriert.",
    };
  }

  // Fremdschlüssel auf profiles: das Konto hat noch kein Profil.
  if (code === "23503") {
    return {
      status: 409,
      code: "PROFILE_MISSING",
      message: "Für dieses Konto existiert noch kein Profil.",
    };
  }

  return { status: 502, code: "PERSIST_FAILED", message: FAILED_MESSAGE[operation] };
}
