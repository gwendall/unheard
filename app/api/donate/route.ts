import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { DONATION_PATH, MAX_DONATION_BYTES } from "@/lib/donation";

// Gives the page a short-lived token to upload one donated recording, already anonymised on the
// phone (lib/anonymize.ts), straight to the private Blob store: a five-minute recording is larger
// than a function's body limit. The token allows one path, JSON only, 12 MB at most, for ten
// minutes. Nothing about the request (address, headers) is stored with the recording. Every
// donation is checked again when it is pulled into the dataset (scripts/fetch-donations.ts).
export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return Response.json({ error: "donations are not set up here" }, { status: 503 });
  try {
    const body = (await request.json()) as HandleUploadBody;
    if (body.type !== "blob.generate-client-token") return Response.json({ error: "unexpected request" }, { status: 400 });
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (pathname !== DONATION_PATH) throw new Error("unexpected path");
        return {
          allowedContentTypes: ["application/json"],
          maximumSizeInBytes: MAX_DONATION_BYTES,
          addRandomSuffix: true,
          validUntil: Date.now() + 10 * 60_000,
        };
      },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
