/**
 * /app/refill/waitlist/invite — cold opt-in invite composer (v1.27.2).
 *
 * Karen's v1.27.x production keystone surface. Picks a small batch of
 * A-list patients (default top 5 by lifetime spend), lets her review +
 * edit the invite copy, then ships ready-to-send iMessage drafts to her
 * inbox via the v1.27.1 sendOptInInviteBatchFn pipeline.
 *
 * Distinct from /app/refill/waitlist/bulk (the URL-export tool from v374
 * — used for mass distribution via email blast / external channel). This
 * page is the focused warm-invite path: small batch, one composed invite,
 * iMessage-MCP send. The two surfaces answer different questions ("give
 * me URLs to distribute" vs. "send blue-bubble invites from my Apple ID").
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  HeartHandshake,
  Loader2,
  Search,
  Send,
  Sparkles,
  Users,
  XCircle,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { matchesAListRules } from "@/lib/a-list-rules";
import {
  listPatients,
  type PatientListRow,
} from "@/server/patient-ingest.functions";
import {
  DEFAULT_A_LIST_RULES,
  getMyAListRules,
  type AListRules,
} from "@/server/user-prefs.functions";
import {
  listReliabilityFlags,
  type ReliabilityFlag,
} from "@/server/emma-reliability.functions";
import {
  getInviteCopyTemplateFn,
  sendOptInInviteBatchFn,
  type InviteBatchResult,
} from "@/server/emma-waitlist-invite.functions";
import { setSpaProfileLookupKeyFn } from "@/server/spa-profile.functions";

export const Route = createFileRoute("/app/refill/waitlist/invite")({
  component: WaitlistInvitePage,
});

function firstNameOf(displayName: string | null | undefined): string {
  if (!displayName) return "there";
  if (displayName.includes(",")) {
    const parts = displayName.split(",", 2).map((s) => s.trim());
    return parts[1] || "there";
  }
  const parts = displayName.trim().split(/\s+/);
  return parts[0] || "there";
}

function WaitlistInvitePage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [patients, setPatients] = useState<PatientListRow[]>([]);
  const [rules, setRules] = useState<AListRules>(DEFAULT_A_LIST_RULES);
  const [reliabilityFlags, setReliabilityFlags] = useState<ReliabilityFlag[]>(
    [],
  );

  const [serverTemplate, setServerTemplate] = useState<string>("");
  const [serverTemplateIsDefault, setServerTemplateIsDefault] = useState(true);
  const [inviteBody, setInviteBody] = useState("");

  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [didAutoSelect, setDidAutoSelect] = useState(false);

  const [sending, setSending] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [result, setResult] = useState<InviteBatchResult | null>(null);

  // ─── Bootstrap ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (membership.status !== "tenant") return;
    let cancelled = false;
    setLoading(true);
    setErrorMessage(null);
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) {
          if (!cancelled) setErrorMessage("Please sign in to send invites.");
          return;
        }
        const [pp, rr, flags, tpl] = await Promise.all([
          listPatients({
            data: { accessToken: token, viewAsUserId, limit: 5000 },
          }),
          getMyAListRules({ data: { accessToken: token, viewAsUserId } }),
          listReliabilityFlags({
            data: { accessToken: token, viewAsUserId },
          }),
          getInviteCopyTemplateFn({
            data: { accessToken: token, viewAsUserId },
          }),
        ]);
        if (cancelled) return;
        setAccessToken(token);
        setPatients(pp);
        setRules(rr.rules);
        setReliabilityFlags(flags);
        setServerTemplate(tpl.template);
        setServerTemplateIsDefault(tpl.isDefault);
        setInviteBody(tpl.template);
      } catch (e) {
        if (!cancelled) {
          setErrorMessage(
            e instanceof Error
              ? e.message
              : "Couldn't load the invite composer.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [membership.status, viewAsUserId]);

  // ─── Derived: A-list filtered candidates with phone ─────────────────────
  const unreliableIds = useMemo(
    () =>
      new Set(
        reliabilityFlags
          .filter((f) => f.cancellations6mo > 0 || f.noShows6mo > 0)
          .map((f) => f.patientNodeId),
      ),
    [reliabilityFlags],
  );

  const candidates = useMemo(() => {
    const todayMs = Date.now();
    return patients
      .filter((p) => p.phone && p.phone.trim().length > 0)
      .filter((p) => matchesAListRules(p, rules, todayMs, unreliableIds))
      .sort((a, b) => b.lifetimeSpendUsd - a.lifetimeSpendUsd);
  }, [patients, rules, unreliableIds]);

  // Default-select top 5 once on first non-empty candidates load
  useEffect(() => {
    if (didAutoSelect || loading || result) return;
    if (candidates.length === 0) return;
    setSelectedIds(new Set(candidates.slice(0, 5).map((p) => p.id)));
    setDidAutoSelect(true);
  }, [candidates, loading, result, didAutoSelect]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((p) => {
      const hay = `${p.displayName ?? ""} ${p.phone ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [candidates, query]);

  const previewBody = useMemo(() => {
    if (!inviteBody) return "";
    const firstSelected = candidates.find((p) => selectedIds.has(p.id));
    const firstName = firstNameOf(firstSelected?.displayName);
    return inviteBody
      .replace(/\{first_name\}/g, firstName)
      .replace(/\{spa_name\}/g, "[your spa name]")
      .replace(/\{owner_name\}/g, "[your name]")
      .replace(
        /\{opt_in_url\}/g,
        "https://getrefill.app/waitlist/optin/abc-123",
      );
  }, [inviteBody, selectedIds, candidates]);

  const templateDirty = inviteBody.trim() !== serverTemplate.trim();
  const canSend =
    !sending &&
    selectedIds.size > 0 &&
    inviteBody.trim().length >= 20 &&
    !!accessToken;

  // ─── Handlers ───────────────────────────────────────────────────────────
  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectTopN = useCallback(
    (n: number) => {
      setSelectedIds(new Set(candidates.slice(0, n).map((p) => p.id)));
    },
    [candidates],
  );

  const handleClear = useCallback(() => setSelectedIds(new Set()), []);

  const handleResetTemplate = useCallback(() => {
    setInviteBody(serverTemplate);
  }, [serverTemplate]);

  const handleSaveTemplate = useCallback(async () => {
    if (!accessToken || savingTemplate) return;
    if (inviteBody.trim().length < 20) {
      toast.error("Invite body is too short to save.");
      return;
    }
    setSavingTemplate(true);
    try {
      await setSpaProfileLookupKeyFn({
        data: {
          accessToken,
          lookupKey: "invite-copy-template",
          value: inviteBody,
          viewAsUserId,
        },
      });
      setServerTemplate(inviteBody);
      setServerTemplateIsDefault(false);
      toast.success("Saved as your default invite copy.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save template.");
    } finally {
      setSavingTemplate(false);
    }
  }, [accessToken, savingTemplate, inviteBody, viewAsUserId]);

  const handleSend = useCallback(async () => {
    if (!canSend || !accessToken) return;
    setSending(true);
    try {
      const r = await sendOptInInviteBatchFn({
        data: {
          accessToken,
          viewAsUserId,
          patientNodeIds: Array.from(selectedIds),
          inviteBody,
        },
      });
      setResult(r);
      if (r.ok) {
        toast.success(
          `${r.sent} ${r.sent === 1 ? "invite" : "invites"} drafted in your inbox.`,
        );
      } else {
        toast.error("Some invites didn't send — check the results.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setSending(false);
    }
  }, [canSend, accessToken, selectedIds, inviteBody, viewAsUserId]);

  const handleNewBatch = useCallback(() => {
    setResult(null);
    setSelectedIds(new Set());
    setDidAutoSelect(false);
  }, []);

  // ─── Render ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-5 w-5 animate-spin text-ink-faint" />
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="px-6 lg:px-10 py-12 max-w-3xl mx-auto">
        <div className="rounded-xl border border-amber/40 bg-amber/5 px-5 py-4 text-sm text-ink">
          {errorMessage}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Invite to waitlist"
        description={`Send blue-bubble iMessage invites from your Apple ID to ${candidates.length} A-list ${candidates.length === 1 ? "patient" : "patients"}. Drafts land in your inbox, then Claude Desktop drafts each one in Messages.app.`}
        actions={
          <Link
            to="/app/refill/patients/a-list-rules"
            className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium hover:bg-rule-soft transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            A-list rules
          </Link>
        }
      />

      <div className="px-6 lg:px-10 py-6 space-y-6 max-w-[1600px] mx-auto">
        {/* Result panel */}
        {result && (
          <section
            className={`rounded-2xl border-2 p-6 ${
              result.ok
                ? "border-emerald-200 bg-emerald-50"
                : "border-amber/40 bg-amber/5"
            }`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${
                  result.ok
                    ? "bg-emerald-500 text-white"
                    : "bg-amber text-white"
                }`}
              >
                {result.ok ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <AlertCircle className="h-5 w-5" />
                )}
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-ink">
                  {result.sent} invite{result.sent === 1 ? "" : "s"} drafted in
                  your inbox
                </div>
                <div className="text-xs text-ink-soft mt-0.5 leading-relaxed">
                  {result.skipped > 0 && (
                    <>
                      {result.skipped} skipped (already on waitlist, no phone,
                      or banned){" · "}
                    </>
                  )}
                  {result.errored > 0 && (
                    <>
                      {result.errored} errored{" · "}
                    </>
                  )}
                  Open the email from{" "}
                  <strong>Refill — waitlist invites ready to send</strong> in
                  Claude Desktop. The MCP cron will pick it up and draft each
                  iMessage in Messages.app for you to review and tap Send.
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={handleNewBatch}
              className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-ink text-paper px-4 py-2 text-sm font-medium hover:opacity-90 transition"
            >
              <Sparkles className="h-4 w-4" />
              Send another batch
            </button>

            {/* Per-patient results */}
            <div className="mt-5 rounded-xl border border-rule bg-white overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-rule/30 text-left text-[10px] uppercase tracking-wider text-ink-soft">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Patient</th>
                    <th className="px-4 py-2 font-semibold">Phone</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {result.rows.map((r) => (
                    <tr key={r.patientNodeId}>
                      <td className="px-4 py-2 text-ink">
                        {r.name ?? "(no name)"}
                      </td>
                      <td className="px-4 py-2 text-ink-soft text-xs">
                        {r.phone ?? "—"}
                      </td>
                      <td className="px-4 py-2">
                        <StatusChip status={r.status} message={r.errorMessage} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Picker view (hidden when result panel shows) */}
        {!result && (
          <>
            {/* Candidate stats + quick selects */}
            <section className="rounded-2xl border border-rule bg-white p-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-emerald-50 text-emerald-700 flex items-center justify-center">
                    <Users className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-ink">
                      {selectedIds.size} of {candidates.length} selected
                    </div>
                    <div className="text-xs text-ink-soft">
                      A-list patients with a phone number on file, sorted by
                      lifetime spend.
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleSelectTopN(5)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 px-3 py-1.5 text-xs font-medium hover:bg-emerald-100 transition"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Top 5
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectTopN(10)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 px-3 py-1.5 text-xs font-medium hover:bg-emerald-100 transition"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Top 10
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectTopN(20)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 px-3 py-1.5 text-xs font-medium hover:bg-emerald-100 transition"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Top 20
                  </button>
                  {selectedIds.size > 0 && (
                    <button
                      type="button"
                      onClick={handleClear}
                      className="text-xs text-ink-soft hover:text-ink px-2"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-ink-faint" />
                <input
                  type="text"
                  placeholder="Search by name or phone…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full rounded-lg border border-rule bg-white pl-10 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-200"
                />
              </div>
            </section>

            {/* Patient list */}
            <section className="rounded-2xl border border-rule bg-white overflow-hidden">
              {visible.length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-ink-soft">
                  {candidates.length === 0 ? (
                    <>
                      No A-list patients with a phone number yet. Tune your{" "}
                      <Link
                        to="/app/refill/patients/a-list-rules"
                        className="text-emerald-700 underline underline-offset-2"
                      >
                        A-list rules
                      </Link>{" "}
                      or import contacts first.
                    </>
                  ) : (
                    <>No patients match &ldquo;{query}&rdquo;.</>
                  )}
                </div>
              ) : (
                <ul className="divide-y divide-rule max-h-[420px] overflow-y-auto">
                  {visible.map((p) => {
                    const selected = selectedIds.has(p.id);
                    return (
                      <li key={p.id}>
                        <label className="flex items-center gap-3 px-5 py-2.5 hover:bg-rule-soft/40 cursor-pointer transition">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleOne(p.id)}
                            className="rounded border-rule shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-ink truncate">
                              {p.displayName}
                            </div>
                            <div className="text-xs text-ink-soft truncate">
                              {p.phone || "(no phone)"}
                            </div>
                          </div>
                          {p.lifetimeSpendUsd > 0 && (
                            <div className="text-xs text-ink-soft tabular-nums shrink-0">
                              ${Math.round(p.lifetimeSpendUsd).toLocaleString()}
                            </div>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Invite copy editor */}
            <section className="rounded-2xl border border-rule bg-white p-6 space-y-4">
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-ink inline-flex items-center gap-2">
                    <HeartHandshake className="h-4 w-4 text-emerald-700" />
                    Invite copy
                  </h2>
                  <p className="text-xs text-ink-soft mt-0.5">
                    {serverTemplateIsDefault
                      ? "Showing Refill's default copy. Edit and Save as default to make it yours."
                      : "Your saved default. Edit to override for this batch only, or Save as default to update it."}
                  </p>
                </div>
                {templateDirty && (
                  <button
                    type="button"
                    onClick={handleResetTemplate}
                    className="text-xs text-ink-soft hover:text-ink underline underline-offset-2"
                  >
                    Reset
                  </button>
                )}
              </div>

              <textarea
                value={inviteBody}
                onChange={(e) => setInviteBody(e.target.value)}
                rows={8}
                className="w-full rounded-lg border border-rule bg-paper px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-200 resize-y"
                placeholder="Hi {first_name}! It's {owner_name} from {spa_name}..."
              />

              <div className="text-[11px] text-ink-faint leading-relaxed">
                Tokens auto-fill per patient:{" "}
                <code className="bg-rule/40 px-1 rounded">{"{first_name}"}</code>
                {" · "}
                <code className="bg-rule/40 px-1 rounded">{"{owner_name}"}</code>
                {" · "}
                <code className="bg-rule/40 px-1 rounded">{"{spa_name}"}</code>
                {" · "}
                <code className="bg-rule/40 px-1 rounded">{"{opt_in_url}"}</code>
                . Include &ldquo;Reply STOP&rdquo; somewhere for TCPA.
              </div>

              {previewBody && (
                <div className="rounded-lg border border-rule bg-paper px-4 py-3">
                  <div className="text-[10px] uppercase tracking-wider text-ink-faint font-semibold mb-1.5">
                    Preview (first selected patient)
                  </div>
                  <pre className="text-sm text-ink whitespace-pre-wrap font-sans leading-relaxed">
                    {previewBody}
                  </pre>
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-2 border-t border-rule/60">
                <button
                  type="button"
                  onClick={handleSaveTemplate}
                  disabled={
                    savingTemplate ||
                    !templateDirty ||
                    inviteBody.trim().length < 20
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium text-ink-soft hover:bg-rule-soft hover:text-ink transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {savingTemplate ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    "Save as default"
                  )}
                </button>
              </div>
            </section>

            {/* Send action */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-700 text-white px-5 py-2.5 text-sm font-semibold hover:bg-emerald-800 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Drafting {selectedIds.size} invite
                    {selectedIds.size === 1 ? "" : "s"}…
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" />
                    Draft {selectedIds.size > 0
                      ? `${selectedIds.size} invite${selectedIds.size === 1 ? "" : "s"}`
                      : "invites"}{" "}
                    in my inbox
                  </>
                )}
              </button>
              <span className="text-xs text-ink-soft max-w-md leading-relaxed">
                Creates paused waitlist rows and composes one iMessage draft per
                patient. Patients flip paused → active when they tap the link.
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function StatusChip({
  status,
  message,
}: {
  status:
    | "sent"
    | "skipped_already_on_waitlist"
    | "skipped_no_phone"
    | "skipped_banned_or_opted_out"
    | "error";
  message: string | null;
}) {
  if (status === "sent") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[10px] font-medium">
        <CheckCircle2 className="h-3 w-3" />
        Drafted
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        title={message ?? undefined}
        className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-800 px-2 py-0.5 text-[10px] font-medium"
      >
        <XCircle className="h-3 w-3" />
        Error
      </span>
    );
  }
  const label =
    status === "skipped_already_on_waitlist"
      ? "Already on waitlist"
      : status === "skipped_no_phone"
        ? "No phone"
        : "Banned/opted out";
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber/10 text-amber border border-amber/30 px-2 py-0.5 text-[10px] font-medium">
      <AlertCircle className="h-3 w-3" />
      {label}
    </span>
  );
}
