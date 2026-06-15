#!/usr/bin/env node
/**
 * truncation tripwire — block NEW silent-truncation risks from shipping.
 *
 * WHY (2026-06-15): "silent truncation" is a recurring CLASS of bug — a bounded
 * read returns PARTIAL data with NO error and the caller treats it as complete,
 * so data is silently dropped. It bit us 3× in one session (reliability sweep
 * recomputed 174 of 695 patients; Acuity reconcile/backfill `max:1000`; rep
 * recruit-stats under-reporting). Memory (the HARDEN lens) catches it only when
 * Claude remembers to look. This makes the lens HARNESS-ENFORCED: the deploy
 * refuses to ship code that reintroduces the class — survives compaction,
 * model, and session.
 *
 * Like scripts/tsc-tripwire.mjs, it freezes the KNOWN occurrences as a baseline
 * (scripts/truncation-baseline.json) and fails only on a NEW signature — a new
 * file, a new table read, or an EXTRA occurrence. Line numbers are not part of
 * the signature, so moving code around never trips it.
 *
 * Two patterns (the two that actually caused silent data loss):
 *   A. Unpaginated Supabase bulk `.select()` — a `.from("t").select(...)` read
 *      chain with NO `.range()`/`.limit()`/`.single()`/`.maybeSingle()`/count,
 *      and not a write. PostgREST silently caps it at 1000 rows. FIX: route
 *      through `selectAllRows` (src/lib/supabase-paginate.ts) or add `.range()`.
 *   B. Raw `listAcuityAppointments(... max: ...)` — Acuity's endpoint has no
 *      offset, so a fixed `max` silently truncates a busy window. FIX: route
 *      through `listAllAcuityAppointmentsInWindow` (date-window paging).
 *
 * Scope: src/server + src/lib (where the bulk reads + helpers live). Unchunked
 * `.in()` is intentionally OUT of scope (low practical risk, noisy) — it stays
 * on the human HARDEN lens. src/routes can be added later if needed.
 *
 * Usage:
 *   node scripts/truncation-tripwire.mjs            # check; exit 1 if NEW risk
 *   node scripts/truncation-tripwire.mjs --update   # re-freeze the baseline
 *                                                   #   (after intentional change)
 *
 * Wired into `npm run deploy` alongside the tsc tripwire.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";

const BASELINE = "scripts/truncation-baseline.json";
const ROOTS = ["src/server", "src/lib"];

// Terminals/markers that make a `.select()` chain bounded → safe.
const SAFE = [
  ".single(",
  ".maybeSingle(",
  ".range(",
  ".limit(",
  ".csv(",
  "head:",
  "head :",
  "count:",
  "count :",
];
// A chain that writes (insert/upsert/update/delete) is bounded by the rows it
// touches even when it has a `.select()` returning clause → not a bulk read.
const WRITES = [".insert(", ".upsert(", ".update(", ".delete("];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** The query chain that starts at `start`, up to the next `;` (cap 800 chars
 *  so a missing terminator can't swallow the rest of the file). */
function chainAfter(text, start) {
  const semi = text.indexOf(";", start);
  const end = semi === -1 ? Math.min(text.length, start + 800) : semi;
  return text.slice(start, end);
}

function scanFile(file, counts) {
  const text = readFileSync(file, "utf8");
  const rel = file.replace(/\\/g, "/");

  // Pattern A — unpaginated Supabase bulk `.select()` read.
  const fromRe = /\.from\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let m;
  while ((m = fromRe.exec(text)) !== null) {
    const table = m[1];
    const chain = chainAfter(text, m.index);
    if (!chain.includes(".select(")) continue; // not a read
    if (WRITES.some((w) => chain.includes(w))) continue; // write w/ returning
    if (SAFE.some((s) => chain.includes(s))) continue; // bounded
    const sig = `${rel} | select | ${table}`;
    counts[sig] = (counts[sig] ?? 0) + 1;
  }

  // Pattern B — raw listAcuityAppointments( ... max: ... ).
  const acuityRe = /listAcuityAppointments\s*\(/g;
  while ((m = acuityRe.exec(text)) !== null) {
    const chain = chainAfter(text, m.index);
    if (!/\bmax\s*:/.test(chain)) continue;
    const sig = `${rel} | acuity-max | listAcuityAppointments`;
    counts[sig] = (counts[sig] ?? 0) + 1;
  }
}

const counts = {};
for (const root of ROOTS) for (const f of walk(root)) scanFile(f, counts);
const totalNow = Object.values(counts).reduce((a, b) => a + b, 0);

if (process.argv.includes("--update")) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(counts, null, 0)}\n`);
  console.log(
    `truncation tripwire: baseline frozen — ${Object.keys(counts).length} signatures, ${totalNow} known reads.`,
  );
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(
    "truncation tripwire: no baseline yet. Run `node scripts/truncation-tripwire.mjs --update` first.",
  );
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const fresh = [];
for (const [sig, count] of Object.entries(counts)) {
  const allowed = baseline[sig] ?? 0;
  if (count > allowed) {
    const [file, kind, detail] = sig.split(" | ");
    const hint =
      kind === "acuity-max"
        ? "use listAllAcuityAppointmentsInWindow (date-window paging)"
        : "paginate via selectAllRows() or add .range()/.single()/.limit()";
    fresh.push(
      `  ${file}  —  ${kind}: ${detail}${allowed ? `  (now ${count}, baselined ${allowed})` : ""}\n      ↳ ${hint}`,
    );
  }
}

if (fresh.length > 0) {
  console.error(
    `\n❌ truncation tripwire: ${fresh.length} NEW silent-truncation risk(s) — these can drop data with no error:\n`,
  );
  console.error(fresh.join("\n"));
  console.error(
    "\nMake the read truncation-safe before deploying. If this is intentional/safe,\nre-freeze with: node scripts/truncation-tripwire.mjs --update\n",
  );
  process.exit(1);
}

console.log(
  `✓ truncation tripwire: no new silent-truncation risks (${totalNow} known/baselined). Safe to ship.`,
);
process.exit(0);
