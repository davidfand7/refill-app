/**
 * Liz CSV import — pure helpers (parser + row→AccountAttachments mapper).
 *
 * Lives in src/lib so both the server fn (importLizAccounts) and the route
 * (/app/liz/accounts) can import the same parse logic — preview happens
 * client-side, upsert happens server-side, both run identical row mapping.
 *
 * No external deps. RFC-4180-aware mini-parser that handles quoted fields,
 * embedded commas, and escaped quotes ("" inside quoted fields).
 *
 * CSV shape (wide format, one column per family-field):
 *
 *   account_name, lookup_key, contact_name, contact_email, contact_phone,
 *   address, notes,
 *   botox_tier, botox_qtd, botox_qtr_end,
 *   juvederm_tier, juvederm_qtd, juvederm_qtr_end,
 *   ... (one trio per ProductFamily Liz knows about)
 *
 * Established v252 (2026-05-09).
 */

import type {
  AccountAttachments,
  AccountTier,
  ProductFamily,
} from "@/server/agent-schema";

// ── Column → ProductFamily map ────────────────────────────────────────────
// Add a new family by adding one entry here. The CSV column prefix is the
// short name (lowercased); the full dotted family path is the value.

export const FAMILY_COLUMNS: ReadonlyArray<{
  prefix: string;
  family: ProductFamily;
  label: string;
}> = [
  // Toxins
  { prefix: "botox", family: "toxins.botox", label: "Botox" },
  { prefix: "dysport", family: "toxins.dysport", label: "Dysport" },
  { prefix: "jeuveau", family: "toxins.jeuveau", label: "Jeuveau" },
  { prefix: "xeomin", family: "toxins.xeomin", label: "Xeomin" },
  // Hyaluronic acid fillers
  { prefix: "juvederm", family: "fillers.juvederm", label: "Juvederm" },
  { prefix: "restylane", family: "fillers.restylane", label: "Restylane" },
  { prefix: "rha", family: "fillers.rha", label: "RHA" },
  { prefix: "belotero", family: "fillers.belotero", label: "Belotero" },
  // Biostimulators
  { prefix: "sculptra", family: "biostimulators.sculptra", label: "Sculptra" },
  { prefix: "radiesse", family: "biostimulators.radiesse", label: "Radiesse" },
  // Skin boosters
  { prefix: "skinvive", family: "skin_boosters.skinvive", label: "Skinvive" },
  { prefix: "profhilo", family: "skin_boosters.profhilo", label: "Profhilo" },
];

const BASE_COLUMNS = [
  "account_name",
  "lookup_key",
  "contact_name",
  "contact_email",
  "contact_phone",
  "address",
  "notes",
] as const;

// ── Parsed-row shape (what the UI previews + the server upserts) ──────────

export type ParsedAccountRow = {
  /** 1-based source row number for human-friendly error messages. */
  sourceRow: number;
  accountName: string;
  /** Normalized slug; auto-derived from accountName if blank in CSV. */
  lookupKey: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  notes?: string;
  tiers: AccountTier[];
  /** Validation errors that mark the row as un-importable. */
  errors: string[];
};

// ── Public: parse a CSV string into ParsedAccountRow[] ────────────────────

export function parseLizAccountsCsv(csv: string): ParsedAccountRow[] {
  const grid = parseCsvGrid(csv);
  if (grid.length === 0) return [];

  const headerRow = grid[0].map((h) => h.trim().toLowerCase());
  const colIndex: Record<string, number> = {};
  headerRow.forEach((name, idx) => {
    if (name) colIndex[name] = idx;
  });

  const rows: ParsedAccountRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i];
    // Skip fully empty rows (common at end of file).
    if (cells.every((c) => c.trim() === "")) continue;

    const get = (col: string) => {
      const idx = colIndex[col];
      if (idx === undefined) return "";
      return (cells[idx] ?? "").trim();
    };

    const errors: string[] = [];
    const accountName = get("account_name");
    if (!accountName) {
      errors.push("Missing account_name");
    }

    const lookupKey =
      get("lookup_key") || (accountName ? slugifyAccountName(accountName) : "");
    if (!lookupKey) {
      errors.push("Couldn't derive lookup_key");
    }

    const tiers: AccountTier[] = [];
    for (const fam of FAMILY_COLUMNS) {
      const tierVal = get(`${fam.prefix}_tier`);
      const qtdRaw = get(`${fam.prefix}_qtd`);
      const qtrEnd = get(`${fam.prefix}_qtr_end`);
      if (!tierVal && !qtdRaw && !qtrEnd) continue;
      if (!tierVal) {
        errors.push(
          `${fam.label}: tier required when ${fam.prefix}_qtd or ${fam.prefix}_qtr_end is set`,
        );
        continue;
      }
      const tier: AccountTier = { family: fam.family, tier: tierVal };
      if (qtdRaw) {
        const n = Number(qtdRaw.replace(/[$,]/g, ""));
        if (Number.isFinite(n)) tier.qtd_volume = n;
        else errors.push(`${fam.label}: ${fam.prefix}_qtd is not a number`);
      }
      if (qtrEnd) tier.qtr_end = qtrEnd;
      tiers.push(tier);
    }

    rows.push({
      sourceRow: i + 1,
      accountName,
      lookupKey,
      contactName: get("contact_name") || undefined,
      contactEmail: get("contact_email") || undefined,
      contactPhone: get("contact_phone") || undefined,
      address: get("address") || undefined,
      notes: get("notes") || undefined,
      tiers,
      errors,
    });
  }
  return rows;
}

// ── Public: build the AccountAttachments JSON for a parsed row ────────────
// Used server-side; lives here so the shape is co-located with the parser.

export function buildAccountAttachments(row: ParsedAccountRow): AccountAttachments {
  const att: AccountAttachments = {};
  if (row.tiers.length) att.tiers = row.tiers;
  if (row.contactName) att.contact_name = row.contactName;
  if (row.contactEmail) att.contact_email = row.contactEmail;
  if (row.contactPhone) att.contact_phone = row.contactPhone;
  if (row.address) att.address = row.address;
  return att;
}

// ── Public: merge new tiers into existing tiers ───────────────────────────
// Preserves families absent from the new import (so a partial CSV that only
// touches Botox doesn't wipe the rep's Juvederm tier history). Replaces
// per-family entries that are present in `incoming`.

export function mergeTiers(
  existing: AccountTier[] | undefined,
  incoming: AccountTier[],
): AccountTier[] {
  if (!existing || existing.length === 0) return incoming;
  const incomingFamilies = new Set(incoming.map((t) => t.family));
  const kept = existing.filter((t) => !incomingFamilies.has(t.family));
  return [...kept, ...incoming];
}

// ── Public: build a friendly content blurb Liz can paraphrase ─────────────

export function buildAccountContent(row: ParsedAccountRow): string {
  const parts: string[] = [row.accountName];
  if (row.address) parts.push(`(${row.address})`);
  const out: string[] = [parts.join(" ")];
  if (row.contactName || row.contactEmail || row.contactPhone) {
    const c: string[] = [];
    if (row.contactName) c.push(row.contactName);
    const detail: string[] = [];
    if (row.contactEmail) detail.push(row.contactEmail);
    if (row.contactPhone) detail.push(row.contactPhone);
    if (detail.length) c.push(`(${detail.join(", ")})`);
    out.push(`Contact: ${c.join(" ")}`);
  }
  if (row.tiers.length) {
    const tierSummary = row.tiers
      .map((t) => `${t.tier} on ${familyLabel(t.family)}`)
      .join(", ");
    out.push(`Tiers: ${tierSummary}`);
  }
  if (row.notes) out.push(row.notes);
  return out.join(". ");
}

export function familyLabel(family: ProductFamily): string {
  const found = FAMILY_COLUMNS.find((f) => f.family === family);
  if (found) return found.label;
  // Fallback for unknown families (string & {} escape hatch).
  return String(family).split(".").pop() ?? String(family);
}

// ── Public: downloadable CSV template (header + one example row) ──────────

export function accountsCsvTemplate(): string {
  const header = [
    ...BASE_COLUMNS,
    ...FAMILY_COLUMNS.flatMap((f) => [
      `${f.prefix}_tier`,
      `${f.prefix}_qtd`,
      `${f.prefix}_qtr_end`,
    ]),
  ];
  // Example row showcases multi-dim tiers without overwhelming.
  const example: Record<string, string> = {
    account_name: "Rejuv Med Spa",
    lookup_key: "rejuv-med-spa",
    contact_name: "Karen Aslakson",
    contact_email: "karen@rejuvmedspa.com",
    contact_phone: "+1 555 123 0001",
    address: "San Diego, CA",
    notes: "Top account in territory; prefers Tuesday touchpoints.",
    botox_tier: "Silver",
    botox_qtd: "4200",
    botox_qtr_end: "2026-06-30",
    juvederm_tier: "Platinum",
    juvederm_qtd: "18500",
    juvederm_qtr_end: "2026-06-30",
    restylane_tier: "Gold",
    restylane_qtd: "9100",
    restylane_qtr_end: "2026-06-30",
  };
  const exampleRow = header.map((col) => csvEscape(example[col] ?? ""));
  return [header.map(csvEscape).join(","), exampleRow.join(",")].join("\n") + "\n";
}

// ── Public: slug + escape helpers ─────────────────────────────────────────

export function slugifyAccountName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

function csvEscape(s: string): string {
  if (s === "") return "";
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── Internal: RFC-4180-ish CSV grid parser ────────────────────────────────
// Handles: quoted fields, embedded commas inside quotes, escaped quotes
// (""), CR / LF / CRLF line endings, trailing newline. NOT a full RFC-4180
// implementation (no field-type coercion, no BOM stripping beyond utf-8) —
// good enough for spreadsheet exports.

export function parseCsvGrid(csv: string): string[][] {
  const text = csv.replace(/^﻿/, ""); // strip BOM if Excel added one
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") {
      // Defer to \n handler if CRLF, otherwise treat as line end.
      if (text[i + 1] === "\n") continue;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }

  // Flush last field/row if file didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
