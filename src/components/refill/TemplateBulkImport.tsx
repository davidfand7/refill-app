/**
 * TemplateBulkImport — paste-or-upload template seeding (v1.45.0).
 *
 * Companion to the existing HTML-marker import on /app/admin/outreach. That
 * path only accepts the Refill-Outreach-Pack.html doc (with data-template
 * markers). This path accepts:
 *   - Raw paste (textarea)
 *   - .txt / .md plain text
 *   - .docx (parsed via mammoth.js → HTML)
 *
 * Auto-detects multi-message docs via:
 *   1. Markdown horizontal rule (`---` on its own line) — splits there
 *   2. Otherwise, the whole doc = single message
 *
 * Subject auto-detect (per message):
 *   - First line matching `^Subject:\s*(.+)$` (case-insensitive)
 *   - Otherwise leaves subject empty for the admin to fill
 *
 * Each parsed message lands in a review card with editable subject + TipTap
 * body + ICP + channel + audience selectors. "Save all" → bulkUpsert.
 *
 * Why admin-only (v1.45.0 scope): templates live in a SHARED library. Rep-
 * side upload would require either (a) rep can mutate the global library
 * OR (b) new per-rep template scoping. Both are bigger than one ship — defer.
 */

import { useCallback, useState } from "react";
import { FileText, Loader2, Upload, X, Sparkles } from "lucide-react";
import { toast } from "sonner";
import mammoth from "mammoth";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TemplateEditor } from "@/components/refill/TemplateEditor";
import {
  bulkUpsertOutreachTemplates,
  type OutreachAudience,
  type OutreachIcp,
} from "@/server/refill-outreach";

// ─── Types ───────────────────────────────────────────────────────────────

interface DraftTemplate {
  id: string; // local-only key for the React list
  icp: OutreachIcp;
  channel: string;
  audience: OutreachAudience;
  subject: string;
  body: string; // HTML
}

interface TemplateBulkImportProps {
  open: boolean;
  onClose: () => void;
  onSaved: (count: number) => void;
  accessToken: string | null;
}

type Mode = "paste" | "upload";

// ─── Component ───────────────────────────────────────────────────────────

export function TemplateBulkImport({
  open,
  onClose,
  onSaved,
  accessToken,
}: TemplateBulkImportProps) {
  const [mode, setMode] = useState<Mode>("paste");
  const [pasteText, setPasteText] = useState("");
  const [drafts, setDrafts] = useState<DraftTemplate[] | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPasteText("");
    setDrafts(null);
    setSourceLabel(null);
  }, []);

  const handleClose = () => {
    if (saving) return;
    reset();
    onClose();
  };

  const handleParsePaste = async () => {
    const trimmed = pasteText.trim();
    if (!trimmed) {
      toast.error("Paste some text first.");
      return;
    }
    setParsing(true);
    try {
      const drafts = splitIntoDrafts(trimmed, "text");
      if (drafts.length === 0) {
        toast.error("Couldn't find any messages in the pasted text.");
        return;
      }
      setDrafts(drafts);
      setSourceLabel(`Pasted text (${drafts.length} message${drafts.length === 1 ? "" : "s"})`);
    } finally {
      setParsing(false);
    }
  };

  const handleFile = async (file: File) => {
    setParsing(true);
    try {
      const name = file.name.toLowerCase();
      let raw: string;
      let kind: "text" | "html";
      if (name.endsWith(".docx")) {
        const buf = await file.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer: buf });
        raw = result.value; // HTML
        kind = "html";
      } else if (name.endsWith(".md") || name.endsWith(".txt") || file.type.startsWith("text/")) {
        raw = await file.text();
        kind = "text";
      } else {
        toast.error("Unsupported file. Use .txt, .md, or .docx.");
        return;
      }
      const drafts = splitIntoDrafts(raw, kind);
      if (drafts.length === 0) {
        toast.error("Couldn't find any messages in the file.");
        return;
      }
      setDrafts(drafts);
      setSourceLabel(`${file.name} (${drafts.length} message${drafts.length === 1 ? "" : "s"})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't parse file: ${msg}`);
    } finally {
      setParsing(false);
    }
  };

  const handleUpdateDraft = (id: string, patch: Partial<DraftTemplate>) => {
    setDrafts((prev) =>
      prev ? prev.map((d) => (d.id === id ? { ...d, ...patch } : d)) : prev,
    );
  };

  const handleRemoveDraft = (id: string) => {
    setDrafts((prev) => (prev ? prev.filter((d) => d.id !== id) : prev));
  };

  const handleSaveAll = async () => {
    if (!drafts || drafts.length === 0 || !accessToken) return;
    // Validate: every draft needs a non-empty channel + body. Subject is
    // optional (Loom-style channels have null subject).
    const missing = drafts.find((d) => !d.channel.trim() || !d.body.trim());
    if (missing) {
      toast.error("Every message needs a channel + body.");
      return;
    }
    // Validate: no duplicate (icp, channel, audience) tuples in this batch.
    // The server would deactivate-then-insert sequentially, so duplicates
    // within the batch would silently lose. Catch here.
    const seen = new Set<string>();
    for (const d of drafts) {
      const key = `${d.audience}/${d.icp}/${d.channel.trim()}`;
      if (seen.has(key)) {
        toast.error(
          `Duplicate ${d.audience}/ICP${d.icp}/${d.channel} in this batch. Each (audience, ICP, channel) tuple must be unique.`,
        );
        return;
      }
      seen.add(key);
    }
    setSaving(true);
    try {
      const result = await bulkUpsertOutreachTemplates({
        data: {
          accessToken,
          templates: drafts.map((d) => ({
            icp: d.icp,
            channel: d.channel.trim(),
            audience: d.audience,
            subject: d.subject.trim() || null,
            body: d.body,
          })),
        },
      });
      if (result.errors.length > 0) {
        toast.error(`Partial: ${result.upserted} saved, ${result.errors.length} failed. ${result.errors[0]}`);
      } else {
        toast.success(`Saved ${result.upserted} template${result.upserted === 1 ? "" : "s"}.`);
      }
      onSaved(result.upserted);
      reset();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif">
            Paste or upload templates
            {drafts && (
              <span className="ml-3 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-emerald-700">
                Review · {drafts.length}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {drafts ? (
              <>
                Review each parsed message, set ICP + channel + audience, then save.
                {sourceLabel ? <> Source: <strong>{sourceLabel}</strong>.</> : null}
              </>
            ) : (
              <>
                Paste your message(s) below, or upload a <code>.txt</code> /{" "}
                <code>.md</code> / <code>.docx</code> file. Multiple messages?
                Separate with <code>---</code> on its own line.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {!drafts ? (
          <div className="py-2">
            {/* Mode tabs */}
            <div className="mb-3 inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white p-1">
              <ModeTab
                active={mode === "paste"}
                onClick={() => setMode("paste")}
                icon={<FileText className="h-3.5 w-3.5" />}
                label="Paste"
              />
              <ModeTab
                active={mode === "upload"}
                onClick={() => setMode("upload")}
                icon={<Upload className="h-3.5 w-3.5" />}
                label="Upload"
              />
            </div>

            {mode === "paste" ? (
              <div>
                <Label htmlFor="paste-text" className="text-xs uppercase tracking-wide text-slate-600">
                  Paste your message(s) here
                </Label>
                <textarea
                  id="paste-text"
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  rows={12}
                  placeholder={
                    "Subject: Quick intro from Karen at Rejuv\n\nHi [first name],\n\nWe've been running Refill for [N] weeks and recovered $[exact figure] in cancelled appointments.\n\n---\n\nSubject: Another template\n\nHi [first name], ...\n"
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-[13px] leading-[1.5] focus:outline-none focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700/30"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Tip: prefix the first line with <code>Subject:</code> to set
                  the email subject. Separate multiple messages with{" "}
                  <code>---</code> on its own line. Placeholders like{" "}
                  <code>[first name]</code> are preserved verbatim.
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="outline" onClick={handleClose} disabled={parsing}>
                    Cancel
                  </Button>
                  <Button onClick={handleParsePaste} disabled={parsing || !pasteText.trim()}>
                    {parsing ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Parsing…</>
                    ) : (
                      <><Sparkles className="mr-2 h-4 w-4" />Parse</>
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Label htmlFor="upload-file" className="text-xs uppercase tracking-wide text-slate-600">
                  Choose a file
                </Label>
                <div
                  className="mt-1 rounded-md border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center"
                >
                  <Upload className="mx-auto h-6 w-6 text-slate-400" />
                  <p className="mt-2 text-[13px] text-slate-600">
                    Drop a <code>.txt</code>, <code>.md</code>, or <code>.docx</code> file, or
                  </p>
                  <Input
                    id="upload-file"
                    type="file"
                    accept=".txt,.md,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleFile(file);
                      e.target.value = "";
                    }}
                    className="mx-auto mt-3 max-w-xs"
                  />
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  <code>.docx</code> formatting (bold/italic/links/bullets) is
                  preserved.{" "}
                  <code>.txt</code> /{" "}
                  <code>.md</code> are converted to clean paragraphs.
                  Separate multiple messages with <code>---</code> on its own line.
                </p>
                <div className="mt-3 flex justify-end">
                  <Button variant="outline" onClick={handleClose} disabled={parsing}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="py-2 space-y-4">
            {drafts.map((draft, idx) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                index={idx}
                onUpdate={(patch) => handleUpdateDraft(draft.id, patch)}
                onRemove={() => handleRemoveDraft(draft.id)}
                canRemove={drafts.length > 1}
              />
            ))}
          </div>
        )}

        {drafts && (
          <DialogFooter>
            <Button variant="outline" onClick={() => setDrafts(null)} disabled={saving}>
              Back
            </Button>
            <Button onClick={handleSaveAll} disabled={saving || drafts.length === 0}>
              {saving ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</>
              ) : (
                <>Save {drafts.length} template{drafts.length === 1 ? "" : "s"}</>
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-medium transition ${
        active
          ? "bg-emerald-50 text-emerald-800"
          : "text-slate-600 hover:bg-slate-100"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function DraftCard({
  draft,
  index,
  onUpdate,
  onRemove,
  canRemove,
}: {
  draft: DraftTemplate;
  index: number;
  onUpdate: (patch: Partial<DraftTemplate>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">
          Message {index + 1}
        </div>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove this message"
            className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-slate-500">Audience</Label>
          <select
            value={draft.audience}
            onChange={(e) => onUpdate({ audience: e.target.value as OutreachAudience })}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[13px] focus:outline-none focus:border-emerald-700"
          >
            <option value="spa">Spa prospect</option>
            <option value="rep">Peer rep (recruit)</option>
          </select>
        </div>
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-slate-500">ICP</Label>
          <select
            value={draft.icp}
            onChange={(e) => onUpdate({ icp: Number(e.target.value) as OutreachIcp })}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[13px] focus:outline-none focus:border-emerald-700"
          >
            <option value={1}>ICP 1 · warm</option>
            <option value={2}>ICP 2 · cold</option>
            <option value={3}>ICP 3 · tech-affinity</option>
          </select>
        </div>
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-slate-500">Channel</Label>
          <Input
            value={draft.channel}
            onChange={(e) => onUpdate({ channel: e.target.value })}
            placeholder="email_intro / loom_script / …"
            className="mt-1 text-[13px]"
          />
        </div>
      </div>

      <div className="mt-3">
        <Label className="text-[10px] uppercase tracking-wider text-slate-500">Subject</Label>
        <Input
          value={draft.subject}
          onChange={(e) => onUpdate({ subject: e.target.value })}
          placeholder="(leave empty for Loom-style channels)"
          className="mt-1 text-[13px]"
        />
      </div>

      <div className="mt-3">
        <Label className="text-[10px] uppercase tracking-wider text-slate-500">Body</Label>
        <div className="mt-1">
          <TemplateEditor
            value={draft.body}
            onChange={(html) => onUpdate({ body: html })}
            rows={8}
            placeholderHints={
              draft.audience === "rep"
                ? ["[first name]", "[from first name]", "[my commission rate]"]
                : ["[first name]", "[spa name]", "$[exact figure]", "[N] weeks"]
            }
          />
        </div>
      </div>
    </div>
  );
}

// ─── Parsing helpers ─────────────────────────────────────────────────────

/**
 * Split raw input into one or more draft templates. Auto-detects:
 *   - `---` on its own line as a message separator
 *   - First line matching `Subject: <text>` as the subject (case-insensitive)
 *
 * For text input: each chunk becomes a sequence of <p> tags (one per
 * line/paragraph). For HTML input (from mammoth): chunks already have
 * <p>/<strong>/<a>/<ul> etc. — passed through.
 */
function splitIntoDrafts(raw: string, kind: "text" | "html"): DraftTemplate[] {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return [];

  let chunks: string[];
  if (kind === "html") {
    // For HTML, look for a <hr> or a paragraph containing only "---" as the
    // separator. Mammoth converts markdown HRs to <hr/>.
    chunks = normalized
      .split(/<hr\s*\/?>|<p[^>]*>\s*-{3,}\s*<\/p>/i)
      .map((c) => c.trim())
      .filter(Boolean);
  } else {
    // Plain text: split on a line that is just `---` (3+ dashes), with
    // optional surrounding whitespace.
    chunks = normalized
      .split(/(?:^|\n)\s*-{3,}\s*(?:\n|$)/)
      .map((c) => c.trim())
      .filter(Boolean);
  }

  if (chunks.length === 0) return [];

  return chunks.map((chunk, idx) => {
    const { subject, body } = extractSubjectAndBody(chunk, kind);
    return {
      id: `draft-${Date.now()}-${idx}`,
      icp: 2, // default to "cold" — admin reviews + adjusts
      channel: "",
      audience: "spa",
      subject,
      body,
    };
  });
}

function extractSubjectAndBody(
  chunk: string,
  kind: "text" | "html",
): { subject: string; body: string } {
  if (kind === "html") {
    // Look for a leading <p>Subject: …</p>. Mammoth wraps lines in <p>.
    const m = chunk.match(/^\s*<p[^>]*>\s*Subject\s*:\s*(.+?)\s*<\/p>\s*/i);
    if (m) {
      const subject = m[1].replace(/<[^>]+>/g, "").trim();
      const body = chunk.slice(m[0].length).trim();
      return { subject, body: body || "<p></p>" };
    }
    return { subject: "", body: chunk };
  }

  // Plain text: first non-empty line matching `Subject: ...`
  const lines = chunk.split("\n");
  let subject = "";
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = line.match(/^Subject\s*:\s*(.+)$/i);
    if (m) {
      subject = m[1].trim();
      bodyStart = i + 1;
    }
    break;
  }
  const bodyText = lines.slice(bodyStart).join("\n").trim();
  return { subject, body: textToHtml(bodyText) };
}

/**
 * Convert plain-text body into safe HTML: paragraphs separated by blank
 * lines become <p>, single newlines within a paragraph become <br>.
 * Auto-links bare http(s) URLs. HTML entities escaped.
 */
function textToHtml(text: string): string {
  if (!text.trim()) return "<p></p>";
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paragraphs
    .map((p) => {
      const escaped = escape(p).replace(/\n/g, "<br>");
      // Auto-link http(s) URLs. Keep narrow — don't try to be clever.
      const linked = escaped.replace(
        /(https?:\/\/[^\s<]+)/g,
        (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
      );
      return `<p>${linked}</p>`;
    })
    .join("");
}
