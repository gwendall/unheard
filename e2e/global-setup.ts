import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// The fixture is made from the same synthesizer as the tests, not stored (7 MB of WAV).
export default function globalSetup() {
  const wav = new URL("./fixtures/flyby.wav", import.meta.url);
  const polls = new URL("./fixtures/flyby-polls.json", import.meta.url);
  if (existsSync(wav) && existsSync(polls) && !process.env.E2E_REFRESH) return;
  execFileSync("pnpm", ["exec", "tsx", "scripts/make-e2e-fixture.ts"], { stdio: "inherit" });
}
