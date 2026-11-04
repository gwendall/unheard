import { describe, expect, it } from "vitest";
import { whereExampleWav } from "./where-example";
import { whereExample } from "./where-example-fill";
import made from "./where-example.json";

describe("the example of /example", () => {
  it("is a WAV of the whole scene", () => {
    const bytes = whereExampleWav();
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(bytes.length).toBe(44 + made.duration * 8000 * 2);
  });

  it("asks the search about the hour its flights fly, from some way off its spot", () => {
    expect(whereExample.prefill).toEqual({ day: made.day, time: new Date(made.start * 1000).toISOString().slice(11, 16), zone: "utc" });
    expect(whereExample.roughly).toEqual(made.roughly);
    const km = Math.hypot((made.roughly.lat - made.spot.lat) * 111, (made.roughly.lon - made.spot.lon) * 93);
    expect(km).toBeGreaterThan(5);
    expect(km).toBeLessThan(25);
  });
});
