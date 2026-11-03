import { describe, expect, it } from "vitest";
import { en } from "./en";
import { fr, frenchSpacing } from "./fr";

describe("frenchSpacing", () => {
  it("puts the non-breaking spaces French typography wants", () => {
    expect(frenchSpacing("Ce qui est envoyé : le son ; rien ?")).toBe("Ce qui est envoyé : le son ; rien ?");
    expect(frenchSpacing("il dit « C'était »")).toBe("il dit « C'était »");
    expect(frenchSpacing("8 000 échantillons")).toBe("8 000 échantillons");
  });
  it("reaches strings made by the dictionary's functions", () => {
    expect(fr.proof.measured("2 novembre 2026")).toBe("Dernière mesure le 2 novembre 2026.");
    expect(fr.proof.wrong(0, 118, 38)).toContain("« C'était »");
  });
});

describe("fr", () => {
  it("has every key en has, and no English left in the visible strings", () => {
    const keys = (o: object, at = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? keys(v, `${at}${k}.`) : [`${at}${k}`]));
    expect(keys(fr)).toEqual(keys(en));
    expect(fr.hero.listen).not.toBe(en.hero.listen);
  });
});
