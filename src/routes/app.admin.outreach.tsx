/**
 * /app/admin/outreach — Outreach template editor + uploader (v393).
 *
 * Grasshopper-only admin surface for editing outreach copy without engineer
 * involvement. Two modes:
 *
 *   INLINE EDIT
 *     Click any template card → modal with subject + body + loom_url + notes
 *     textareas → Save → DB write (creates a new version row, deactivates
 *     the prior). Use this for one-off tweaks (subject line, typo fix,
 *     CTA rewrite).
 *
 *   BULK IMPORT
 *     Click "Import from doc" → file picker → upload the polished
 *     Refill-Outreach-Pack-v1.html (or any HTML with data-template
 *     markers) → client-side DOMParser extracts every template → POSTs as
 *     a bulk upsert. Use this for major rewrites or initial seeding.
 *
 * Per [[project_outreach_paused]] — no email actually fires from this page.
 * The sending code is a future ship; this page is the editorial substrate.
 *
 * Auth: requireAdmin via server fns. Client-side gate uses the tri-state
 * pattern from /app/admin/refill-trials — server response is the source of
 * truth for admin status, no race with useIsAdmin async lookup.
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Upload,
  Save,
  Loader2,
  Mail,
  Video,
  ArrowDown,
  Eye,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  listOutreachTemplates,
  updateOutreachTemplate,
  bulkUpsertOutreachTemplates,
  type OutreachTemplate,
  type OutreachIcp,
} from "@/server/refill-outreach";
import { renderTemplatePreview } from "@/server/refill-outreach-send";

export const Route = createFileRoute("/app/admin/outreach")({
  component: AdminOutreachPage,
});

type GateState = "checking" | "ok" | "not-admin" | "unauthenticated";

// ─── ICP semantic mapping (mirrored from the polished doc) ───────────────

const ICP_META: Record<
  OutreachIcp,
  { label: string; tone: string; color: "warm" | "cold" | "tech" }
> = {
  1: { label: "Karen's network", tone: "warm — peer, often personally known", color: "warm" },
  2: { label: "Tier-2 independents", tone: "cold — RN/MD-owner, no warm intro", color: "cold" },
  3: { label: "Acuity users", tone: "warm-tech — tool-affinity", color: "tech" },
};

const COLOR_STYLES: Record<
  "warm" | "cold" | "tech",
  { border: string; pill: string; pillBg: string }
> = {
  warm: { border: "border-l-emerald-700", pill: "text-emerald-800", pillBg: "bg-emerald-50" },
  cold: { border: "border-l-amber-700", pill: "text-amber-800", pillBg: "bg-amber-50" },
  tech: { border: "border-l-sky-700", pill: "text-sky-800", pillBg: "bg-sky-50" },
};

// ─── Client-side HTML parser for bulk-import ─────────────────────────────

interface ParsedTemplate {
  icp: OutreachIcp;
  channel: string;
  subject: string | null;
  body: string;
}

function parseOutreachPackHtml(html: string): ParsedTemplate[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const templates: ParsedTemplate[] = [];

  const els = doc.querySelectorAll('[data-template="true"]');
  els.forEach((el) => {
    const icpStr = el.getAttribute("data-icp");
    const channel = el.getAttribute("data-channel");
    if (!icpStr || !channel) return;
    const icp = parseInt(icpStr, 10);
    if (icp !== 1 && icp !== 2 && icp !== 3) return;

    // Body: either the element itself is the body container (loom_script
    // case where data-field="body" is on the wrapper), or a child is.
    let body: string;
    if (el.getAttribute("data-field") === "body") {
      body = el.innerHTML.trim();
    } else {
      const bodyEl = el.querySelector('[data-field="body"]');
      if (!bodyEl) return;
      body = bodyEl.innerHTML.trim();
    }

    // Subject: only meaningful for email-style channels. Located by the
    // `<strong>Subject:</strong> ...` pattern inside a .field div.
    let subject: string | null = null;
    if (channel.startsWith("email")) {
      const fields = el.querySelectorAll(".field");
      fields.forEach((field) => {
        if (subject !== null) return;
        const strong = field.querySelector("strong");
        if (strong?.textContent?.includes("Subject")) {
          const rawText = field.textContent ?? "";
          subject = rawText.replace(/^.*?Subject:\s*/, "").trim();
        }
      });
    }

    templates.push({ icp: icp as OutreachIcp, channel, subject, body });
  });

  return templates;
}

// ─── Channel label heuristics for display ────────────────────────────────

function channelLabel(channel: string): string {
  if (channel === "loom_script") return "Loom script";
  if (channel === "email_a") return "Email — variant A";
  if (channel === "email_b") return "Email — variant B";
  const followup = /^email_followup_(\d+)$/.exec(channel);
  if (followup) return `Email — day +${followup[1]} follow-up`;
  return channel;
}

function channelIcon(channel: string) {
  if (channel === "loom_script") return Video;
  if (channel.startsWith("email_followup")) return ArrowDown;
  return Mail;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

// ─── Page ────────────────────────────────────────────────────────────────

function AdminOutreachPage() {
  const { session, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [gate, setGate] = useState<GateState>("checking");
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<OutreachTemplate | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auth bounce
  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      setGate("unauthenticated");
      void navigate({ to: "/login" });
    }
  }, [authLoading, session, navigate]);

  const refresh = async () => {
    const accessToken = session?.access_token;
    if (!accessToken) return;
    try {
      setLoadError(null);
      const result = await listOutreachTemplates({ data: { accessToken } });
      setTemplates(result.templates);
      setGate("ok");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/admin/i.test(msg)) {
        setGate("not-admin");
      } else {
        setGate("ok");
        setLoadError(msg);
      }
    }
  };

  useEffect(() => {
    if (!session?.access_token) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token]);

  // Group templates by ICP for display
  const byIcp = useMemo(() => {
    const map = new Map<OutreachIcp, OutreachTemplate[]>();
    for (const t of templates) {
      const arr = map.get(t.icp) ?? [];
      arr.push(t);
      map.set(t.icp, arr);
    }
    // Sort each ICP's list: loom_script first, then email_a/b, then followups
    const order = (ch: string) => {
      if (ch === "loom_script") return 0;
      if (ch === "email_a") return 1;
      if (ch === "email_b") return 2;
      if (ch.startsWith("email_followup")) return 3;
      return 9;
    };
    for (const arr of map.values()) {
      arr.sort((a, b) => order(a.channel) - order(b.channel) || a.channel.localeCompare(b.channel));
    }
    return map;
  }, [templates]);

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleImport = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-uploading the same file
    if (!file) return;

    const accessToken = session?.access_token;
    if (!accessToken) return;

    setImporting(true);
    try {
      const text = await file.text();
      const parsed = parseOutreachPackHtml(text);
      if (parsed.length === 0) {
        toast.error("No templates found in this file. Check that data-template markers are present.");
        return;
      }
      const result = await bulkUpsertOutreachTemplates({
        data: {
          accessToken,
          templates: parsed.map((p) => ({
            icp: p.icp,
            channel: p.channel,
            subject: p.subject,
            body: p.body,
          })),
        },
      });
      if (result.errors.length > 0) {
        toast.warning(
          `Imported ${result.upserted} of ${parsed.length}. ${result.errors.length} errors — check console.`,
        );
        console.warn("[outreach import] errors:", result.errors);
      } else {
        toast.success(`Imported ${result.upserted} templates from doc.`);
      }
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Import failed: ${msg}`);
    } finally {
      setImporting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────

  if (gate === "checking" || authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Checking access…
      </div>
    );
  }

  if (gate === "not-admin") {
    return (
      <div className="mx-auto max-w-2xl px-6 py-24 text-center">
        <h1 className="text-2xl font-semibold text-slate-900">Admin only</h1>
        <p className="mt-3 text-slate-600">
          /app/admin/outreach is for editing outreach copy. You need admin access on this account.
        </p>
        <Link to="/app" className="mt-6 inline-block text-sm text-emerald-700 underline">
          Back to /app
        </Link>
      </div>
    );
  }

  if (gate === "unauthenticated") {
    return null; // redirecting
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <PageHeader />
      <main className="mx-auto max-w-6xl px-6 py-10">
        {/* Header row */}
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl font-semibold text-slate-900">
              Outreach copy
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">
              Edit any template inline. Upload a fresh{" "}
              <code className="rounded bg-slate-200 px-1 py-0.5 text-xs">
                Refill-Outreach-Pack-v1.html
              </code>{" "}
              to rewrite in bulk. Every edit creates a new version; the partial unique index
              keeps the active row honest. No emails fire from this page — that's a separate
              ship.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".html,text/html"
              className="hidden"
              onChange={handleFileSelected}
            />
            <Button onClick={handleImport} disabled={importing} variant="outline">
              {importing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Parsing…
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Import from doc
                </>
              )}
            </Button>
          </div>
        </div>

        {loadError ? (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            Couldn't load templates: {loadError}
          </div>
        ) : null}

        {/* Empty state */}
        {templates.length === 0 && !loadError ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center">
            <p className="text-slate-700">No templates yet.</p>
            <p className="mt-1 text-sm text-slate-500">
              Click <strong>Import from doc</strong> and upload
              <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 text-xs">
                Refill-Outreach-Pack-v1.html
              </code>
              to seed the v1 set.
            </p>
          </div>
        ) : null}

        {/* ICP columns */}
        <div className="grid gap-6 lg:grid-cols-3">
          {([1, 2, 3] as OutreachIcp[]).map((icp) => {
            const meta = ICP_META[icp];
            const styles = COLOR_STYLES[meta.color];
            const items = byIcp.get(icp) ?? [];
            return (
              <section
                key={icp}
                className={`overflow-hidden rounded-xl border bg-white shadow-sm border-l-4 ${styles.border}`}
              >
                <header className="border-b border-slate-100 px-5 py-4">
                  <div className="flex items-center justify-between">
                    <h2 className="font-serif text-lg font-semibold text-slate-900">
                      ICP {icp} — {meta.label}
                    </h2>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${styles.pillBg} ${styles.pill}`}
                    >
                      {meta.color}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{meta.tone}</p>
                </header>
                <ul className="divide-y divide-slate-100">
                  {items.length === 0 ? (
                    <li className="px-5 py-6 text-center text-sm text-slate-400">
                      No templates — import the doc to seed.
                    </li>
                  ) : (
                    items.map((tpl) => {
                      const Icon = channelIcon(tpl.channel);
                      return (
                        <li key={tpl.id}>
                          <button
                            type="button"
                            onClick={() => setEditing(tpl)}
                            className="block w-full px-5 py-3 text-left transition hover:bg-slate-50"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span className="flex items-center gap-2 text-sm font-medium text-slate-900">
                                <Icon className="h-3.5 w-3.5 text-slate-400" />
                                {channelLabel(tpl.channel)}
                              </span>
                              <span className="whitespace-nowrap text-[11px] uppercase tracking-wide text-slate-400">
                                v{tpl.version} · {formatTimestamp(tpl.updatedAt)}
                              </span>
                            </div>
                            {tpl.subject ? (
                              <p className="mt-1 truncate text-xs italic text-slate-500">
                                {tpl.subject}
                              </p>
                            ) : (
                              <p className="mt-1 text-xs text-slate-400">
                                ({tpl.channel === "loom_script" ? "video script" : "no subject"})
                              </p>
                            )}
                          </button>
                        </li>
                      );
                    })
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      </main>

      {/* Inline edit modal */}
      <EditModal
        template={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          setTemplates((prev) =>
            prev.map((t) => (t.icp === updated.icp && t.channel === updated.channel ? updated : t)),
          );
          setEditing(null);
          toast.success(`Saved · v${updated.version}`);
        }}
        accessToken={session?.access_token ?? null}
      />
    </div>
  );
}

// ─── EditModal ───────────────────────────────────────────────────────────

interface EditModalProps {
  template: OutreachTemplate | null;
  onClose: () => void;
  onSaved: (next: OutreachTemplate) => void;
  accessToken: string | null;
}

// Sample placeholder context for the Preview button. Realistic enough that
// rendered output reads as if it went to a real prospect. Per
// [[feedback_math_must_be_exact]]: numbers are illustrative, not real Rejuv
// data — operator should substitute live data at actual send time.
const PREVIEW_SAMPLE_CONTEXT = {
  firstName: "Sarah",
  spaName: "Lakeside Aesthetics",
  acuityUrl: "app.acuityscheduling.com/schedule.php?owner=12345678",
  rejuvRecoveredAmount: "$4,275",
  rejuvRecoveredWeeks: "5",
  rejuvRecentRecoveredAmount: "$680",
  recipient: "Sarah",
};

interface PreviewResult {
  subject: string | null;
  body: string;
  replyToSample: string;
  placeholdersFound: string[];
}

function EditModal({ template, onClose, onSaved, accessToken }: EditModalProps) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loomUrl, setLoomUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Preview state
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (template) {
      setSubject(template.subject ?? "");
      setBody(template.body);
      setLoomUrl(template.loomUrl ?? "");
      setNotes(template.notes ?? "");
      setShowPreview(false);
      setPreview(null);
    }
  }, [template]);

  const handleSave = async () => {
    if (!template || !accessToken) return;
    setSaving(true);
    try {
      const updated = await updateOutreachTemplate({
        data: {
          accessToken,
          id: template.id,
          subject: template.channel === "loom_script" ? null : subject || null,
          body,
          loomUrl: loomUrl || null,
          notes: notes || null,
        },
      });
      onSaved(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't save: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    if (!template || !accessToken) return;
    setPreviewing(true);
    try {
      const result = await renderTemplatePreview({
        data: {
          accessToken,
          icp: template.icp,
          channel: template.channel,
          // Send the UNSAVED draft so preview reflects whatever's currently
          // in the textareas, not the last DB state.
          draftSubject: template.channel === "loom_script" ? null : subject || null,
          draftBody: body,
          context: PREVIEW_SAMPLE_CONTEXT,
        },
      });
      setPreview(result);
      setShowPreview(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't render preview: ${msg}`);
    } finally {
      setPreviewing(false);
    }
  };

  const open = template !== null;
  const isLoom = template?.channel === "loom_script";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-serif">
            {template
              ? `ICP ${template.icp} — ${channelLabel(template.channel)}`
              : ""}
            {showPreview ? (
              <span className="ml-3 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-emerald-700">
                Preview
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            {template ? (
              showPreview ? (
                <>
                  Rendered with sample values: <strong>Sarah</strong> @{" "}
                  <strong>Lakeside Aesthetics</strong> · $4,275 over 5 weeks. Real values get
                  substituted at send time per recipient.
                </>
              ) : (
                <>
                  Currently active version <strong>v{template.version}</strong>. Saving creates v
                  {template.version + 1} and deactivates the prior. No emails fire from this edit.
                </>
              )
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {template ? (
          showPreview && preview ? (
            <PreviewPane preview={preview} isLoom={isLoom} />
          ) : (
            <div className="space-y-4 py-2">
              {!isLoom ? (
                <div>
                  <Label htmlFor="outreach-subject" className="text-xs uppercase tracking-wide text-slate-600">
                    Subject
                  </Label>
                  <Input
                    id="outreach-subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Email subject line"
                    className="mt-1"
                  />
                </div>
              ) : (
                <div>
                  <Label htmlFor="outreach-loom-url" className="text-xs uppercase tracking-wide text-slate-600">
                    Loom video URL (optional)
                  </Label>
                  <Input
                    id="outreach-loom-url"
                    value={loomUrl}
                    onChange={(e) => setLoomUrl(e.target.value)}
                    placeholder="https://loom.com/share/..."
                    className="mt-1"
                  />
                </div>
              )}
              <div>
                <Label htmlFor="outreach-body" className="text-xs uppercase tracking-wide text-slate-600">
                  {isLoom ? "Script" : "Body (HTML)"}
                </Label>
                <Textarea
                  id="outreach-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={isLoom ? 18 : 14}
                  className="mt-1 font-mono text-[13px]"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  {isLoom
                    ? "Plain text + timestamps. Read aloud as Karen."
                    : "HTML allowed. Placeholders like [first name] / [spa name] / $[exact figure] are substituted at send time."}
                </p>
              </div>
              <div>
                <Label htmlFor="outreach-notes" className="text-xs uppercase tracking-wide text-slate-600">
                  Internal notes (not sent)
                </Label>
                <Textarea
                  id="outreach-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Why this variant, what to test, etc."
                  className="mt-1 text-sm"
                />
              </div>
            </div>
          )
        ) : null}
        <DialogFooter>
          {showPreview ? (
            <>
              <Button variant="outline" onClick={() => setShowPreview(false)}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to edit
              </Button>
              <Button onClick={onClose}>Close</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={handlePreview}
                disabled={previewing || !body.trim()}
              >
                {previewing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Rendering…
                  </>
                ) : (
                  <>
                    <Eye className="mr-2 h-4 w-4" />
                    Preview
                  </>
                )}
              </Button>
              <Button onClick={handleSave} disabled={saving || !body.trim()}>
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    Save (creates v{(template?.version ?? 0) + 1})
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── PreviewPane — rendered output for the Preview button ────────────────

function PreviewPane({
  preview,
  isLoom,
}: {
  preview: PreviewResult;
  isLoom: boolean;
}) {
  const hasUnfilled = preview.placeholdersFound.length > 0;
  return (
    <div className="space-y-4 py-2">
      {hasUnfilled ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>Unfilled placeholders:</strong>{" "}
          {preview.placeholdersFound.join(", ")} — these stayed literal because no value was
          supplied. Live sends require real values.
        </div>
      ) : null}

      {preview.subject ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Subject
          </div>
          <div className="mt-1 text-sm font-medium text-slate-900">{preview.subject}</div>
        </div>
      ) : null}

      <div className="rounded-md border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          {isLoom ? "Rendered script" : "Rendered body"}
        </div>
        <div className="px-5 py-4">
          {isLoom ? (
            <div className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-slate-800">
              {/* Loom scripts are HTML-ish but render best as preserved text */}
              <div dangerouslySetInnerHTML={{ __html: preview.body }} />
            </div>
          ) : (
            <div
              className="prose prose-sm max-w-none text-slate-800"
              dangerouslySetInnerHTML={{ __html: preview.body }}
            />
          )}
        </div>
      </div>

      <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Reply-To address shape
        </div>
        <code className="mt-1 block font-mono text-[11px] text-slate-700">
          {preview.replyToSample}
        </code>
      </div>
    </div>
  );
}
