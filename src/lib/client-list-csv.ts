/**
 * Client-list CSV parser — Patient Architecture P1.5.
 *
 * Wide-format CSV exported from the spa's scheduling software. Header row:
 *   "First Name","Last Name","Phone","Email","Notes",
 *   "Days Since Last Appointment","Banned"
 *
 * The 1,504-row Rejuv export had three phone formats and a handful of junk
 * rows (calendar reminders typed into the name fields). Junk rows fall out
 * naturally — we keep them in the candidates table flagged with status
 * 'unmatched' so the spa owner can dismiss them in the contacts page.
 *
 * Pure helpers — no I/O, no Supabase. Phone is normalized to E.164
 * (+1XXXXXXXXXX). Email is lower-cased + regex-validated; invalid emails
 * are stored as null with a warning.
 *
 * Established 2026-05-15 (Patient Architecture P1.5).
 */

import { parseCsvGrid } from "@/lib/liz-csv";
import { normalizeName } from "@/lib/patient-csv";

// ─── Public output shape ──────────────────────────────────────────────────

export type ParsedClientRow = {
  /** 1-based source row number for traceability. */
  sourceRow: number;
  firstName: string | null;
  lastName: string | null;
  /** "Last, First" canonical display string. Falls back to whichever piece
   *  is present; if both are blank the row is dropped with a warning. */
  displayName: string;
  /** Canonical lookup key — same rule as patient_csv normalizeName. */
  normalizedName: string;
  /** E.164 normalized; null when blank or unparseable. */
  phone: string | null;
  /** As-captured for audit. */
  phoneRaw: string | null;
  /** Lowercased + regex-validated; null when blank or invalid. */
  email: string | null;
  notes: string | null;
  daysSinceLastAppointment: number | null;
  banned: boolean;
};

export type ClientParseWarning = {
  sourceRow: number;
  message: string;
};

export type ParsedClientFile = {
  rows: ParsedClientRow[];
  warnings: ClientParseWarning[];
  totals: {
    rowsTotal: number;
    withPhone: number;
    withEmail: number;
    banned: number;
    dropped: number;
  };
};

// ─── Phone normalization ──────────────────────────────────────────────────

/**
 * Best-effort E.164 normalizer for US/CA numbers. The Rejuv list has three
 * formats: "+17203397829", "(303) 641-4021", and raw 10-digit. Everything
 * else returns null — we'd rather store nothing than store a wrong number.
 * The original captured form is preserved on phone_raw for audit.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^'/, ""); // strip leading apostrophe (Excel escape)
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

// ─── Email validation ─────────────────────────────────────────────────────

// Pragmatic — enough to catch typos, not RFC-5322-strict. Matches what the
// rest of the codebase uses (see kb-ingest.functions.ts).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  return EMAIL_RE.test(v) ? v : null;
}

// ─── Display-name canonicalization ────────────────────────────────────────

function buildDisplayName(
  firstName: string | null,
  lastName: string | null,
): string {
  const f = firstName?.trim() ?? "";
  const l = lastName?.trim() ?? "";
  if (l && f) return `${l}, ${f}`;
  if (l) return l;
  if (f) return f;
  return "";
}

// ─── Public entry point ───────────────────────────────────────────────────

export function parseClientListCsv(csv: string): ParsedClientFile {
  const grid = parseCsvGrid(csv);
  const warnings: ClientParseWarning[] = [];
  const rows: ParsedClientRow[] = [];
  let dropped = 0;

  if (grid.length < 2) {
    return {
      rows: [],
      warnings: [{ sourceRow: 0, message: "Empty CSV." }],
      totals: { rowsTotal: 0, withPhone: 0, withEmail: 0, banned: 0, dropped: 0 },
    };
  }

  // The header row drives column resolution — tolerate column-order shuffle
  // because some spas customize their scheduling-software exports.
  const header = grid[0].map((h) => h.trim().toLowerCase());
  const col = (...candidates: string[]): number => {
    for (const c of candidates) {
      const idx = header.indexOf(c);
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const firstIdx = col("first name", "first");
  const lastIdx = col("last name", "last");
  const phoneIdx = col("phone", "mobile", "cell");
  const emailIdx = col("email", "e-mail");
  const notesIdx = col("notes", "note", "comment");
  const daysIdx = col(
    "days since last appointment",
    "days since last appt",
    "days_since_last_appointment",
  );
  const bannedIdx = col("banned", "is_banned");

  if (firstIdx < 0 && lastIdx < 0) {
    return {
      rows: [],
      warnings: [
        {
          sourceRow: 1,
          message: "Couldn't find First Name / Last Name columns in the header.",
        },
      ],
      totals: { rowsTotal: 0, withPhone: 0, withEmail: 0, banned: 0, dropped: 0 },
    };
  }

  const seenKeys = new Set<string>();
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i];
    if (cells.every((c) => !c || c.trim() === "")) continue;
    const sourceRow = i + 1;

    const firstName = firstIdx >= 0 ? (cells[firstIdx]?.trim() || null) : null;
    const lastName = lastIdx >= 0 ? (cells[lastIdx]?.trim() || null) : null;
    const displayName = buildDisplayName(firstName, lastName);

    if (!displayName) {
      warnings.push({
        sourceRow,
        message: "Row has neither first nor last name — dropped.",
      });
      dropped++;
      continue;
    }

    const normalized = normalizeName(displayName);
    if (!normalized) {
      warnings.push({
        sourceRow,
        message: `Couldn't normalize "${displayName}" — dropped.`,
      });
      dropped++;
      continue;
    }

    // Within-file deduplication: client list export had a handful of duplicate
    // rows (3 dups in Rejuv's). Keep the first; flag the others.
    if (seenKeys.has(normalized)) {
      warnings.push({
        sourceRow,
        message: `Duplicate of an earlier row for "${displayName}" — skipped.`,
      });
      continue;
    }
    seenKeys.add(normalized);

    const phoneRaw = phoneIdx >= 0 ? (cells[phoneIdx]?.trim() || null) : null;
    const phone = normalizePhoneE164(phoneRaw);
    const emailRaw = emailIdx >= 0 ? (cells[emailIdx]?.trim() || null) : null;
    const email = normalizeEmail(emailRaw);
    if (emailRaw && !email) {
      warnings.push({
        sourceRow,
        message: `Couldn't validate email "${emailRaw}" — stored as blank.`,
      });
    }
    if (phoneRaw && !phone) {
      warnings.push({
        sourceRow,
        message: `Couldn't normalize phone "${phoneRaw}" — stored as blank.`,
      });
    }

    let daysSince: number | null = null;
    if (daysIdx >= 0) {
      const v = (cells[daysIdx] ?? "").trim();
      if (v) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) daysSince = Math.round(n);
      }
    }

    const banned =
      bannedIdx >= 0 &&
      ((cells[bannedIdx] ?? "").trim().toLowerCase() === "y" ||
        (cells[bannedIdx] ?? "").trim().toLowerCase() === "yes" ||
        (cells[bannedIdx] ?? "").trim().toLowerCase() === "true");

    const notes = notesIdx >= 0 ? (cells[notesIdx]?.trim() || null) : null;

    rows.push({
      sourceRow,
      firstName,
      lastName,
      displayName,
      normalizedName: normalized,
      phone,
      phoneRaw,
      email,
      notes,
      daysSinceLastAppointment: daysSince,
      banned,
    });
  }

  const withPhone = rows.filter((r) => r.phone).length;
  const withEmail = rows.filter((r) => r.email).length;
  const bannedCount = rows.filter((r) => r.banned).length;

  return {
    rows,
    warnings,
    totals: {
      rowsTotal: rows.length,
      withPhone,
      withEmail,
      banned: bannedCount,
      dropped,
    },
  };
}
