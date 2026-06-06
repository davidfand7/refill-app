#!/usr/bin/env node
/**
 * tsc tripwire — catch NEW TypeScript errors without drowning in old noise.
 *
 * WHY (2026-06-05): `vite build` / `npm run deploy` use esbuild, which strips
 * types and does NOT type-check. So dangling references (e.g. calling a setter
 * whose useState was deleted) ship and throw at RUNTIME. A bare `tsc --noEmit`
 * would catch them — but this codebase carries ~267 PRE-EXISTING type errors
 * (mostly a stale generated types.ts: SelectQueryError noise in seed.ts /
 * zoho.functions / nav-features / NotificationCenter), so tsc output is a wall
 * of red and useless as an alarm.
 *
 * This freezes the known errors as a BASELINE (scripts/tsc-baseline.json) and
 * fails only on NEW error SIGNATURES — a new file, a new error code/message, or
 * an EXTRA occurrence of an existing one. Line/column numbers are stripped so
 * unrelated code moving around never trips it. The next setResult-class bug
 * (a fresh TS2304 "Cannot find name") is a new signature → blocked.
 *
 * Usage:
 *   node scripts/tsc-tripwire.mjs            # check; exit 1 if NEW errors
 *   node scripts/tsc-tripwire.mjs --update   # re-freeze the baseline (after an
 *                                            #   intentional change to the noise)
 *
 * Wired into `npm run deploy` as a pre-step so a new type error blocks the ship.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BASELINE = "scripts/tsc-baseline.json";

function runTsc() {
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    return "";
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

/** Map normalized signature ("file|error TS####: message") → occurrence count.
 *  Line/col stripped so code movement doesn't create phantom "new" errors. */
function signatureCounts(output) {
  const counts = {};
  for (const line of output.split("\n")) {
    const m = line.match(/^(.+?)\(\d+,\d+\): (error TS\d+: .+)$/);
    if (!m) continue;
    const sig = `${m[1]}|${m[2]}`;
    counts[sig] = (counts[sig] ?? 0) + 1;
  }
  return counts;
}

const current = signatureCounts(runTsc());
const totalNow = Object.values(current).reduce((a, b) => a + b, 0);

if (process.argv.includes("--update")) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 0)}\n`);
  console.log(
    `tsc tripwire: baseline frozen — ${Object.keys(current).length} signatures, ${totalNow} known errors.`,
  );
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(
    "tsc tripwire: no baseline yet. Run `node scripts/tsc-tripwire.mjs --update` first.",
  );
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const fresh = [];
for (const [sig, count] of Object.entries(current)) {
  const allowed = baseline[sig] ?? 0;
  if (count > allowed) {
    const [file, err] = sig.split("|");
    fresh.push(`  ${file}  —  ${err}${allowed ? `  (now ${count}, baselined ${allowed})` : ""}`);
  }
}

if (fresh.length > 0) {
  console.error(
    `\n❌ tsc tripwire: ${fresh.length} NEW type error(s) — esbuild would ship these:\n`,
  );
  console.error(fresh.join("\n"));
  console.error(
    "\nFix them before deploying. If this is an intentional change to known noise,\nre-freeze with: node scripts/tsc-tripwire.mjs --update\n",
  );
  process.exit(1);
}

console.log(
  `✓ tsc tripwire: no new type errors (${totalNow} known/baselined). Safe to ship.`,
);
process.exit(0);
