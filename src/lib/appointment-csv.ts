/**
 * Appointment CSV importer with SMART dialect detection.
 *
 * Spas export their schedule from whatever PMS/CRM they use today and drop
 * the CSV here. Emma auto-detects which dialect it is by fingerprinting
 * the header row — no user pre-mapping required.
 *
 * v360 shipped with 6 hardcoded dialects. v367 expands to 20+ to cover
 * the med-spa + salon + wellness + telehealth long-tail and break the
 * "data migration" moat that locks owners into incumbent platforms.
 *
 * Detection cascade: most-specific signatures fire first (existing 6
 * dialects + the new ones with distinctive columns). Generic-shape
 * dialects use a shared config-driven parser. Anything unrecognized
 * falls through to the generic fuzzy matcher.
 *
 * Pure parser — no I/O, no Supabase, client + server safe. Same shape
 * as patient-csv.ts.
 */

import { parseCsvGrid } from "@/lib/csv-grid";

// ─── Public output shape ──────────────────────────────────────────────────

export type AppointmentDialect =
  // v360 dialects (kept as-is)
  | "csv-acuity"
  | "csv-boulevard"
  | "csv-mangomint"
  | "csv-vagaro"
  | "csv-aestheticspro"
  | "csv-aestheticrecord"
  // v367 expansion — distinctive-signature dialects
  | "csv-mindbody"
  | "csv-janeapp"
  | "csv-glossgenius"
  | "csv-zenoti"
  | "csv-square"
  | "csv-fresha"
  | "csv-wellnessliving"
  | "csv-simplepractice"
  | "csv-pabau"
  | "csv-calendly"
  | "csv-patientnow"
  | "csv-nextech"
  | "csv-symplast"
  | "csv-booker"
  | "csv-schedulicity"
  | "csv-moxie"
  | "csv-meevo"
  | "csv-repeatmd"
  // fallback
  | "csv-generic";

export type ParsedAppointment = {
  sourceRow: number;
  externalId: string | null;
  scheduledAt: string;
  durationMin: number;
  patientFirstName: string | null;
  patientLastName: string | null;
  patientPhone: string | null;
  patientEmail: string | null;
  treatmentType: string | null;
  providerName: string | null;
  status:
    | "scheduled"
    | "confirmed"
    | "cancelled"
    | "no_show"
    | "showed"
    | "rescheduled";
  notes: string | null;
};

export type ParsedAppointmentFile = {
  dialect: AppointmentDialect;
  dialectConfidence: "high" | "medium" | "low";
  appointments: ParsedAppointment[];
  warnings: ParseWarning[];
  headers: string[];
};

export type ParseWarning = {
  sourceRow: number;
  reason: string;
};

// ─── Dialect detection ────────────────────────────────────────────────────

/**
 * Fingerprint a CSV header row against known PMS exports.
 *
 * The cascade order matters — most-specific signatures fire first so a
 * platform with a uniquely-named column (e.g. Square's "Team Member",
 * GlossGenius's "Stylist") is never misclassified as a more generic
 * sibling. The "csv-generic" fallback catches anything unrecognized.
 */
export function detectAppointmentDialect(
  headers: string[],
): { dialect: AppointmentDialect; confidence: "high" | "medium" | "low" } {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const set = new Set(norm);

  // ── v360: Acuity — "Calendar" is the smoking gun (acts as provider).
  if (
    set.has("start time") &&
    set.has("calendar") &&
    (set.has("type") || set.has("appointment type"))
  ) {
    return { dialect: "csv-acuity", confidence: "high" };
  }

  // ── v360: Boulevard — "Appointment ID" + "Client" + "Provider"
  if (
    set.has("appointment id") &&
    set.has("client") &&
    set.has("provider") &&
    set.has("service")
  ) {
    return { dialect: "csv-boulevard", confidence: "high" };
  }

  // ── v367: Calendly — "Invitee" + "Event Type" is unmistakable
  if (
    (set.has("invitee name") || set.has("invitee")) &&
    (set.has("event type name") || set.has("event type") || set.has("event"))
  ) {
    return { dialect: "csv-calendly", confidence: "high" };
  }

  // ── v367: GlossGenius — "Stylist" is distinctive in med-spa/salon space
  if (set.has("stylist") && (set.has("client") || set.has("client name"))) {
    return { dialect: "csv-glossgenius", confidence: "high" };
  }

  // ── v367: Zenoti — "Guest Name" or "Therapist" is highly distinctive
  if (set.has("guest name") || (set.has("therapist") && set.has("service name"))) {
    return { dialect: "csv-zenoti", confidence: "high" };
  }

  // ── v367: Square — "Team Member" is unmistakable
  if (
    set.has("team member") &&
    (set.has("customer") || set.has("customer name"))
  ) {
    return { dialect: "csv-square", confidence: "high" };
  }

  // ── v367: SimplePractice — "Clinician" is unmistakable in telehealth
  if (
    set.has("clinician") &&
    (set.has("client") || set.has("client name") || set.has("date"))
  ) {
    return { dialect: "csv-simplepractice", confidence: "high" };
  }

  // ── v367: Pabau — "Staff Member" (UK-spelling) is distinctive
  if (
    set.has("staff member") &&
    (set.has("client name") || set.has("patient name"))
  ) {
    return { dialect: "csv-pabau", confidence: "high" };
  }

  // ── v367: JaneApp — "Practitioner" is distinctive in wellness/holistic
  if (
    set.has("practitioner") &&
    (set.has("patient") || set.has("client") || set.has("patient name"))
  ) {
    return { dialect: "csv-janeapp", confidence: "high" };
  }

  // ── v367: WellnessLiving — "Booking Date" + "Staff" combo
  if (
    set.has("booking date") &&
    set.has("staff") &&
    (set.has("service") || set.has("service name"))
  ) {
    return { dialect: "csv-wellnessliving", confidence: "high" };
  }

  // ── v367: Fresha — "Booking Date" + "Employee" combo (Employee ≠ Staff)
  if (
    set.has("booking date") &&
    set.has("employee") &&
    (set.has("client") || set.has("client name"))
  ) {
    return { dialect: "csv-fresha", confidence: "high" };
  }

  // ── v367: Mindbody — "Class Date" OR specific "Sale Date" + "Service Name"
  if (
    set.has("class date") ||
    (set.has("service name") &&
      set.has("staff name") &&
      (set.has("client first name") || set.has("client last name")))
  ) {
    return { dialect: "csv-mindbody", confidence: "high" };
  }

  // ── v367: Symplast — "Date of Service" + "Procedure" (med-spa EMR)
  if (
    set.has("procedure") &&
    (set.has("date of service") || set.has("service date")) &&
    (set.has("patient name") || set.has("patient"))
  ) {
    return { dialect: "csv-symplast", confidence: "high" };
  }

  // ── v367: Nextech — "Procedure" (without DOS — distinguishes from Symplast)
  if (
    set.has("procedure") &&
    set.has("provider") &&
    (set.has("patient") || set.has("patient name"))
  ) {
    return { dialect: "csv-nextech", confidence: "high" };
  }

  // ── v367: PatientNow — "Appointment Type" + "Patient" + "Provider"
  if (
    set.has("appointment type") &&
    set.has("provider") &&
    (set.has("patient") || set.has("patient name"))
  ) {
    return { dialect: "csv-patientnow", confidence: "high" };
  }

  // ── v367: RepeatMD — "Treatment" + "Patient Name" + "Provider"
  if (
    set.has("treatment") &&
    set.has("provider") &&
    set.has("patient name")
  ) {
    return { dialect: "csv-repeatmd", confidence: "high" };
  }

  // ── v367: Booker (Mindbody Booker) — "Customer" + "Employee" + "Service"
  if (
    set.has("customer") &&
    set.has("employee") &&
    (set.has("service") || set.has("service name"))
  ) {
    return { dialect: "csv-booker", confidence: "high" };
  }

  // ── v367: Moxie — "Treatment" + "Patient" + "Provider" (med-spa specific)
  if (
    set.has("treatment") &&
    set.has("patient") &&
    set.has("provider")
  ) {
    return { dialect: "csv-moxie", confidence: "high" };
  }

  // ── v367: Schedulicity — "Customer Name" + "Provider" + "Service"
  if (
    set.has("customer name") &&
    set.has("provider") &&
    set.has("service") &&
    !set.has("staff")
  ) {
    return { dialect: "csv-schedulicity", confidence: "high" };
  }

  // ── v367: Meevo — "Guest" + "Service" + "Service Provider"
  if (
    (set.has("guest") || set.has("guest name")) &&
    (set.has("service provider") || set.has("service"))
  ) {
    return { dialect: "csv-meevo", confidence: "high" };
  }

  // ── v360: Mangomint — "Client Name" + "Service" + "Provider" (no Appt ID)
  if (
    set.has("client name") &&
    set.has("service") &&
    set.has("provider") &&
    !set.has("appointment id")
  ) {
    return { dialect: "csv-mangomint", confidence: "high" };
  }

  // ── v360: Vagaro — "Customer Name" + "Staff" + date
  if (
    (set.has("customer name") || set.has("customer")) &&
    set.has("staff") &&
    (set.has("appointment date") || set.has("date"))
  ) {
    return { dialect: "csv-vagaro", confidence: "high" };
  }

  // ── v360: AestheticsPro — "Patient" + "Provider" + "Date of Service"
  if (
    set.has("patient") &&
    set.has("provider") &&
    (set.has("date of service") || set.has("service date"))
  ) {
    return { dialect: "csv-aestheticspro", confidence: "high" };
  }

  // ── v360: Aesthetic Record — "Patient Name" + "Service" + "Appointment Date"
  if (
    set.has("patient name") &&
    set.has("service") &&
    (set.has("appointment date") || set.has("scheduled date"))
  ) {
    return { dialect: "csv-aestheticrecord", confidence: "high" };
  }

  // Generic fallback, confidence based on how many appointment-ish columns appear.
  const appointmentHints = [
    "date",
    "time",
    "patient",
    "client",
    "customer",
    "guest",
    "invitee",
    "service",
    "treatment",
    "appointment",
    "booking",
    "provider",
    "staff",
    "stylist",
    "practitioner",
    "clinician",
    "therapist",
    "phone",
    "email",
  ];
  const hits = appointmentHints.filter((h) =>
    norm.some((n) => n.includes(h)),
  ).length;
  return {
    dialect: "csv-generic",
    confidence: hits >= 4 ? "medium" : "low",
  };
}

// ─── Top-level parser ─────────────────────────────────────────────────────

export function parseAppointmentCsv(csv: string): ParsedAppointmentFile {
  const grid = parseCsvGrid(csv).filter((row) =>
    row.some((cell) => cell.trim() !== ""),
  );
  if (grid.length === 0) {
    return {
      dialect: "csv-generic",
      dialectConfidence: "low",
      appointments: [],
      warnings: [{ sourceRow: 1, reason: "Empty CSV." }],
      headers: [],
    };
  }
  const headers = grid[0];
  const { dialect, confidence } = detectAppointmentDialect(headers);

  let appointments: ParsedAppointment[] = [];
  const warnings: ParseWarning[] = [];

  try {
    switch (dialect) {
      // v360 dialects — purpose-built parsers (unchanged)
      case "csv-acuity":
        appointments = parseAcuity(grid, warnings);
        break;
      case "csv-boulevard":
        appointments = parseBoulevard(grid, warnings);
        break;
      case "csv-mangomint":
        appointments = parseMangomint(grid, warnings);
        break;
      case "csv-vagaro":
        appointments = parseVagaro(grid, warnings);
        break;
      case "csv-aestheticspro":
        appointments = parseAestheticsPro(grid, warnings);
        break;
      case "csv-aestheticrecord":
        appointments = parseAestheticRecord(grid, warnings);
        break;
      // v367 dialects — all share parseByAliases with per-dialect column map
      case "csv-mindbody":
      case "csv-janeapp":
      case "csv-glossgenius":
      case "csv-zenoti":
      case "csv-square":
      case "csv-fresha":
      case "csv-wellnessliving":
      case "csv-simplepractice":
      case "csv-pabau":
      case "csv-calendly":
      case "csv-patientnow":
      case "csv-nextech":
      case "csv-symplast":
      case "csv-booker":
      case "csv-schedulicity":
      case "csv-moxie":
      case "csv-meevo":
      case "csv-repeatmd":
        appointments = parseByAliases(grid, DIALECT_ALIASES[dialect], warnings);
        break;
      default:
        appointments = parseGeneric(grid, warnings);
    }
  } catch (e) {
    warnings.push({
      sourceRow: 0,
      reason: `Parser threw: ${e instanceof Error ? e.message : "unknown"}`,
    });
  }

  return {
    dialect,
    dialectConfidence: confidence,
    appointments,
    warnings,
    headers,
  };
}

/**
 * Parse a CSV using a caller-provided alias map (the v368 LLM-mapper path).
 *
 * Lets the server-side mapper call the LLM once, validate the resulting
 * column → header mapping, and then run the same parseByAliases pipeline
 * the named dialects use. Same shape return as parseAppointmentCsv.
 */
export function parseAppointmentCsvWithAliases(
  csv: string,
  aliases: ColAliases,
): ParsedAppointmentFile {
  const grid = parseCsvGrid(csv).filter((row) =>
    row.some((cell) => cell.trim() !== ""),
  );
  if (grid.length === 0) {
    return {
      dialect: "csv-generic",
      dialectConfidence: "low",
      appointments: [],
      warnings: [{ sourceRow: 1, reason: "Empty CSV." }],
      headers: [],
    };
  }
  const warnings: ParseWarning[] = [];
  const appointments = parseByAliases(grid, aliases, warnings);
  return {
    dialect: "csv-generic",
    dialectConfidence: "high",
    appointments,
    warnings,
    headers: grid[0],
  };
}

// ─── Helpers (shared across dialects) ─────────────────────────────────────

function colIdx(headers: string[], ...names: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const i = lower.indexOf(name.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function takeStr(row: string[], idx: number): string | null {
  if (idx < 0 || idx >= row.length) return null;
  const v = row[idx]?.trim() ?? "";
  return v === "" ? null : v;
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 0) return null;
  return `+${digits}`;
}

function normalizeStatus(
  raw: string | null,
): ParsedAppointment["status"] | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (["scheduled", "booked", "new", "open", "pending"].includes(v))
    return "scheduled";
  if (["confirmed", "checked-in", "checked in", "arrived"].includes(v))
    return "confirmed";
  if (["cancelled", "canceled", "cancel", "voided"].includes(v))
    return "cancelled";
  if (["no_show", "no-show", "noshow", "no show", "missed"].includes(v))
    return "no_show";
  if (
    ["showed", "completed", "complete", "done", "fulfilled", "attended"].includes(v)
  )
    return "showed";
  if (["rescheduled", "reschedule", "rebooked"].includes(v))
    return "rescheduled";
  return null;
}

function combineDateTime(
  dateStr: string | null,
  timeStr: string | null,
): string | null {
  if (!dateStr) return null;
  const combined = timeStr ? `${dateStr} ${timeStr}` : dateStr;
  const d = new Date(combined);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseDuration(raw: string | null): number {
  if (!raw) return 30;
  const m = raw.match(/(\d+)/);
  if (!m) return 30;
  return Math.max(1, Math.min(600, parseInt(m[1], 10)));
}

// ─── Acuity parser ────────────────────────────────────────────────────────

function parseAcuity(
  grid: string[][],
  warnings: ParseWarning[],
): ParsedAppointment[] {
  const headers = grid[0];
  // v369.5: column names rewritten against a REAL Acuity export (Rejuv
  // Q1 2026, 573 rows). Findings vs v360 assumptions:
  //   - Acuity uses "Canceled" (American, single L), not "Cancelled?"
  //   - Values are literal strings ("canceled", "no-show"), not boolean
  //   - There is a separate "Date Rescheduled" column we were ignoring
  //   - Acuity has NO native "showed" column; we infer it from
  //     past-date + no-cancellation + no-reschedule
  //   - "Appointment ID" is a stable id (use as externalId for idempotent
  //     re-imports — v360 didn't capture this)
  const idx = {
    startTime: colIdx(headers, "Start time", "Start Time", "Start"),
    endTime: colIdx(headers, "End time", "End Time", "End"),
    firstName: colIdx(headers, "First name", "First Name"),
    lastName: colIdx(headers, "Last name", "Last Name"),
    phone: colIdx(headers, "Phone"),
    email: colIdx(headers, "Email"),
    type: colIdx(headers, "Type", "Appointment Type"),
    calendar: colIdx(headers, "Calendar"),
    notes: colIdx(headers, "Notes"),
    canceled: colIdx(headers, "Canceled", "Cancelled?", "Cancelled"),
    dateRescheduled: colIdx(headers, "Date Rescheduled"),
    appointmentId: colIdx(headers, "Appointment ID", "Appointment Id"),
  };

  const nowMs = Date.now();
  const out: ParsedAppointment[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (row.every((c) => c.trim() === "")) continue;

    const startRaw = takeStr(row, idx.startTime);
    if (!startRaw) {
      warnings.push({ sourceRow: i + 1, reason: "Missing start time" });
      continue;
    }
    const scheduledAt = combineDateTime(startRaw, null);
    if (!scheduledAt) {
      warnings.push({
        sourceRow: i + 1,
        reason: `Couldn't parse start time: ${startRaw}`,
      });
      continue;
    }

    let durationMin = 30;
    const endRaw = takeStr(row, idx.endTime);
    if (endRaw) {
      const end = new Date(endRaw);
      const start = new Date(scheduledAt);
      if (!isNaN(end.getTime()) && !isNaN(start.getTime())) {
        durationMin = Math.max(
          1,
          Math.round((end.getTime() - start.getTime()) / 60000),
        );
      }
    }

    // v369.5: status inference matches real Acuity export structure.
    // Priority order: cancellation/no-show beats reschedule beats
    // past-date-showed beats future-scheduled.
    const canceledVal = takeStr(row, idx.canceled);
    const rescheduledDate = takeStr(row, idx.dateRescheduled);
    const apptMs = new Date(scheduledAt).getTime();
    const isPast = !isNaN(apptMs) && apptMs < nowMs;

    let status: ParsedAppointment["status"];
    if (canceledVal) {
      const v = canceledVal.toLowerCase();
      if (/no.?show|no_show|missed/.test(v)) {
        status = "no_show";
      } else {
        // Any non-empty Canceled value (canceled / yes / true / 1 / etc.)
        // counts as a cancellation. Real Acuity uses literal "canceled".
        status = "cancelled";
      }
    } else if (rescheduledDate) {
      status = "rescheduled";
    } else if (isPast) {
      // Acuity doesn't track "showed" explicitly; past appointments that
      // weren't cancelled and weren't rescheduled were almost certainly
      // attended. Without this inference, the /scan math card has nothing
      // to compute against on real Acuity exports.
      status = "showed";
    } else {
      status = "scheduled";
    }

    out.push({
      sourceRow: i + 1,
      externalId: takeStr(row, idx.appointmentId),
      scheduledAt,
      durationMin,
      patientFirstName: takeStr(row, idx.firstName),
      patientLastName: takeStr(row, idx.lastName),
      patientPhone: normalizePhone(takeStr(row, idx.phone)),
      patientEmail: takeStr(row, idx.email)?.toLowerCase() ?? null,
      treatmentType: takeStr(row, idx.type),
      providerName: takeStr(row, idx.calendar),
      status,
      notes: takeStr(row, idx.notes),
    });
  }
  return out;
}

// ─── Boulevard parser ─────────────────────────────────────────────────────

function parseBoulevard(
  grid: string[][],
  warnings: ParseWarning[],
): ParsedAppointment[] {
  const headers = grid[0];
  const idx = {
    apptId: colIdx(headers, "Appointment ID", "Appointment Id"),
    date: colIdx(headers, "Date", "Appointment Date"),
    time: colIdx(headers, "Time", "Start Time"),
    duration: colIdx(headers, "Duration"),
    client: colIdx(headers, "Client", "Client Name"),
    phone: colIdx(headers, "Phone", "Client Phone"),
    email: colIdx(headers, "Email", "Client Email"),
    service: colIdx(headers, "Service"),
    provider: colIdx(headers, "Provider"),
    status: colIdx(headers, "Status"),
    notes: colIdx(headers, "Notes"),
  };

  const out: ParsedAppointment[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (row.every((c) => c.trim() === "")) continue;

    const date = takeStr(row, idx.date);
    const time = takeStr(row, idx.time);
    const scheduledAt = combineDateTime(date, time);
    if (!scheduledAt) {
      warnings.push({ sourceRow: i + 1, reason: "Missing/invalid date+time" });
      continue;
    }

    const [first, last] = splitFullName(takeStr(row, idx.client));
    const status = normalizeStatus(takeStr(row, idx.status)) ?? "scheduled";

    out.push({
      sourceRow: i + 1,
      externalId: takeStr(row, idx.apptId),
      scheduledAt,
      durationMin: parseDuration(takeStr(row, idx.duration)),
      patientFirstName: first,
      patientLastName: last,
      patientPhone: normalizePhone(takeStr(row, idx.phone)),
      patientEmail: takeStr(row, idx.email)?.toLowerCase() ?? null,
      treatmentType: takeStr(row, idx.service),
      providerName: takeStr(row, idx.provider),
      status,
      notes: takeStr(row, idx.notes),
    });
  }
  return out;
}

// ─── Mangomint parser ─────────────────────────────────────────────────────

function parseMangomint(
  grid: string[][],
  warnings: ParseWarning[],
): ParsedAppointment[] {
  const headers = grid[0];
  const idx = {
    date: colIdx(headers, "Date"),
    time: colIdx(headers, "Time", "Start Time"),
    duration: colIdx(headers, "Duration"),
    client: colIdx(headers, "Client Name", "Client"),
    phone: colIdx(headers, "Phone"),
    email: colIdx(headers, "Email"),
    service: colIdx(headers, "Service"),
    provider: colIdx(headers, "Provider", "Staff"),
    status: colIdx(headers, "Status"),
    notes: colIdx(headers, "Notes"),
  };

  const out: ParsedAppointment[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (row.every((c) => c.trim() === "")) continue;
    const scheduledAt = combineDateTime(
      takeStr(row, idx.date),
      takeStr(row, idx.time),
    );
    if (!scheduledAt) {
      warnings.push({ sourceRow: i + 1, reason: "Missing/invalid date+time" });
      continue;
    }
    const [first, last] = splitFullName(takeStr(row, idx.client));
    out.push({
      sourceRow: i + 1,
      externalId: null,
      scheduledAt,
      durationMin: parseDuration(takeStr(row, idx.duration)),
      patientFirstName: first,
      patientLastName: last,
      patientPhone: normalizePhone(takeStr(row, idx.phone)),
      patientEmail: takeStr(row, idx.email)?.toLowerCase() ?? null,
      treatmentType: takeStr(row, idx.service),
      providerName: takeStr(row, idx.provider),
      status: normalizeStatus(takeStr(row, idx.status)) ?? "scheduled",
      notes: takeStr(row, idx.notes),
    });
  }
  return out;
}

// ─── Vagaro parser ────────────────────────────────────────────────────────

function parseVagaro(
  grid: string[][],
  warnings: ParseWarning[],
): ParsedAppointment[] {
  const headers = grid[0];
  const idx = {
    date: colIdx(headers, "Appointment Date", "Date"),
    start: colIdx(headers, "Start", "Start Time"),
    end: colIdx(headers, "End", "End Time"),
    customer: colIdx(headers, "Customer Name", "Customer"),
    phone: colIdx(headers, "Phone", "Customer Phone"),
    email: colIdx(headers, "Email", "Customer Email"),
    service: colIdx(headers, "Service"),
    staff: colIdx(headers, "Staff"),
    status: colIdx(headers, "Status"),
    notes: colIdx(headers, "Notes"),
  };

  const out: ParsedAppointment[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (row.every((c) => c.trim() === "")) continue;
    const date = takeStr(row, idx.date);
    const start = takeStr(row, idx.start);
    const scheduledAt = combineDateTime(date, start);
    if (!scheduledAt) {
      warnings.push({ sourceRow: i + 1, reason: "Missing/invalid date+start" });
      continue;
    }
    let durationMin = 30;
    const end = takeStr(row, idx.end);
    if (start && end && date) {
      const s = new Date(`${date} ${start}`);
      const e = new Date(`${date} ${end}`);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
        durationMin = Math.max(1, Math.round((e.getTime() - s.getTime()) / 60000));
      }
    }
    const [first, last] = splitFullName(takeStr(row, idx.customer));
    out.push({
      sourceRow: i + 1,
      externalId: null,
      scheduledAt,
      durationMin,
      patientFirstName: first,
      patientLastName: last,
      patientPhone: normalizePhone(takeStr(row, idx.phone)),
      patientEmail: takeStr(row, idx.email)?.toLowerCase() ?? null,
      treatmentType: takeStr(row, idx.service),
      providerName: takeStr(row, idx.staff),
      status: normalizeStatus(takeStr(row, idx.status)) ?? "scheduled",
      notes: takeStr(row, idx.notes),
    });
  }
  return out;
}

// ─── AestheticsPro parser ─────────────────────────────────────────────────

function parseAestheticsPro(
  grid: string[][],
  warnings: ParseWarning[],
): ParsedAppointment[] {
  const headers = grid[0];
  const idx = {
    date: colIdx(headers, "Date of Service", "Service Date", "Date"),
    time: colIdx(headers, "Time", "Start Time"),
    duration: colIdx(headers, "Duration"),
    patient: colIdx(headers, "Patient", "Patient Name"),
    phone: colIdx(headers, "Phone"),
    email: colIdx(headers, "Email"),
    service: colIdx(headers, "Service", "Treatment"),
    provider: colIdx(headers, "Provider"),
    status: colIdx(headers, "Status"),
    notes: colIdx(headers, "Notes"),
  };

  const out: ParsedAppointment[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (row.every((c) => c.trim() === "")) continue;
    const scheduledAt = combineDateTime(
      takeStr(row, idx.date),
      takeStr(row, idx.time),
    );
    if (!scheduledAt) {
      warnings.push({ sourceRow: i + 1, reason: "Missing/invalid date+time" });
      continue;
    }
    const [first, last] = splitFullName(takeStr(row, idx.patient));
    out.push({
      sourceRow: i + 1,
      externalId: null,
      scheduledAt,
      durationMin: parseDuration(takeStr(row, idx.duration)),
      patientFirstName: first,
      patientLastName: last,
      patientPhone: normalizePhone(takeStr(row, idx.phone)),
      patientEmail: takeStr(row, idx.email)?.toLowerCase() ?? null,
      treatmentType: takeStr(row, idx.service),
      providerName: takeStr(row, idx.provider),
      status: normalizeStatus(takeStr(row, idx.status)) ?? "scheduled",
      notes: takeStr(row, idx.notes),
    });
  }
  return out;
}

// ─── Aesthetic Record parser ──────────────────────────────────────────────

function parseAestheticRecord(
  grid: string[][],
  warnings: ParseWarning[],
): ParsedAppointment[] {
  const headers = grid[0];
  const idx = {
    date: colIdx(headers, "Appointment Date", "Scheduled Date", "Date"),
    time: colIdx(headers, "Time", "Start Time"),
    duration: colIdx(headers, "Duration"),
    patient: colIdx(headers, "Patient Name", "Patient"),
    phone: colIdx(headers, "Phone"),
    email: colIdx(headers, "Email"),
    service: colIdx(headers, "Service"),
    provider: colIdx(headers, "Provider"),
    status: colIdx(headers, "Status"),
    notes: colIdx(headers, "Notes"),
  };

  const out: ParsedAppointment[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (row.every((c) => c.trim() === "")) continue;
    const scheduledAt = combineDateTime(
      takeStr(row, idx.date),
      takeStr(row, idx.time),
    );
    if (!scheduledAt) {
      warnings.push({ sourceRow: i + 1, reason: "Missing/invalid date+time" });
      continue;
    }
    const [first, last] = splitFullName(takeStr(row, idx.patient));
    out.push({
      sourceRow: i + 1,
      externalId: null,
      scheduledAt,
      durationMin: parseDuration(takeStr(row, idx.duration)),
      patientFirstName: first,
      patientLastName: last,
      patientPhone: normalizePhone(takeStr(row, idx.phone)),
      patientEmail: takeStr(row, idx.email)?.toLowerCase() ?? null,
      treatmentType: takeStr(row, idx.service),
      providerName: takeStr(row, idx.provider),
      status: normalizeStatus(takeStr(row, idx.status)) ?? "scheduled",
      notes: takeStr(row, idx.notes),
    });
  }
  return out;
}

// ─── v367 dialect alias map + shared parser ───────────────────────────────

/**
 * Column-name aliases per v367 dialect. Each field is an ordered list of
 * acceptable header names (case-insensitive — colIdx already lowercases).
 * First match wins. Order from most-specific to most-generic.
 *
 * Adding a new dialect: add an enum value, add a detection branch in
 * detectAppointmentDialect, add a case in the switch in parseAppointmentCsv,
 * add a label in dialectLabel, and add an entry here. That's it.
 */
export type ColAliases = {
  externalId?: string[];
  dateTime?: string[];
  date?: string[];
  time?: string[];
  startTime?: string[];
  endTime?: string[];
  duration?: string[];
  firstName?: string[];
  lastName?: string[];
  fullName?: string[];
  phone?: string[];
  email?: string[];
  service?: string[];
  provider?: string[];
  status?: string[];
  notes?: string[];
  cancelled?: string[];
};

const DIALECT_ALIASES: Record<
  Exclude<
    AppointmentDialect,
    | "csv-acuity"
    | "csv-boulevard"
    | "csv-mangomint"
    | "csv-vagaro"
    | "csv-aestheticspro"
    | "csv-aestheticrecord"
    | "csv-generic"
  >,
  ColAliases
> = {
  "csv-mindbody": {
    externalId: ["Visit ID", "Appointment ID"],
    date: ["Class Date", "Appointment Date", "Sale Date", "Date"],
    time: ["Start Time", "Time"],
    duration: ["Duration"],
    firstName: ["Client First Name", "First Name"],
    lastName: ["Client Last Name", "Last Name"],
    fullName: ["Client Name", "Client"],
    phone: ["Client Phone", "Phone"],
    email: ["Client Email", "Email"],
    service: ["Service Name", "Class Name", "Service"],
    provider: ["Staff Name", "Staff", "Instructor"],
    status: ["Booking Status", "Status"],
    notes: ["Notes"],
  },
  "csv-janeapp": {
    date: ["Appointment Date", "Date"],
    time: ["Time", "Start Time", "Appointment Time"],
    duration: ["Duration", "Length"],
    fullName: ["Patient Name", "Patient", "Client Name", "Client"],
    phone: ["Phone", "Mobile", "Mobile Phone"],
    email: ["Email"],
    service: ["Treatment", "Appointment Type", "Service"],
    provider: ["Practitioner", "Provider"],
    status: ["Status"],
    notes: ["Notes"],
  },
  "csv-glossgenius": {
    date: ["Appointment Date", "Date"],
    time: ["Start Time", "Time"],
    endTime: ["End Time"],
    fullName: ["Client Name", "Client"],
    phone: ["Phone", "Client Phone"],
    email: ["Email", "Client Email"],
    service: ["Service", "Service Name"],
    provider: ["Stylist", "Service Provider"],
    status: ["Status"],
    notes: ["Notes"],
  },
  "csv-zenoti": {
    externalId: ["Invoice No", "Appointment ID"],
    date: ["Appointment Date", "Service Date", "Date"],
    time: ["Start Time", "Time"],
    duration: ["Duration"],
    fullName: ["Guest Name", "Guest", "Client Name"],
    phone: ["Guest Phone", "Phone", "Mobile"],
    email: ["Guest Email", "Email"],
    service: ["Service Name", "Service"],
    provider: ["Therapist", "Service Provider", "Staff"],
    status: ["Appointment Status", "Status"],
    notes: ["Notes", "Comments"],
  },
  "csv-square": {
    externalId: ["Appointment ID", "Booking ID"],
    dateTime: ["Appointment At"],
    date: ["Appointment Date", "Date"],
    time: ["Appointment Time", "Time", "Start Time"],
    duration: ["Duration"],
    fullName: ["Customer Name", "Customer"],
    phone: ["Customer Phone", "Phone"],
    email: ["Customer Email", "Email"],
    service: ["Service Name", "Service", "Item"],
    provider: ["Team Member", "Team Member Name"],
    status: ["Status", "Appointment Status"],
    notes: ["Notes", "Customer Notes"],
  },
  "csv-fresha": {
    externalId: ["Appointment Reference", "Reference"],
    date: ["Booking Date", "Appointment Date", "Date"],
    time: ["Booking Time", "Time", "Start Time"],
    duration: ["Duration"],
    fullName: ["Client Name", "Client"],
    phone: ["Client Phone", "Phone", "Mobile"],
    email: ["Client Email", "Email"],
    service: ["Service", "Service Name"],
    provider: ["Employee", "Team Member"],
    status: ["Booking Status", "Status"],
    notes: ["Notes"],
  },
  "csv-wellnessliving": {
    date: ["Booking Date", "Appointment Date", "Date"],
    time: ["Booking Time", "Time", "Start Time"],
    duration: ["Duration"],
    fullName: ["Client Name", "Client"],
    phone: ["Phone", "Mobile"],
    email: ["Email"],
    service: ["Service", "Service Name"],
    provider: ["Staff", "Staff Name"],
    status: ["Booking Status", "Status"],
    notes: ["Notes"],
  },
  "csv-simplepractice": {
    date: ["Date", "Appointment Date"],
    time: ["Start Time", "Time"],
    endTime: ["End Time"],
    duration: ["Duration"],
    fullName: ["Client", "Client Name", "Patient Name"],
    phone: ["Phone", "Mobile Phone"],
    email: ["Email"],
    service: ["Service", "Service Type", "Appointment Type"],
    provider: ["Clinician", "Provider"],
    status: ["Status"],
    notes: ["Notes"],
  },
  "csv-pabau": {
    externalId: ["Booking ID", "Appointment ID"],
    date: ["Date", "Appointment Date"],
    time: ["Time", "Start Time"],
    duration: ["Duration"],
    fullName: ["Client Name", "Patient Name", "Client"],
    phone: ["Mobile", "Phone"],
    email: ["Email"],
    service: ["Service", "Treatment"],
    provider: ["Staff Member", "Practitioner"],
    status: ["Status"],
    notes: ["Notes"],
  },
  "csv-calendly": {
    externalId: ["Event UUID", "Invitee UUID"],
    dateTime: ["Event Start Time", "Start Date & Time"],
    endTime: ["Event End Time"],
    fullName: ["Invitee Name", "Invitee"],
    phone: ["Text Reminder Number", "Phone Number", "Phone"],
    email: ["Invitee Email", "Email"],
    service: ["Event Type Name", "Event Type", "Event"],
    provider: ["Host Name", "Event Host"],
    status: ["Status"],
    notes: ["Notes", "Response 1"],
  },
  "csv-patientnow": {
    externalId: ["Appointment ID"],
    date: ["Appointment Date", "Date"],
    time: ["Appointment Time", "Time"],
    duration: ["Duration"],
    fullName: ["Patient Name", "Patient"],
    phone: ["Phone", "Mobile Phone", "Cell Phone"],
    email: ["Email"],
    service: ["Appointment Type", "Service", "Treatment"],
    provider: ["Provider", "Physician"],
    status: ["Status"],
    notes: ["Notes"],
  },
  "csv-nextech": {
    externalId: ["Appointment ID", "Encounter ID"],
    date: ["Appointment Date", "Date"],
    time: ["Appointment Time", "Time"],
    duration: ["Duration"],
    fullName: ["Patient Name", "Patient"],
    phone: ["Phone", "Mobile Phone"],
    email: ["Email"],
    service: ["Procedure", "Procedure Name", "Service"],
    provider: ["Provider", "Physician"],
    status: ["Status"],
    notes: ["Notes", "Comments"],
  },
  "csv-symplast": {
    externalId: ["Appointment ID", "Visit ID"],
    date: ["Date of Service", "Service Date", "Appointment Date"],
    time: ["Time", "Start Time"],
    duration: ["Duration"],
    fullName: ["Patient Name", "Patient"],
    phone: ["Phone", "Mobile"],
    email: ["Email"],
    service: ["Procedure", "Procedure Name", "Service"],
    provider: ["Provider", "Physician"],
    status: ["Status", "Appointment Status"],
    notes: ["Notes"],
  },
  "csv-booker": {
    externalId: ["Appointment ID", "Booking ID"],
    date: ["Date", "Appointment Date"],
    time: ["Start Time", "Time"],
    duration: ["Duration"],
    fullName: ["Customer", "Customer Name"],
    phone: ["Phone", "Customer Phone"],
    email: ["Email", "Customer Email"],
    service: ["Service", "Service Name"],
    provider: ["Employee", "Employee Name"],
    status: ["Status"],
    notes: ["Notes"],
  },
  "csv-schedulicity": {
    date: ["Appointment Date", "Date"],
    time: ["Appointment Time", "Start Time", "Time"],
    duration: ["Duration"],
    fullName: ["Customer Name", "Customer", "Client Name"],
    phone: ["Phone", "Mobile"],
    email: ["Email"],
    service: ["Service", "Service Name"],
    provider: ["Provider", "Service Provider"],
    status: ["Status"],
    notes: ["Notes"],
  },
  "csv-moxie": {
    externalId: ["Appointment ID"],
    date: ["Appointment Date", "Date"],
    time: ["Start Time", "Time"],
    duration: ["Duration"],
    fullName: ["Patient", "Patient Name"],
    phone: ["Phone", "Mobile"],
    email: ["Email"],
    service: ["Treatment", "Service"],
    provider: ["Provider", "Injector"],
    status: ["Status"],
    notes: ["Notes"],
  },
  "csv-meevo": {
    externalId: ["Appointment ID", "Visit ID"],
    date: ["Appointment Date", "Date"],
    time: ["Start Time", "Time"],
    duration: ["Duration"],
    fullName: ["Guest Name", "Guest", "Client"],
    phone: ["Mobile", "Phone"],
    email: ["Email"],
    service: ["Service Name", "Service"],
    provider: ["Service Provider", "Staff"],
    status: ["Status"],
    notes: ["Notes"],
  },
  "csv-repeatmd": {
    externalId: ["Booking ID", "Appointment ID"],
    date: ["Booking Date", "Appointment Date", "Date"],
    time: ["Booking Time", "Start Time", "Time"],
    duration: ["Duration"],
    fullName: ["Patient Name", "Patient", "Client"],
    phone: ["Phone", "Mobile"],
    email: ["Email"],
    service: ["Treatment", "Service", "Treatment Name"],
    provider: ["Provider", "Injector"],
    status: ["Status"],
    notes: ["Notes"],
  },
};

export function parseByAliases(
  grid: string[][],
  aliases: ColAliases,
  warnings: ParseWarning[],
): ParsedAppointment[] {
  const headers = grid[0];
  const idx = {
    externalId: aliases.externalId ? colIdx(headers, ...aliases.externalId) : -1,
    dateTime: aliases.dateTime ? colIdx(headers, ...aliases.dateTime) : -1,
    date: aliases.date ? colIdx(headers, ...aliases.date) : -1,
    time: aliases.time ? colIdx(headers, ...aliases.time) : -1,
    startTime: aliases.startTime ? colIdx(headers, ...aliases.startTime) : -1,
    endTime: aliases.endTime ? colIdx(headers, ...aliases.endTime) : -1,
    duration: aliases.duration ? colIdx(headers, ...aliases.duration) : -1,
    firstName: aliases.firstName ? colIdx(headers, ...aliases.firstName) : -1,
    lastName: aliases.lastName ? colIdx(headers, ...aliases.lastName) : -1,
    fullName: aliases.fullName ? colIdx(headers, ...aliases.fullName) : -1,
    phone: aliases.phone ? colIdx(headers, ...aliases.phone) : -1,
    email: aliases.email ? colIdx(headers, ...aliases.email) : -1,
    service: aliases.service ? colIdx(headers, ...aliases.service) : -1,
    provider: aliases.provider ? colIdx(headers, ...aliases.provider) : -1,
    status: aliases.status ? colIdx(headers, ...aliases.status) : -1,
    notes: aliases.notes ? colIdx(headers, ...aliases.notes) : -1,
    cancelled: aliases.cancelled ? colIdx(headers, ...aliases.cancelled) : -1,
  };

  const out: ParsedAppointment[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (row.every((c) => c.trim() === "")) continue;

    let scheduledAt: string | null = null;
    if (idx.dateTime >= 0) {
      scheduledAt = combineDateTime(takeStr(row, idx.dateTime), null);
    } else {
      const date = takeStr(row, idx.date);
      const time =
        idx.time >= 0 ? takeStr(row, idx.time) : takeStr(row, idx.startTime);
      scheduledAt = combineDateTime(date, time);
    }
    if (!scheduledAt) {
      warnings.push({ sourceRow: i + 1, reason: "Missing/invalid date+time" });
      continue;
    }

    let durationMin = parseDuration(takeStr(row, idx.duration));
    if (idx.startTime >= 0 && idx.endTime >= 0) {
      const date = takeStr(row, idx.date);
      const start = takeStr(row, idx.startTime);
      const end = takeStr(row, idx.endTime);
      if (start && end) {
        const sStr = date ? `${date} ${start}` : start;
        const eStr = date ? `${date} ${end}` : end;
        const s = new Date(sStr);
        const e = new Date(eStr);
        if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e > s) {
          durationMin = Math.max(
            1,
            Math.round((e.getTime() - s.getTime()) / 60000),
          );
        }
      }
    }

    let first: string | null = null;
    let last: string | null = null;
    if (idx.firstName >= 0 || idx.lastName >= 0) {
      first = takeStr(row, idx.firstName);
      last = takeStr(row, idx.lastName);
      if (!first && !last) {
        [first, last] = splitFullName(takeStr(row, idx.fullName));
      }
    } else {
      [first, last] = splitFullName(takeStr(row, idx.fullName));
    }

    let status = normalizeStatus(takeStr(row, idx.status)) ?? "scheduled";
    if (idx.cancelled >= 0) {
      const cancelled = takeStr(row, idx.cancelled);
      if (cancelled && /yes|true|1/i.test(cancelled)) status = "cancelled";
    }

    out.push({
      sourceRow: i + 1,
      externalId: takeStr(row, idx.externalId),
      scheduledAt,
      durationMin,
      patientFirstName: first,
      patientLastName: last,
      patientPhone: normalizePhone(takeStr(row, idx.phone)),
      patientEmail: takeStr(row, idx.email)?.toLowerCase() ?? null,
      treatmentType: takeStr(row, idx.service),
      providerName: takeStr(row, idx.provider),
      status,
      notes: takeStr(row, idx.notes),
    });
  }
  return out;
}

// ─── Generic fallback parser ──────────────────────────────────────────────

function parseGeneric(
  grid: string[][],
  warnings: ParseWarning[],
): ParsedAppointment[] {
  const headers = grid[0];
  const find = (...patterns: RegExp[]): number => {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      if (patterns.some((p) => p.test(h))) return i;
    }
    return -1;
  };

  const idx = {
    dateTime: find(/^(?:start.?time|date.?time|appointment.?time|event.?start)$/),
    date: find(/^(?:appointment.?|booking.?)?date$/, /service.?date/),
    time: find(/^(?:start.?|booking.?)?time$/),
    duration: find(/duration|length/),
    firstName: find(/first.?name/),
    lastName: find(/last.?name/),
    fullName: find(
      /(?:patient|client|customer|guest|invitee).?name/,
      /^(?:patient|client|customer|guest|invitee)$/,
    ),
    phone: find(/phone|mobile|cell/),
    email: find(/email/),
    service: find(/service|treatment|procedure|appointment.?type|event.?type/),
    provider: find(
      /provider|staff|injector|practitioner|stylist|clinician|therapist|employee|physician|team.?member/,
    ),
    status: find(/status/),
    notes: find(/notes|comments/),
  };

  const out: ParsedAppointment[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (row.every((c) => c.trim() === "")) continue;
    let scheduledAt: string | null = null;
    if (idx.dateTime >= 0) {
      scheduledAt = combineDateTime(takeStr(row, idx.dateTime), null);
    } else {
      scheduledAt = combineDateTime(
        takeStr(row, idx.date),
        takeStr(row, idx.time),
      );
    }
    if (!scheduledAt) {
      warnings.push({ sourceRow: i + 1, reason: "Couldn't parse date/time" });
      continue;
    }
    let first: string | null = null;
    let last: string | null = null;
    if (idx.firstName >= 0 || idx.lastName >= 0) {
      first = takeStr(row, idx.firstName);
      last = takeStr(row, idx.lastName);
    } else {
      [first, last] = splitFullName(takeStr(row, idx.fullName));
    }
    out.push({
      sourceRow: i + 1,
      externalId: null,
      scheduledAt,
      durationMin: parseDuration(takeStr(row, idx.duration)),
      patientFirstName: first,
      patientLastName: last,
      patientPhone: normalizePhone(takeStr(row, idx.phone)),
      patientEmail: takeStr(row, idx.email)?.toLowerCase() ?? null,
      treatmentType: takeStr(row, idx.service),
      providerName: takeStr(row, idx.provider),
      status: normalizeStatus(takeStr(row, idx.status)) ?? "scheduled",
      notes: takeStr(row, idx.notes),
    });
  }
  return out;
}

// ─── Name splitter ────────────────────────────────────────────────────────

function splitFullName(name: string | null): [string | null, string | null] {
  if (!name) return [null, null];
  const trimmed = name.trim();
  if (trimmed === "") return [null, null];
  if (trimmed.includes(",")) {
    const [last, first] = trimmed.split(",", 2).map((s) => s.trim());
    return [first || null, last || null];
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return [parts[0], null];
  return [parts.slice(0, -1).join(" "), parts[parts.length - 1]];
}

// ─── Display label for the dialect ────────────────────────────────────────

export function dialectLabel(d: AppointmentDialect): string {
  switch (d) {
    case "csv-acuity":
      return "Acuity";
    case "csv-boulevard":
      return "Boulevard";
    case "csv-mangomint":
      return "Mangomint";
    case "csv-vagaro":
      return "Vagaro";
    case "csv-aestheticspro":
      return "AestheticsPro";
    case "csv-aestheticrecord":
      return "Aesthetic Record";
    case "csv-mindbody":
      return "Mindbody";
    case "csv-janeapp":
      return "Jane";
    case "csv-glossgenius":
      return "GlossGenius";
    case "csv-zenoti":
      return "Zenoti";
    case "csv-square":
      return "Square";
    case "csv-fresha":
      return "Fresha";
    case "csv-wellnessliving":
      return "WellnessLiving";
    case "csv-simplepractice":
      return "SimplePractice";
    case "csv-pabau":
      return "Pabau";
    case "csv-calendly":
      return "Calendly";
    case "csv-patientnow":
      return "PatientNow";
    case "csv-nextech":
      return "Nextech";
    case "csv-symplast":
      return "Symplast";
    case "csv-booker":
      return "Booker";
    case "csv-schedulicity":
      return "Schedulicity";
    case "csv-moxie":
      return "Moxie";
    case "csv-meevo":
      return "Meevo";
    case "csv-repeatmd":
      return "RepeatMD";
    case "csv-generic":
      return "Generic CSV";
  }
}

/**
 * Full list of supported PMS / CRM / scheduling platforms, ordered roughly
 * by med-spa popularity. Used by the upload page to render the "supports
 * 20+ platforms" list and by future onboarding tooltips.
 */
export const SUPPORTED_PLATFORMS: { dialect: AppointmentDialect; label: string }[] = [
  { dialect: "csv-acuity", label: "Acuity" },
  { dialect: "csv-boulevard", label: "Boulevard" },
  { dialect: "csv-mangomint", label: "Mangomint" },
  { dialect: "csv-vagaro", label: "Vagaro" },
  { dialect: "csv-mindbody", label: "Mindbody" },
  { dialect: "csv-janeapp", label: "Jane (JaneApp)" },
  { dialect: "csv-wellnessliving", label: "WellnessLiving" },
  { dialect: "csv-glossgenius", label: "GlossGenius" },
  { dialect: "csv-fresha", label: "Fresha" },
  { dialect: "csv-square", label: "Square Appointments" },
  { dialect: "csv-zenoti", label: "Zenoti" },
  { dialect: "csv-aestheticspro", label: "AestheticsPro" },
  { dialect: "csv-aestheticrecord", label: "Aesthetic Record" },
  { dialect: "csv-booker", label: "Booker" },
  { dialect: "csv-schedulicity", label: "Schedulicity" },
  { dialect: "csv-moxie", label: "Moxie" },
  { dialect: "csv-meevo", label: "Meevo" },
  { dialect: "csv-patientnow", label: "PatientNow" },
  { dialect: "csv-nextech", label: "Nextech" },
  { dialect: "csv-symplast", label: "Symplast" },
  { dialect: "csv-pabau", label: "Pabau" },
  { dialect: "csv-simplepractice", label: "SimplePractice" },
  { dialect: "csv-repeatmd", label: "RepeatMD" },
  { dialect: "csv-calendly", label: "Calendly" },
];
