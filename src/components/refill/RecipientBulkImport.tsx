/**
 * RecipientBulkImport — paste-or-upload a recipient list into the outreach
 * composer roster (v1.47.0 P4).
 *
 * Mirrors the structure of TemplateBulkImport (paste / upload tabs) but for
 * RECIPIENTS, not templates. Parses CSV (comma) via parseCsvGrid and pasted
 * spreadsheet blocks (tab-delimited) natively. Smart column auto-detect maps
 * email / first name / spa name in any order with a forgiving alias map, and
 * the rep can re-map any column via dropdowns. Bad emails are flagged (never
 * silently dropped); duplicates within the paste are merged. On import the
 * valid rows go to saveOutreachDraftsBulk (on-conflict-do-nothing).
 */
import { useMemo, useState } from "react";
import { FileUp, Upload, X } from "lucide-react";

import { parseCsvGrid } from "@/lib/csv-grid";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ImportRecipient = {
  email: string;
  firstName?: string;
  spaName?: string;
};

type Mode = "paste" | "upload";

const EMAIL_ALIASES = [
  "email",
  "e-mail",
  "emailaddress",
  "email address",
  "recipient email",
  "mail",
];
const FIRST_ALIASES = [
  "first name",
  "firstname",
  "first",
  "name",
  "contact",
  "contact name",
  "recipient",
  "owner",
];
const SPA_ALIASES = [
  "spa name",
  "spa",
  "business",
  "business name",
  "company",
  "practice",
  "clinic",
  "med spa",
  "medspa",
  "account",
];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Tab-delimited paste (spreadsheet copy) vs comma CSV. Tabs win when present.
function normalizeToGrid(text: string): string[][] {
  const t = text.trim();
  if (!t) return [];
  if (t.includes("\t")) {
    return t
      .split(/\r?\n/)
      .map((line) => line.split("\t").map((c) => c.trim()))
      .filter((r) => r.some((c) => c));
  }
  return parseCsvGrid(t)
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c));
}

type Mapping = { hasHeader: boolean; emailCol: number; firstCol: number; spaCol: number };

function detectMapping(grid: string[][]): Mapping {
  if (grid.length === 0) {
    return { hasHeader: false, emailCol: 0, firstCol: 1, spaCol: 2 };
  }
  const header = grid[0].map((c) => c.toLowerCase().trim());
  const find = (aliases: string[]) =>
    header.findIndex((h) => aliases.includes(h));
  const emailByHeader = find(EMAIL_ALIASES);

  // No header alias but row 0 already contains an email → treat as headerless.
  if (emailByHeader === -1 && grid[0].some((c) => c.includes("@"))) {
    const ec = grid[0].findIndex((c) => c.includes("@"));
    return {
      hasHeader: false,
      emailCol: ec >= 0 ? ec : 0,
      firstCol: ec === 0 ? 1 : 0,
      spaCol: ec <= 1 ? 2 : 1,
    };
  }

  let emailCol = emailByHeader;
  let firstCol = find(FIRST_ALIASES);
  let spaCol = find(SPA_ALIASES);
  if (emailCol === -1) emailCol = 0;
  if (firstCol === -1) firstCol = emailCol === 0 ? 1 : 0;
  if (spaCol === -1) spaCol = [emailCol, firstCol].includes(2) ? 2 : 2;
  return { hasHeader: true, emailCol, firstCol, spaCol };
}

export function RecipientBulkImport({
  open,
  audience,
  onClose,
  onImport,
}: {
  open: boolean;
  audience: "spa" | "rep";
  onClose: () => void;
  onImport: (
    recipients: ImportRecipient[],
  ) => Promise<{ inserted: number; skipped: number }>;
}) {
  const [mode, setMode] = useState<Mode>("paste");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapOverride, setMapOverride] = useState<Partial<Mapping> | null>(null);
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState<{ inserted: number; skipped: number } | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);

  const grid = useMemo(() => normalizeToGrid(text), [text]);
  const detected = useMemo(() => detectMapping(grid), [grid]);
  const map: Mapping = { ...detected, ...mapOverride };

  const { valid, invalid, dupes } = useMemo(() => {
    const dataRows = map.hasHeader ? grid.slice(1) : grid;
    const seen = new Set<string>();
    const valid: ImportRecipient[] = [];
    const invalid: { email: string; firstName: string }[] = [];
    let dupes = 0;
    for (const row of dataRows) {
      const email = (row[map.emailCol] ?? "").trim().toLowerCase();
      const firstName = (row[map.firstCol] ?? "").trim();
      const spaName =
        audience === "spa" ? (row[map.spaCol] ?? "").trim() : "";
      if (!EMAIL_RE.test(email)) {
        if (email || firstName) invalid.push({ email, firstName });
        continue;
      }
      if (seen.has(email)) {
        dupes++;
        continue;
      }
      seen.add(email);
      valid.push({
        email,
        firstName: firstName || undefined,
        spaName: spaName || undefined,
      });
    }
    return { valid, invalid, dupes };
  }, [grid, map, audience]);

  const reset = () => {
    setText("");
    setFileName(null);
    setMapOverride(null);
    setDone(null);
    setErr(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const onFile = (file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.onerror = () => setErr("Couldn't read that file.");
    reader.readAsText(file);
  };

  const doImport = async () => {
    if (valid.length === 0) return;
    setImporting(true);
    setErr(null);
    try {
      const res = await onImport(valid);
      setDone(res);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  const colOptions = grid[0] ?? [];
  const colLabel = (i: number) =>
    map.hasHeader && colOptions[i]
      ? `${colOptions[i]}`
      : `Column ${i + 1}`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-serif">Upload a list</DialogTitle>
          <DialogDescription>
            Paste from a spreadsheet or upload a CSV — columns for{" "}
            <strong>email</strong>, <strong>first name</strong>
            {audience === "spa" ? (
              <>
                , <strong>spa name</strong>
              </>
            ) : null}{" "}
            in any order. We&apos;ll detect the columns; fix the mapping if we
            guess wrong.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="py-3">
            <div
              className="rounded-md px-3 py-3 text-[13px]"
              style={{ background: "#e8f3ed", color: "#056048" }}
            >
              Added <strong>{done.inserted}</strong> recipient
              {done.inserted === 1 ? "" : "s"} to the roster.
              {done.skipped > 0
                ? ` ${done.skipped} already on the list (skipped, no overrides touched).`
                : ""}
            </div>
          </div>
        ) : (
          <div className="space-y-3 py-1">
            {/* Mode toggle */}
            <div
              className="inline-flex items-center gap-1 rounded-lg border p-1"
              style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
            >
              {(["paste", "upload"] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className="rounded-md px-3 py-1 text-[12px] font-semibold transition"
                  style={{
                    background: mode === m ? "#fff" : "transparent",
                    color: mode === m ? "#056048" : "#8a9098",
                    boxShadow: mode === m ? "0 1px 2px rgba(0,0,0,0.06)" : undefined,
                  }}
                >
                  {m === "paste" ? "Paste" : "Upload CSV"}
                </button>
              ))}
            </div>

            {mode === "paste" ? (
              <textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setMapOverride(null);
                }}
                rows={6}
                placeholder={
                  "Paste rows from a spreadsheet — e.g.\nemail, first name" +
                  (audience === "spa" ? ", spa name" : "") +
                  "\nkelly@lakeside.com, Kelly" +
                  (audience === "spa" ? ", Lakeside Aesthetics" : "")
                }
                className="w-full rounded-md border px-3 py-2 text-[13px] font-mono"
                style={{ borderColor: "#e6e2d6", background: "#fff", color: "#1c2024" }}
              />
            ) : (
              <label
                className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed px-4 py-5 transition hover:bg-[#fbfaf7]"
                style={{ borderColor: "#e6e2d6" }}
              >
                <FileUp className="h-5 w-5" style={{ color: "#056048" }} />
                <span className="text-[13px]" style={{ color: "#5a6068" }}>
                  {fileName ? (
                    <strong style={{ color: "#1c2024" }}>{fileName}</strong>
                  ) : (
                    "Choose a .csv file"
                  )}
                </span>
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      onFile(f);
                      setMapOverride(null);
                    }
                  }}
                />
              </label>
            )}

            {/* Column mapping + review (only once we have rows) */}
            {grid.length > 0 && (
              <>
                <div
                  className="rounded-md border p-3"
                  style={{ borderColor: "#f0ebe0", background: "#fbfaf7" }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span
                      className="text-[11px] uppercase tracking-wider font-semibold"
                      style={{ color: "#8a9098" }}
                    >
                      Column mapping
                    </span>
                    <label
                      className="flex items-center gap-1.5 text-[12px]"
                      style={{ color: "#5a6068" }}
                    >
                      <input
                        type="checkbox"
                        checked={map.hasHeader}
                        onChange={(e) =>
                          setMapOverride((p) => ({
                            ...p,
                            hasHeader: e.target.checked,
                          }))
                        }
                      />
                      First row is a header
                    </label>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <ColumnSelect
                      label="Email"
                      value={map.emailCol}
                      count={Math.max(...grid.map((r) => r.length))}
                      colLabel={colLabel}
                      onChange={(v) => setMapOverride((p) => ({ ...p, emailCol: v }))}
                    />
                    <ColumnSelect
                      label="First name"
                      value={map.firstCol}
                      count={Math.max(...grid.map((r) => r.length))}
                      colLabel={colLabel}
                      onChange={(v) => setMapOverride((p) => ({ ...p, firstCol: v }))}
                    />
                    {audience === "spa" && (
                      <ColumnSelect
                        label="Spa name"
                        value={map.spaCol}
                        count={Math.max(...grid.map((r) => r.length))}
                        colLabel={colLabel}
                        onChange={(v) => setMapOverride((p) => ({ ...p, spaCol: v }))}
                      />
                    )}
                  </div>
                </div>

                <div className="text-[12.5px]" style={{ color: "#5a6068" }}>
                  <strong style={{ color: "#056048" }}>{valid.length} valid</strong>
                  {invalid.length > 0 ? (
                    <>
                      {" · "}
                      <strong style={{ color: "#b45309" }}>
                        {invalid.length} need a fix
                      </strong>
                    </>
                  ) : null}
                  {dupes > 0 ? ` · ${dupes} duplicate${dupes === 1 ? "" : "s"} merged` : ""}
                </div>

                {/* Preview list (cap rows shown) */}
                {valid.length > 0 && (
                  <ul
                    className="max-h-40 overflow-y-auto rounded-md border divide-y text-[12.5px]"
                    style={{ borderColor: "#f0ebe0" }}
                  >
                    {valid.slice(0, 50).map((r, i) => (
                      <li
                        key={`${r.email}-${i}`}
                        className="flex items-center justify-between gap-2 px-3 py-1.5"
                      >
                        <span style={{ color: "#1c2024" }}>
                          {r.firstName || r.email}
                        </span>
                        <span className="truncate" style={{ color: "#8a9098" }}>
                          {r.email}
                          {audience === "spa" && r.spaName ? ` · ${r.spaName}` : ""}
                        </span>
                      </li>
                    ))}
                    {valid.length > 50 && (
                      <li className="px-3 py-1.5" style={{ color: "#8a9098" }}>
                        …and {valid.length - 50} more
                      </li>
                    )}
                  </ul>
                )}

                {invalid.length > 0 && (
                  <details>
                    <summary
                      className="text-[12px] cursor-pointer"
                      style={{ color: "#b45309" }}
                    >
                      {invalid.length} row{invalid.length === 1 ? "" : "s"} skipped
                      (bad email)
                    </summary>
                    <ul className="mt-1 text-[12px]" style={{ color: "#8a9098" }}>
                      {invalid.slice(0, 20).map((r, i) => (
                        <li key={i}>
                          {r.firstName ? `${r.firstName} — ` : ""}
                          {r.email || "(no email)"}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}

            {err && (
              <div className="text-[12px]" style={{ color: "#8a1616" }}>
                {err}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {done ? (
            <button
              type="button"
              onClick={close}
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold transition"
              style={{ background: "#056048", color: "#fbfaf7" }}
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={close}
                className="rounded-md border px-4 py-2 text-[13px] font-semibold transition hover:bg-[#fbfaf7]"
                style={{ borderColor: "#e6e2d6", background: "#fff", color: "#1c2024" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={doImport}
                disabled={importing || valid.length === 0}
                className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: "#056048", color: "#fbfaf7" }}
              >
                <Upload className="h-3.5 w-3.5" />
                {importing ? "Adding…" : `Add ${valid.length} recipient${valid.length === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ColumnSelect({
  label,
  value,
  count,
  colLabel,
  onChange,
}: {
  label: string;
  value: number;
  count: number;
  colLabel: (i: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span
        className="block text-[10px] uppercase tracking-wider font-semibold mb-1"
        style={{ color: "#8a9098" }}
      >
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-md border px-2 py-1.5 text-[12px]"
        style={{ borderColor: "#e6e2d6", background: "#fff", color: "#1c2024" }}
      >
        {Array.from({ length: Math.max(count, value + 1) }, (_, i) => (
          <option key={i} value={i}>
            {colLabel(i)}
          </option>
        ))}
      </select>
    </label>
  );
}
