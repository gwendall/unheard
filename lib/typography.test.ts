import { describe, expect, it } from "vitest";
import { frenchSpacing, typeset } from "./typography";

describe("frenchSpacing", () => {
  it("puts the non-breaking spaces French typography wants", () => {
    expect(frenchSpacing("Ce qui est envoyé : le son ; rien ?")).toBe("Ce qui est envoyé : le son ; rien ?");
    expect(frenchSpacing("il dit « C'était »")).toBe("il dit « C'était »");
    expect(frenchSpacing("8 000 échantillons")).toBe("8 000 échantillons");
  });
});

describe("typeset", () => {
  it("reaches every string of a tree and keeps its shape", () => {
    expect(typeset("fr", { a: "Oui ?", b: ["Non !", 3], c: { d: { one: "{n} avion ?", other: "{n} avions ?" } } })).toEqual({
      a: "Oui ?",
      b: ["Non !", 3],
      c: { d: { one: "{n} avion ?", other: "{n} avions ?" } },
    });
  });
  it("leaves a language with no rule as it is", () => {
    const tree = { a: "Yes ?" };
    expect(typeset("en", tree)).toBe(tree);
  });
});
