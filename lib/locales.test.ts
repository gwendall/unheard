import { describe, expect, it } from "vitest";
import { fill, isLocale, pageOf, pathFor, plural } from "./locales";

describe("paths", () => {
  it("puts English at / and every other language under its code", () => {
    expect(pathFor("en")).toBe("/");
    expect(pathFor("en", "/privacy")).toBe("/privacy");
    expect(pathFor("fr")).toBe("/fr");
    expect(pathFor("fr", "/privacy")).toBe("/fr/privacy");
  });
  it("finds the page of a path, whatever its language", () => {
    expect(pageOf("/")).toBe("");
    expect(pageOf("/fr")).toBe("");
    expect(pageOf("/en")).toBe("");
    expect(pageOf("/privacy")).toBe("/privacy");
    expect(pageOf("/fr/privacy")).toBe("/privacy");
  });
  it("knows its languages", () => {
    expect(isLocale("fr")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("FR")).toBe(false);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe("fill and plural", () => {
  it("fills placeholders, numbers the language's way, and leaves unknown ones", () => {
    expect(fill("{name} is coming", { name: "A Cessna" })).toBe("A Cessna is coming");
    expect(fill("{n} of {total}", { n: 1200 })).toBe("1,200 of {total}");
    expect(fill("{n} sur 10", { n: 1200 }, "fr")).toBe("1 200 sur 10");
    expect(fill("score {s}", { s: 6.5 }, "fr")).toBe("score 6,5");
  });
  it("picks the plural form by the language's rules", () => {
    const en = { one: "{n} plane", other: "{n} planes" };
    const fr = { one: "{n} avion", other: "{n} avions" };
    expect(plural("en", 0, en)).toBe("0 planes");
    expect(plural("en", 1, en)).toBe("1 plane");
    expect(plural("fr", 0, fr)).toBe("0 avion");
    expect(plural("fr", 2, fr, { x: "y" })).toBe("2 avions");
    expect(plural("en", 3, { other: "{n} times" })).toBe("3 times");
  });
});
