// Pulls the donated recordings from the private Blob store into evals/.cache/donations/, checks
// each one (lib/donation.ts) and keeps those that pass. The real-audio eval then replays them
// through analyze() with the others. Needs BLOB_READ_WRITE_TOKEN: `vercel env pull .env.local`.
//
//   pnpm fetch-donations                  pull what is new, list what fails the check
//   pnpm fetch-donations --delete-invalid also delete those from the store

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { del, get, list } from "@vercel/blob";
import { checkDonation } from "../lib/donation";

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error("BLOB_READ_WRITE_TOKEN is missing: run `vercel env pull .env.local` first.");
  process.exit(1);
}
const deleteInvalid = process.argv.includes("--delete-invalid");
const dir = new URL("../evals/.cache/donations/", import.meta.url);
mkdirSync(dir, { recursive: true });

let cursor: string | undefined;
let pulled = 0;
let known = 0;
const invalid: string[] = [];
do {
  const page = await list({ prefix: "donations/v1/", cursor, token });
  for (const blob of page.blobs) {
    const id = blob.pathname.replace(/^donations\/v1\//, "").replace(/\.json$/, "");
    const file = new URL(`${id}.json`, dir);
    if (existsSync(file)) {
      known++;
      continue;
    }
    const got = await get(blob.pathname, { access: "private", token });
    if (!got || got.statusCode !== 200) throw new Error(`could not read ${blob.pathname}`);
    const text = await new Response(got.stream).text();
    let problems: string[];
    try {
      problems = checkDonation(JSON.parse(text));
    } catch {
      problems = ["not JSON"];
    }
    if (problems.length) {
      invalid.push(`${blob.pathname}: ${problems.join("; ")}`);
      if (deleteInvalid) await del(blob.pathname, { token });
      continue;
    }
    writeFileSync(file, text);
    pulled++;
  }
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

console.log(`${pulled} new, ${known} already here, ${invalid.length} failing the check${deleteInvalid && invalid.length ? " (deleted)" : ""}.`);
for (const line of invalid) console.log(`  ${line}`);
