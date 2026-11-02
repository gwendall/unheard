// CI, after the evals: what this run found next to the base branch's numbers (evals/results.json
// as committed there), into the job summary and, on a same-repository pull request, one comment
// kept up to date. Never fails the job: the baseline ratchet in the evals is the gate.
//
//   node scripts/eval-delta.ts synthetic real-tracks    (the evals this job ran)

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Counts = {
  heard: { n: number; strongHit: number; anyHit: number; wrongStrong: number; wrongPossible: number };
  empty: { n: number; falseStrong: number; falsePossible: number };
  date?: string;
};
type Results = Record<string, Counts>;

const MARKER = "<!-- eval-delta -->";
const names = process.argv.slice(2);
const event = process.env.GITHUB_EVENT_NAME;

const parse = (text: string): Results => {
  try {
    return JSON.parse(text) as Results;
  } catch {
    return {};
  }
};
const atCommit = (rev: string): Results => {
  try {
    return parse(execFileSync("git", ["show", `${rev}:evals/results.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return {};
  }
};

const fresh = parse(readFileSync(new URL("../evals/results.json", import.meta.url), "utf8"));
const committed = atCommit("HEAD");
// A pull_request checkout is the merge commit: its first parent is the base branch's head
// (checkout with fetch-depth 2). On a push, the commit before.
const base = atCommit("HEAD^1");
const baseName = event === "pull_request" ? "base branch" : "previous commit";

const METRICS: [string, (c: Counts) => [number, number]][] = [
  ["Sure and right", (c) => [c.heard.strongHit, c.heard.n]],
  ["Named and right", (c) => [c.heard.anyHit, c.heard.n]],
  ["Sure but wrong", (c) => [c.heard.wrongStrong, c.heard.n]],
  ["Possible but wrong", (c) => [c.heard.wrongPossible, c.heard.n]],
  ["Sure with nothing to find", (c) => [c.empty.falseStrong, c.empty.n]],
  ["Possible with nothing to find", (c) => [c.empty.falsePossible, c.empty.n]],
];
const cell = ([k, n]: [number, number]) => (n ? `${k} / ${n} (${Math.round((100 * k) / n)} %)` : "none");
const change = (a: [number, number] | null, b: [number, number]) => {
  if (!a || !a[1] || !b[1]) return "";
  const pts = (100 * b[0]) / b[1] - (100 * a[0]) / a[1];
  if (Math.abs(pts) < 0.05 && a[0] === b[0]) return "=";
  return `${pts > 0 ? "+" : ""}${pts.toFixed(1)} pts`;
};
const same = (a?: Counts, b?: Counts) => !!a && !!b && JSON.stringify([a.heard, a.empty]) === JSON.stringify([b.heard, b.empty]);

const lines = [MARKER, "### Evals: this run next to the " + baseName, ""];
for (const name of names) {
  const now = fresh[name];
  if (!now) {
    lines.push(`**${name}**: no result in this run.`, "");
    continue;
  }
  const was = base[name];
  lines.push(`**${name}**`, "", `| | ${baseName} | this run | change |`, "|---|---|---|---|");
  for (const [label, pick] of METRICS) lines.push(`| ${label} | ${was ? cell(pick(was)) : "none"} | ${cell(pick(now))} | ${change(was ? pick(was) : null, pick(now))} |`);
  lines.push("");
  if (!same(now, committed[name])) lines.push(`> \`evals/results.json\` in this commit does not match this run for ${name}: run \`pnpm eval\` and \`pnpm scoreboard\`, and commit both.`, "");
}
lines.push('"Sure but wrong" and "Sure with nothing to find" must stay at 0.');
const body = lines.join("\n") + "\n";

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
else process.stdout.write(body);

// One comment per pull request, updated in place. A fork's token cannot write: skip quietly.
if (event === "pull_request" && process.env.GITHUB_EVENT_PATH) {
  try {
    const pr = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).pull_request;
    const repo = pr.base.repo.full_name as string;
    if (pr.head.repo?.full_name !== repo) {
      console.log("eval delta: pull request from a fork, no comment (job summary only)");
    } else {
      const file = join(tmpdir(), `eval-delta-${process.pid}.md`);
      writeFileSync(file, body);
      const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8" }).trim();
      const id = gh(["api", `repos/${repo}/issues/${pr.number}/comments`, "--paginate", "--jq", `.[] | select(.body | contains("${MARKER}")) | .id`]).split("\n")[0];
      if (id) gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${id}`, "-F", `body=@${file}`]);
      else gh(["api", "-X", "POST", `repos/${repo}/issues/${pr.number}/comments`, "-F", `body=@${file}`]);
      console.log(`eval delta: comment ${id ? "updated" : "posted"} on #${pr.number}`);
    }
  } catch (e) {
    console.log(`eval delta: no comment (${(e as Error).message.split("\n")[0]})`);
  }
}
