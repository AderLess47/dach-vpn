import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_DEVICES, parseMaxDevices } from "./device-limit.js";

describe("parseMaxDevices", () => {
  it("nutzt ohne Konfiguration den Default", () => {
    expect(parseMaxDevices(undefined)).toBe(DEFAULT_MAX_DEVICES);
    expect(parseMaxDevices(null)).toBe(DEFAULT_MAX_DEVICES);
    expect(parseMaxDevices("")).toBe(DEFAULT_MAX_DEVICES);
    expect(parseMaxDevices("   ")).toBe(DEFAULT_MAX_DEVICES);
  });

  it("übernimmt eine positive Ganzzahl, auch mit Leerzeichen", () => {
    expect(parseMaxDevices("10")).toBe(10);
    expect(parseMaxDevices(" 7 ")).toBe(7);
    expect(parseMaxDevices("1")).toBe(1);
  });

  it("weist ungültige Werte ab, statt sie halb zu übernehmen", () => {
    for (const raw of ["abc", "0", "-3", "12.5", "5x", "1e3", "+4"]) {
      expect(parseMaxDevices(raw)).toBe(DEFAULT_MAX_DEVICES);
    }
  });

  it("weist Zahlen außerhalb des sicheren Bereichs ab", () => {
    expect(parseMaxDevices("99999999999999999999")).toBe(DEFAULT_MAX_DEVICES);
  });
});
