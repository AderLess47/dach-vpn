import { describe, expect, it } from "vitest";
import { parseBearerToken } from "./index.js";

const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig_nature-123";

describe("parseBearerToken", () => {
  it("liest einen gültigen Bearer-Token", () => {
    expect(parseBearerToken(`Bearer ${JWT}`)).toBe(JWT);
  });

  it("akzeptiert Groß-/Kleinschreibung und umgebende Leerzeichen", () => {
    expect(parseBearerToken(`  bearer ${JWT}  `)).toBe(JWT);
  });

  it("lehnt fehlende oder fremde Schemata ab", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken("Basic abc")).toBeNull();
    expect(parseBearerToken(JWT)).toBeNull();
  });

  it("lehnt leere oder mehrere Tokens ab", () => {
    expect(parseBearerToken("Bearer ")).toBeNull();
    expect(parseBearerToken("Bearer   ")).toBeNull();
    expect(parseBearerToken(`Bearer ${JWT} ${JWT}`)).toBeNull();
  });

  it("lehnt Zeichen außerhalb des JWT-Zeichensatzes ab", () => {
    expect(parseBearerToken("Bearer abc;drop")).toBeNull();
    expect(parseBearerToken("Bearer abc/def")).toBeNull();
  });
});
