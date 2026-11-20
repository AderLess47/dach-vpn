import { describe, expect, it } from "vitest";
import { describeDeviceFailure } from "./device-errors.js";

describe("describeDeviceFailure", () => {
  it("meldet einen erschöpften Pool als 503", () => {
    const result = describeDeviceFailure({ message: "IP_POOL_EXHAUSTED" }, "register");
    expect(result).toMatchObject({ status: 503, code: "POOL_EXHAUSTED" });
  });

  it("verlangt für beide Operationen ein Abo, mit passendem Text", () => {
    const register = describeDeviceFailure({ message: "SUBSCRIPTION_REQUIRED" }, "register");
    const rebind = describeDeviceFailure({ message: "SUBSCRIPTION_REQUIRED" }, "rebind");

    expect(register.status).toBe(403);
    expect(register.code).toBe("SUBSCRIPTION_REQUIRED");
    expect(register.message).toContain("Geräteregistrierung");

    expect(rebind.status).toBe(403);
    expect(rebind.message).toContain("Schlüsselwechsel");
  });

  it("unterscheidet widerrufenes Gerät von fremdem Schlüssel", () => {
    expect(describeDeviceFailure({ message: "DEVICE_REVOKED" }, "register")).toMatchObject({
      status: 409,
      code: "DEVICE_REVOKED",
    });
    expect(describeDeviceFailure({ message: "DEVICE_KEY_CONFLICT" }, "register")).toMatchObject({
      status: 409,
      code: "DEVICE_EXISTS",
    });
  });

  it("behandelt eine Unique-Verletzung als bereits registrierten Schlüssel", () => {
    expect(describeDeviceFailure({ code: "23505" }, "rebind")).toMatchObject({
      status: 409,
      code: "DEVICE_EXISTS",
    });
  });

  it("erkennt das Gerätelimit und ein fehlendes Profil", () => {
    expect(describeDeviceFailure({ message: "DEVICE_LIMIT_REACHED" }, "register")).toMatchObject({
      status: 409,
      code: "DEVICE_LIMIT_REACHED",
    });
    expect(describeDeviceFailure({ code: "23503" }, "register")).toMatchObject({
      status: 409,
      code: "PROFILE_MISSING",
    });
  });

  it("beantwortet fremde Geräte mit 404", () => {
    expect(describeDeviceFailure({ message: "DEVICE_NOT_FOUND" }, "rebind")).toMatchObject({
      status: 404,
      code: "DEVICE_NOT_FOUND",
    });
  });

  it("erzwingt das Add-on nur, wenn die Datenbank es meldet", () => {
    expect(describeDeviceFailure({ message: "ADDON_NOT_BOOKED" }, "register")).toMatchObject({
      status: 403,
      code: "ADDON_NOT_BOOKED",
    });
  });

  it("fällt bei Unbekanntem auf 502 zurück, ohne DB-Text zu verraten", () => {
    for (const failure of [null, undefined, {}, { message: "duplicate key value violates" }]) {
      const result = describeDeviceFailure(failure, "register");
      expect(result).toMatchObject({ status: 502, code: "PERSIST_FAILED" });
      expect(result.message).toBe("Gerät konnte nicht gespeichert werden.");
    }

    expect(describeDeviceFailure({}, "rebind").message).toBe(
      "Der Schlüssel konnte nicht gebunden werden.",
    );
  });

  it("verwechselt Marker nicht mit Teilstrings anderer Fehler", () => {
    const result = describeDeviceFailure(
      { message: 'relation "devices" does not exist' },
      "register",
    );
    expect(result.code).toBe("PERSIST_FAILED");
  });
});
