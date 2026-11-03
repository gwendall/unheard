import { describe, expect, it } from "vitest";
import { isLang, negotiate } from "./lang";

describe("negotiate", () => {
  it("defaults to English with no header or no language of ours", () => {
    expect(negotiate(null)).toBe("en");
    expect(negotiate("")).toBe("en");
    expect(negotiate("de-DE,de;q=0.9,ja;q=0.5")).toBe("en");
  });
  it("takes the first of ours in the visitor's order", () => {
    expect(negotiate("fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7")).toBe("fr");
    expect(negotiate("en-GB,en;q=0.9,fr;q=0.8")).toBe("en");
    expect(negotiate("de-DE,fr;q=0.7,en;q=0.5")).toBe("fr");
  });
  it("follows the weights, not the order they are written in", () => {
    expect(negotiate("fr-CA;q=0.8, en;q=0.9")).toBe("en");
    expect(negotiate("en;q=0.1, fr")).toBe("fr");
  });
  it("ignores refused and malformed entries", () => {
    expect(negotiate("fr;q=0, en;q=0.5")).toBe("en");
    expect(negotiate("fr;q=abc, en;q=0.5")).toBe("en");
    expect(negotiate("*")).toBe("en");
  });
});

describe("isLang", () => {
  it("knows our two languages only", () => {
    expect(isLang("fr")).toBe(true);
    expect(isLang("en")).toBe(true);
    expect(isLang("FR")).toBe(false);
    expect(isLang("de")).toBe(false);
    expect(isLang(undefined)).toBe(false);
  });
});
