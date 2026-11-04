import { describe, expect, it } from "vitest";
import { completeXml, CORS, corsReady, PART, partsOf } from "../scripts/map-job";

describe("the map's copy", () => {
  it("cuts a file in parts that cover it, each byte once", () => {
    const parts = partsOf(10, 4);
    expect(parts).toEqual([
      { number: 1, start: 0, end: 3 },
      { number: 2, start: 4, end: 7 },
      { number: 3, start: 8, end: 9 },
    ]);
    expect(partsOf(8, 4)).toHaveLength(2);
  });

  it("stays under what S3 allows, for the planet", () => {
    const parts = partsOf(139_266_691_175);
    expect(parts.length).toBeLessThan(10_000);
    expect(parts.at(-1)!.end).toBe(139_266_691_174);
    expect(parts[0].end).toBe(PART - 1);
  });

  it("lists the parts in order when it finishes", () => {
    expect(completeXml([{ number: 2, etag: '"b"' }, { number: 1, etag: '"a"' }])).toBe('<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"a"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"b"</ETag></Part></CompleteMultipartUpload>');
  });
});

describe("the bucket's CORS", () => {
  it("keeps reads open to any origin, and exposes what a range reader needs", () => {
    expect(corsReady(CORS)).toBe(true);
    for (const part of ["<AllowedOrigin>*<", "<AllowedMethod>GET<", "<AllowedMethod>HEAD<", "<AllowedHeader>*<", "<ExposeHeader>ETag<", "<ExposeHeader>Content-Range<"]) expect(CORS).toContain(part);
  });

  it("does not take the flight job's rule for enough", () => {
    const flightJob = "<CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader></CORSRule>";
    expect(corsReady(flightJob)).toBe(false);
  });

  it("stays what the flight job looks for, so that it leaves the rule alone", () => {
    for (const part of ["<AllowedOrigin>*<", "<AllowedMethod>GET<", "<AllowedMethod>HEAD<"]) expect(CORS).toContain(part);
  });
});
