/**
 * Throwaway validation harness — runs the pure Evolus mapper against the
 * REAL "Patient Insights" export and prints the headline counts so we can
 * eyeball them against Synthesis v2 §2 before wiring any DB. Not shipped.
 *
 *   npx tsx scripts/validate-evolus-mapper.ts
 */
import { readFileSync } from "node:fs";
import {
  parseRewardCsv,
  summarizeRewardEntries,
  rewardMatchKey,
} from "../src/lib/manufacturer-reward-csv";

const FILE =
  "/Users/david_air/Desktop/Evolus Patient Insights - 06.07.2026/Patient Insights - 06.07.2026.csv";
const TODAY = "2026-06-07";

const text = readFileSync(FILE, "utf8");
const parsed = parseRewardCsv("evolus", text);
const summary = summarizeRewardEntries(parsed.entries, TODAY, 60);

console.log("── Evolus mapper validation ──────────────────────────");
console.log("data rows (patients):   ", parsed.dataRowCount);
console.log("entries (patient×brand):", parsed.entries.length);
console.log("warnings:               ", parsed.warnings.length);
console.log("distinct patients:      ", summary.distinctPatients);
console.log("byStatus:               ", JSON.stringify(summary.byStatus));
console.log("eligible now:           ", summary.eligibleNow);
console.log("expiring ≤60d:          ", summary.expiringSoon);
console.log("dollars on table:       ", summary.dollarsOnTable);

// Per-brand breakdown
const byBrand: Record<string, number> = {};
for (const e of parsed.entries) byBrand[e.brandProduct] = (byBrand[e.brandProduct] ?? 0) + 1;
console.log("by brand:               ", JSON.stringify(byBrand));

// Match-key channel mix (how reliably can we link to the patient graph?)
const chan: Record<string, number> = { e: 0, p: 0, n: 0, u: 0 };
for (const e of parsed.entries) chan[rewardMatchKey(e)[0]]++;
console.log("match-key channel mix:  ", JSON.stringify(chan), "(e=email p=phone n=name u=none)");

console.log("\n── first 3 entries ──");
for (const e of parsed.entries.slice(0, 3)) {
  console.log(
    `${e.contactName} · ${e.brandProduct} · ${e.statusRaw}→${e.statusNorm} · elig ${e.eligibleDate} · exp ${e.expirationDate} · ${e.contactEmail ?? e.contactPhone}`,
  );
}
console.log("\n── sample warnings (first 5) ──");
for (const w of parsed.warnings.slice(0, 5)) console.log(`row ${w.sourceRow}: ${w.message}`);
