import { describe, expect, it } from "vitest";
import { analyze } from "../core/pipeline";
import { buildExample, EXAMPLE_TARGET } from "./example";

describe("the simulated example", () => {
  it("ends on a strong match with its target", async () => {
    const rec = buildExample(1_800_000_000);
    const { verdict } = await analyze(rec);
    expect(verdict.best?.id).toBe(EXAMPLE_TARGET);
    expect(verdict.kind).toBe("strong");
  }, 60_000);
});
