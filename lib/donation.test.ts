import { describe, expect, it } from "vitest";
import { anonymize } from "./anonymize";
import { makeBundle, type Bundle } from "./bundle";
import { buildExample, EXAMPLE_TARGET } from "./client/example";
import { checkDonation } from "./donation";

function raw(): Bundle {
  const bundle = makeBundle(buildExample(1_800_000_000), { app: "test", answer: { kind: "strong", id: EXAMPLE_TARGET, score: 12, f0: 92, clock: 0 } });
  bundle.truth = { heard: EXAMPLE_TARGET, note: "seen it pass" };
  return bundle;
}

const copy = (b: Bundle): Bundle => JSON.parse(JSON.stringify(b));

describe("checkDonation", () => {
  it("accepts an anonymised bundle", () => {
    expect(checkDonation(anonymize(raw()))).toEqual([]);
  });

  it("accepts one without a truth (the giver was not sure)", () => {
    const b = anonymize(raw());
    delete b.truth;
    expect(checkDonation(b)).toEqual([]);
  });

  it("refuses the bundle as recorded", () => {
    const problems = checkDonation(raw());
    expect(problems).toContain("not anonymised");
    expect(problems).toContain("listener is not at the origin");
    expect(problems).toContain("clock not moved to the epoch");
  });

  it("refuses an aircraft that kept its identity or its place", () => {
    const named = copy(anonymize(raw()));
    named.recording.polls[0].aircraft[0].flight = "AFR123";
    expect(checkDonation(named).join()).toMatch(/not anonymised/);
    const placed = copy(anonymize(raw()));
    placed.recording.polls[0].aircraft[0].lat = 48.85;
    expect(checkDonation(placed).join()).toMatch(/not anonymised/);
  });

  it("refuses a truth that names a real address, and anything that is not a bundle", () => {
    const b = copy(anonymize(raw()));
    b.truth = { heard: "39ab12", note: "" };
    expect(checkDonation(b)).toContain("truth names no anonymised aircraft");
    expect(checkDonation("hello")).toEqual(["not an object"]);
    expect(checkDonation({ version: 1, anonymous: true })).toContain("no recording");
  });
});
