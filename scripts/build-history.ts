/**
 * build-history.ts — Regenerates the canonical "everything we've shipped" doc
 * for Refill.
 *
 * Spine: src/lib/changelog.ts (every Refill version Grasshopper has shipped).
 * Decoration: hand-curated strategic milestones (the decisions and pivots
 * that shaped each ship cluster).
 * Output: ~/Desktop/David Claude Projects/Refill-Build-Log.html
 *
 * Run via:  bun run scripts/build-history.ts
 *
 * The HTML is single-file with inline CSS, light paper-tone background,
 * Refill-emerald accents, and a print-friendly layout. Georgia serif
 * headings (matches RefillHome's "Hey {spa}." greeting), system sans body.
 *
 * Regenerate cadence: ship → commit → run this script → commit the fresh
 * Refill-Build-Log.html on the Desktop. The CHANGELOG array in
 * src/lib/changelog.ts is the source of truth — keep appending new entries
 * to the top and rerun.
 *
 * Ported from openagenticv4/scripts/build-history.ts on 2026-05-26.
 * Differences from source:
 *   1. CHANGELOG items are already HTML-formatted in Refill (the version
 *      pill renders raw HTML via dangerouslySetInnerHTML), so build-log
 *      items pass through verbatim instead of going through the markdown→HTML
 *      escape pipeline used for Agentiport.
 *   2. Refill uses semver-ish versions (v1.5.2, v1.4.6, …) so the sort
 *      walks all three numeric segments instead of just the leading int.
 *   3. Refill-era strategic milestones replace the Agentiport ones.
 *   4. Patents section dropped — Refill doesn't have filed patent moats
 *      to surface at this stage.
 *   5. Accent palette shifts from Agentiport amber/gold to Refill
 *      emerald (#056048) / pale sage (#e8f3ed).
 */

import { CHANGELOG } from "../src/lib/changelog.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const OUT_PATH = path.join(
  os.homedir(),
  "Desktop",
  "David Claude Projects",
  "Refill-Build-Log.html",
);

// ── Strategic milestones to highlight ──────────────────────────────────────
// The decisions and pivots that shaped each ship cluster. Hand-curated —
// pulled from named memory files written at the moment of decision.

type Milestone = {
  title: string;
  date: string;
  versionRange?: string;
  blurb: string;
  source: string;
};

const MILESTONES: Milestone[] = [
  {
    title: "Refill cleaved into a standalone product",
    date: "2026-05-16",
    versionRange: "v1.0 era (pre-changelog reset)",
    blurb:
      "Pivot moment. /scan + the no-show recovery engine were strong enough to stand on their own. getrefill.app went live as a standalone domain with its own shell, narrow nav (Recovery / Inbox / Settings / Billing), and dedicated brand. The same day: full Refill-branded rescue email lands in a real Gmail inbox, end-to-end conversion funnel verified in production. The cleave was strategic — Refill is a friendly single-feature widget for appointment-based businesses, not a platform.",
    source: "project_refill_spinout.md",
  },
  {
    title: "No-show recovery engine — 7 ships in one day",
    date: "2026-05-16",
    blurb:
      "The full architecture landed in a single session: rescue offers table, recovery events table, cron-driven dispatcher, settings architecture, deposit-intent path. Acuity webhook → engine identifies the open slot → ranks waitlist by re-book probability → fires offers → first-tap-wins claim → reassigns the appointment → writes the recovery_event row Karen bills against. Every downstream feature on the roadmap depends on this loop working.",
    source: "project_emma_noshow_recovery_engine.md",
  },
  {
    title: "Pricing killshot locked — free + 12%",
    date: "2026-05-16",
    blurb:
      "Free for 30 days, then 12% of recovered revenue. No subscription. No floor. We bill only when a real recovered cancellation maps to a real revenue line in the spa's books. Disintermediates the med-spa PMS category — incumbents structurally can't match without breaking their own pricing models. Draft-first activation: invoices ship in draft status until the spa confirms billed amount; conversion to charge happens only when the spa says yes.",
    source: "project_pricing_killshot.md",
  },
  {
    title: "Trial-first / no-money-asks philosophy",
    date: "2026-05-20",
    blurb:
      "Core conversion philosophy: NEVER ask for money before the spa feels the WIN. Plan-pick comes AFTER trial, via drip CTA or trial-end, not in the onboarding wizard. Phase 1.6 re-scoped from 'billing' to 'trial-engagement → conversion → billing.' Drip engine, incentive engine, admin lever board. The wedge is the recovery, not the credit card form.",
    source: "project_trial_first_no_money_asks.md",
  },
  {
    title: "Single-feature positioning locked — narrow forever",
    date: "2026-05-22",
    blurb:
      "Refill stays narrow. 4 chips in the nav, period. No 'Patients' / 'Campaigns' / 'Promos' / 'Reports' surfaces. Vertical-agnostic copy — appointment-based businesses, not med-spa-specific. Refill's standalone shell never cross-links to other product surfaces. Database underneath captures everything (emma_* schema is broad) but the UI presented to the spa stays focused on the single thing Refill does well: recover the cancellation.",
    source: "project_refill_trojan_horse_thesis.md",
  },
  {
    title: "Rejuv proof or nothing — north star locked",
    date: "2026-05-26",
    blurb:
      "IF THIS DOESN'T ACTUALLY WORK FOR REJUV — NOTHING ELSE MATTERS. Until Karen connects her real Rejuv Acuity, a real cancellation fires, the engine sends a real rescue offer, a real patient re-books, and a recovery_event row lands in her dashboard — Refill is a fancy demo. Every downstream feature on the roadmap (LiveRecoveryFeed, Stripe capture, viral share, recruit pipeline, outreach un-pause, polish items) is structurally downstream of this single round-trip.",
    source: "project_rejuv_proof_or_nothing.md",
  },
  {
    title: "Engine proven end-to-end on Karen's real Acuity",
    date: "2026-05-26",
    versionRange: "v1.4 → v1.4.6",
    blurb:
      "8 ships in one session closing 6 chain-breaks, each surfaced by sitting-in-the-chair Karen-walk testing. Methodology: run SQL → screenshot → diagnose → propose fix → ship → re-run same SQL. Caught the TZ-parsing storage bug (every appointment 6 hours off for MT spas), the rescue_enabled gate, the fromNumber gate (proxy-email-only mode blocker post-carriers-mothballed), the TZ display sweep across 8 renderers, the stale claim URL hostname. Round-trip proven: Karen cancels → engine fires → rescue email delivers → David claims → slot reassigns → David Anderson appears PURPLE on Karen's Acuity calendar, indistinguishable from her normal Tox bookings.",
    source: "session_story_2026-05-26_rejuv_proof.md",
  },
  {
    title: "iMessage MCP workflow proven at patient-grade polish",
    date: "2026-05-26",
    versionRange: "v1.5 / v1.5.1 / v1.5.2",
    blurb:
      "Evening 3-ship sprint that took the iMessage MCP delivery channel from 'engine fires' to 'every surface looks the way it's supposed to look.' v1.5: AUTO-SEND directive at top of proxy email so Claude Desktop's hourly 'Refill rescue drafter' routine prompt parses deterministically. v1.5.1: Refill OG image + brand asset migration — killed the OpenAgentic homepage preview card in iMessage, closed a silent favicon 404 that had been live since the cleave. v1.5.2: patient-context OG card variant for the rescue claim route — paper-tone aesthetic + emerald Georgia wordmark, copy swaps from spa-owner pricing to 'Your appointment slot just opened up.'",
    source: "session_story_2026-05-26_imessage_polish.md",
  },
  {
    title: "Autonomous MCP cron + spa-side step 6 proven",
    date: "2026-05-26",
    versionRange: "v1.5.2 (live verification)",
    blurb:
      "Late-session verification, no code change. Acuity cancel at 2:58 PM MT → Claude Desktop hourly MCP cron caught the proxy email at the top of the hour → iMessage sent autonomously to the patient at 3:02 PM with the correct Refill preview card — zero human in the loop. Spa-side step 6 (recovery_event lands in Karen's dashboard) visually proven at 3:24 PM: Karen's RefillHome LiveRecoveryFeed renders the populated widget with $1,985 / 7 days, $3,925 lifetime, 17 events on file, top of the 'Most Recent' list showing today's two real rescues with relative timestamps. Trojan-horse positioning visually confirmed at every layer — Acuity calendar, iMessage preview card, Recovery dashboard, RefillHome widget.",
    source: "session_story_2026-05-26_imessage_polish.md (extended)",
  },
];

// ── HTML helpers ───────────────────────────────────────────────────────────

const escape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Render inline backticks as <code>, **bold** as <strong>, *italic* as <em>.
// Used for milestone blurbs (which are markdown-flavored); changelog items
// pass through verbatim because they're already HTML in src/lib/changelog.ts.
function renderInline(text: string): string {
  let out = escape(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return out;
}

// Refill versions are semver-ish (v1.5.2, v1.4.6, v1.5, v1.4). Walk all
// three segments so v1.5.2 > v1.5 > v1.4.6 > v1.4 sort correctly.
function parseVersionTuple(v: string): [number, number, number] {
  const m = /v(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
  if (!m) return [0, 0, 0];
  return [
    parseInt(m[1], 10),
    m[2] ? parseInt(m[2], 10) : 0,
    m[3] ? parseInt(m[3], 10) : 0,
  ];
}

function cmpVersionDesc(a: string, b: string): number {
  const A = parseVersionTuple(a);
  const B = parseVersionTuple(b);
  if (A[0] !== B[0]) return B[0] - A[0];
  if (A[1] !== B[1]) return B[1] - A[1];
  return B[2] - A[2];
}

function groupByDate(entries: typeof CHANGELOG) {
  const byDate = new Map<string, typeof CHANGELOG>();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date)!.push(e);
  }
  return Array.from(byDate.entries());
}

function renderMilestones(): string {
  return MILESTONES.map((m) => {
    return `
    <article class="milestone">
      <header class="milestone-header">
        <span class="milestone-date">${escape(m.date)}</span>
        ${m.versionRange ? `<span class="milestone-version">${escape(m.versionRange)}</span>` : ""}
      </header>
      <h3 class="milestone-title">${escape(m.title)}</h3>
      <p class="milestone-blurb">${renderInline(m.blurb)}</p>
      <footer class="milestone-source">From <code>${escape(m.source)}</code></footer>
    </article>`;
  }).join("\n");
}

function renderBuildLog(): string {
  const sorted = [...CHANGELOG].sort((a, b) => cmpVersionDesc(a.version, b.version));
  const groups = groupByDate(sorted);

  return groups
    .map(([date, entries]) => {
      const versionRange = `${entries[0].version} → ${entries[entries.length - 1].version}`;
      const cards = entries
        .map((e) => {
          // Items are already HTML-formatted in src/lib/changelog.ts —
          // pass through verbatim. Don't escape, don't markdown-render.
          const items = e.items.map((it) => `<li>${it}</li>`).join("\n          ");
          return `
      <article class="version-card" id="${escape(e.version)}">
        <header class="version-header">
          <span class="version-pill">${escape(e.version)}</span>
        </header>
        <ul class="version-items">
          ${items}
        </ul>
      </article>`;
        })
        .join("\n");
      return `
  <section class="month-section">
    <header class="month-header">
      <h3 class="month-title">${escape(date)}</h3>
      <span class="month-meta">${entries.length} ${entries.length === 1 ? "release" : "releases"} · ${escape(versionRange)}</span>
    </header>
    ${cards}
  </section>`;
    })
    .join("\n");
}

function renderHtml(): string {
  const generatedAt = new Date().toISOString().slice(0, 10);
  const totalReleases = CHANGELOG.length;
  const sortedDesc = [...CHANGELOG].sort((a, b) => cmpVersionDesc(a.version, b.version));
  const latestVersion = sortedDesc[0]?.version;
  const earliestVersion = sortedDesc[sortedDesc.length - 1]?.version;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Refill — Build Log</title>
  <style>
    /* ─ Reset + base ─────────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      font-size: 15.5px;
      line-height: 1.65;
      color: #1c2024;
      background: #faf8f3;
      font-feature-settings: "kern", "liga", "calt";
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    h1, h2, h3, h4 {
      font-family: "Georgia", "Times New Roman", "Iowan Old Style", serif;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: #14130f;
    }
    h1 { font-size: 2.4rem; line-height: 1.15; margin: 0 0 0.4rem; }
    h2 { font-size: 1.55rem; line-height: 1.25; margin: 3rem 0 1rem; padding-bottom: 0.45rem; border-bottom: 1px solid #e6e2d6; }
    h3 { font-size: 1.1rem; line-height: 1.3; margin: 0 0 0.4rem; }
    p { margin: 0 0 1em; }
    code {
      font-family: "JetBrains Mono", "SF Mono", ui-monospace, "Menlo", monospace;
      font-size: 0.88em;
      background: #e8f3ed;
      color: #056048;
      padding: 0.08em 0.35em;
      border-radius: 4px;
    }
    a { color: #056048; text-decoration: none; border-bottom: 1px solid #b8dcc9; }
    a:hover { color: #034733; }
    em { color: #4a4640; }
    strong { color: #14130f; }

    /* ─ Page frame ───────────────────────────────────────────────────── */
    .page { max-width: 820px; margin: 0 auto; padding: 4rem 2rem 8rem; }

    /* ─ Cover ────────────────────────────────────────────────────────── */
    .cover {
      padding-bottom: 2.5rem;
      border-bottom: 1px solid #e6e2d6;
      margin-bottom: 1rem;
    }
    .eyebrow {
      display: inline-block;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #056048;
      background: #e8f3ed;
      padding: 0.35rem 0.7rem;
      border-radius: 999px;
      margin-bottom: 1.4rem;
    }
    .lede {
      font-size: 1.1rem;
      color: #5a6068;
      max-width: 38em;
      margin-top: 0.6rem;
    }
    .cover-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 1.5rem;
      margin-top: 1.8rem;
      font-size: 0.88rem;
      color: #6b665e;
    }
    .cover-meta dt { font-weight: 600; color: #14130f; margin-right: 0.4em; display: inline; }
    .cover-meta dd { margin: 0; display: inline; }
    .cover-meta div { display: flex; align-items: baseline; }

    /* ─ TOC ──────────────────────────────────────────────────────────── */
    .toc {
      background: #fdfbf5;
      border: 1px solid #e6e2d6;
      border-radius: 12px;
      padding: 1.4rem 1.8rem;
      margin: 2.5rem 0;
    }
    .toc h2 {
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: #6b665e;
      margin: 0 0 0.7rem;
      padding: 0;
      border: none;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    .toc ol { margin: 0; padding-left: 1.2rem; columns: 2; column-gap: 1.5rem; }
    .toc li { margin-bottom: 0.35rem; break-inside: avoid; }
    .toc a { border: none; }

    /* ─ Section intros ───────────────────────────────────────────────── */
    .section-intro {
      color: #5a6068;
      font-size: 0.97rem;
      max-width: 38em;
      margin-bottom: 2rem;
    }

    /* ─ Milestone cards ──────────────────────────────────────────────── */
    .milestone {
      background: #ffffff;
      border: 1px solid #e6e2d6;
      border-left: 3px solid #056048;
      border-radius: 10px;
      padding: 1.3rem 1.6rem;
      margin-bottom: 1.1rem;
      page-break-inside: avoid;
    }
    .milestone-header {
      display: flex;
      gap: 0.7rem;
      align-items: baseline;
      font-size: 0.75rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #056048;
      font-weight: 700;
      margin-bottom: 0.3rem;
    }
    .milestone-version {
      background: #e8f3ed;
      padding: 0.1rem 0.5rem;
      border-radius: 4px;
      font-size: 0.7rem;
    }
    .milestone-title { color: #14130f; margin-bottom: 0.5rem; }
    .milestone-blurb { color: #2c2925; margin-bottom: 0.8rem; }
    .milestone-source { font-size: 0.78rem; color: #8a9098; }

    /* ─ Build log ────────────────────────────────────────────────────── */
    .month-section { margin-bottom: 2.8rem; }
    .month-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
      padding-bottom: 0.6rem;
      border-bottom: 1px dashed #e6e2d6;
      margin-bottom: 1.2rem;
    }
    .month-title {
      font-size: 1.25rem;
      font-family: "Georgia", "Times New Roman", serif;
      margin: 0;
    }
    .month-meta {
      font-size: 0.82rem;
      color: #8a9098;
      font-variant-numeric: tabular-nums;
    }
    .version-card {
      background: #ffffff;
      border: 1px solid #e6e2d6;
      border-radius: 8px;
      padding: 1.05rem 1.4rem 1.1rem;
      margin-bottom: 0.7rem;
      page-break-inside: avoid;
    }
    .version-header {
      display: flex;
      align-items: center;
      gap: 0.7rem;
      margin-bottom: 0.5rem;
    }
    .version-pill {
      display: inline-block;
      font-family: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: #056048;
      background: #e8f3ed;
      padding: 0.18rem 0.55rem;
      border-radius: 6px;
    }
    .version-items {
      margin: 0;
      padding-left: 1.3rem;
      color: #2c2925;
    }
    .version-items li {
      margin-bottom: 0.6rem;
      line-height: 1.62;
    }
    .version-items li:last-child { margin-bottom: 0; }

    /* ─ Footer / append schema ───────────────────────────────────────── */
    .append-note {
      margin-top: 4rem;
      padding: 1.5rem 1.8rem;
      background: #fdfbf5;
      border: 1px dashed #056048;
      border-radius: 10px;
      color: #4a4640;
      font-size: 0.9rem;
    }
    .append-note strong { color: #14130f; }

    /* ─ Print ────────────────────────────────────────────────────────── */
    @media print {
      body { background: #ffffff; }
      .page { max-width: none; padding: 1cm; }
      a { color: #14130f; border: none; }
      .milestone, .version-card { box-shadow: none; }
    }
  </style>
</head>
<body>
  <main class="page">

    <header class="cover">
      <span class="eyebrow">Refill · Build Log</span>
      <h1>Everything we've shipped.</h1>
      <p class="lede">A canonical, ever-growing record of what got built, what got decided, and why &mdash; for Grasshopper. Source of truth: the version pill in the running app. This doc regenerates from <code>src/lib/changelog.ts</code> on every ship.</p>
      <dl class="cover-meta">
        <div><dt>Generated</dt><dd>${escape(generatedAt)}</dd></div>
        <div><dt>Latest release</dt><dd>${escape(latestVersion ?? "—")}</dd></div>
        <div><dt>First tracked release</dt><dd>${escape(earliestVersion ?? "—")}</dd></div>
        <div><dt>Total releases</dt><dd>${totalReleases}</dd></div>
      </dl>
    </header>

    <nav class="toc" aria-label="Contents">
      <h2>Contents</h2>
      <ol>
        <li><a href="#strategic">Strategic milestones</a></li>
        <li><a href="#buildlog">The build log</a></li>
        <li><a href="#append">How this doc grows</a></li>
      </ol>
    </nav>

    <h2 id="strategic">Strategic milestones</h2>
    <p class="section-intro">The big decisions and pivots &mdash; the <em>why</em> behind the version log. Pulled from named memory files written down at the moment of decision so future sessions stay coherent across pivots.</p>
    ${renderMilestones()}

    <h2 id="buildlog">The build log</h2>
    <p class="section-intro">Every release shipped, newest first. Each entry is a tiny essay &mdash; the <em>what</em>, the <em>why</em>, and (often) the trail of files touched. This is what the version pill in the running app reads from.</p>
    ${renderBuildLog()}

    <aside class="append-note" id="append">
      <strong>How this doc grows.</strong> This file regenerates fresh from <code>src/lib/changelog.ts</code> + the strategic milestones above every time <code>scripts/build-history.ts</code> runs (<code>bun run scripts/build-history.ts</code>). The doc stays in lock-step with what's actually deployed &mdash; no copy-paste drift. To add a new release, append the entry to the top of the <code>CHANGELOG</code> array in the codebase; this file picks it up on next run.
    </aside>

  </main>
</body>
</html>
`;
}

// ── Run ────────────────────────────────────────────────────────────────────

const html = renderHtml();
fs.writeFileSync(OUT_PATH, html, "utf-8");
console.log(`✓ Wrote ${OUT_PATH}`);
console.log(
  `  ${CHANGELOG.length} releases · ${MILESTONES.length} milestones`,
);
