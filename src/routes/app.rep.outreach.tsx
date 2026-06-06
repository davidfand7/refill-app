/**
 * /app/rep/outreach — Phase 2E rep-facing outreach surface (v397).
 *
 * Read-only browse of the shared template library + a "Send to a spa"
 * mini-form. Pure rep-facing UI: no edit, no bulk import, no version
 * history. The admin surface at /app/admin/outreach owns those.
 *
 * Flow:
 *   1. Rep lands on the page → list templates grouped by ICP.
 *   2. Picks a template → side panel opens with subject/body preview.
 *   3. Fills recipient email + first name + spa name (+ optional context).
 *   4. Hits Send → server fn validates rep-or-admin, fires the pipeline.
 *      When OUTREACH_LIVE=true on the worker, Resend POSTs; otherwise the
 *      send stays in dry_run mode (per project_outreach_paused) and the
 *      UI shows the rendered preview as audit.
 *
 * The From: line shows the rep's display name when sent by a rep — Kelly
 * appears in the spa owner's inbox, not "Karen Anderson". sent_by on the
 * engagement row attributes the send for the commission cascade.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Link2, Save, Send, Upload, UserPlus, X } from "lucide-react";
import { z } from "zod";

import { TemplateEditor } from "@/components/refill/TemplateEditor";
import {
  RecipientBulkImport,
  type ImportRecipient,
} from "@/components/refill/RecipientBulkImport";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getAdminViewAsUserId } from "@/lib/admin-view-as";
import { useAuth } from "@/lib/auth";
import {
  getMyRepAccount,
  type RepAccountRow,
} from "@/server/rep-platform";
import {
  listMyOutreachSends,
  listOutreachTemplates,
  saveAsRepTemplate,
  type OutreachSendRow,
  type OutreachTemplate,
} from "@/server/refill-outreach";
import {
  getMyRecruitStats,
  getOutreachSendMode,
} from "@/server/refill-outreach-send";
import {
  deleteOutreachDraft,
  listOutreachDrafts,
  saveOutreachDraft,
  saveOutreachDraftsBulk,
  sendOutreachBatch,
  type OutreachDraft,
} from "@/server/refill-outreach-drafts";

// v407 Pinch #16: URL-param pre-fill schema. Any link can deep-link a
// pre-populated send via /app/rep/outreach?to=&firstName=&spaName=&icp=&channel=.
// All params optional + tolerant — bad/missing values are ignored, the form
// just renders empty for those fields. Strings are length-capped to keep the
// URL from blowing up on paste/copy.
const outreachSearchSchema = z.object({
  to: z.string().email().max(120).optional(),
  firstName: z.string().min(1).max(80).optional(),
  spaName: z.string().min(1).max(120).optional(),
  icp: z.coerce.number().int().min(1).max(3).optional(),
  channel: z.string().min(1).max(40).optional(),
  // v1.47.0 P3a: which book is open. prospects = rep→spa (audience 'spa'),
  // recruits = rep→rep (audience 'rep'). /app/rep/recruit redirects here with
  // tab=recruits.
  tab: z.enum(["prospects", "recruits"]).optional(),
});

export const Route = createFileRoute("/app/rep/outreach")({
  validateSearch: (search: Record<string, unknown>) =>
    outreachSearchSchema.parse(search),
  component: OutreachPage,
});

// v407 Pinch #16: smart defaults for the two fields that are effectively
// constants per-spa (Rejuv's recovered $ + how long Refill has been running).
// Reps shouldn't retype these on every send. Surfaces as placeholder values
// AND as initial form state so a Send-without-typing fires with real numbers.
// When Karen's actual figures update, change these constants — or in a future
// ship promote them to a per-rep tenant config column.
const REJUV_RECOVERED_DEFAULT = "12,400";
const REJUV_RECOVERED_WEEKS_DEFAULT = "8";

// v1.47.7: localStorage key for the per-(audience, template) shared composer
// body, so a composed message survives refresh / navigation.
function sharedBodyKey(audience: "spa" | "rep", templateId: string): string {
  return `refill:sharedbody:${audience}:${templateId}`;
}

// v1.47.0 P3a: live recruit-pitch stats (rep audience only). Rendered as chips
// so the rep sees exactly what substitutes into [my commission rate] /
// [my month earnings] / [my downstream count] before sending.
type RecruitStats = {
  myCommissionRate: string;
  myMonthEarnings: string | null;
  myDownstreamCount: string | null;
};

// v1.44 client-side preview substitution. Mirrors the spa-outreach subset of
// the server-side substitutePlaceholders in refill-outreach-send.ts — empty
// values leave the literal placeholder so the rep can see gaps in the preview
// (same discipline as the server: never silently render "$" or "0 weeks").
function applyOutreachSubstitutions(
  text: string,
  ctx: {
    firstName?: string;
    spaName?: string;
    rejuvRecoveredAmount?: string;
    rejuvRecoveredWeeks?: string;
  },
): string {
  let out = text;
  if (ctx.firstName) {
    out = out.replace(/\[first name\]/gi, ctx.firstName);
    out = out.replace(/\[name\]/gi, ctx.firstName);
  }
  if (ctx.spaName) out = out.replace(/\[spa name\]/gi, ctx.spaName);
  if (ctx.rejuvRecoveredAmount)
    out = out.replace(/\$\[exact figure\]/gi, ctx.rejuvRecoveredAmount);
  if (ctx.rejuvRecoveredWeeks)
    out = out.replace(/\[N\] weeks/gi, ctx.rejuvRecoveredWeeks);
  return out;
}

function OutreachPage() {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;
  // v407 Pinch #16: read URL params for form pre-fill. validateSearch above
  // already coerced + bounded the values; anything missing comes back undefined.
  const prefill = Route.useSearch();

  // v1.47.0 P3a: which book is open — 'spa' (Prospects) or 'rep' (Recruits).
  // Scopes templates, sends, drafts, and stats. Initial from the URL tab param
  // (so /app/rep/recruit can redirect here as ?tab=recruits).
  const [audience, setAudience] = useState<"spa" | "rep">(
    prefill.tab === "recruits" ? "rep" : "spa",
  );
  const [stats, setStats] = useState<RecruitStats | null>(null);

  const [rep, setRep] = useState<RepAccountRow | null>(null);
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<OutreachTemplate | null>(null);
  // v404 Pinch #14b: pre-click send-mode affordance. Null until resolved.
  const [liveEnabled, setLiveEnabled] = useState<boolean | null>(null);
  // v405.3 Pinch #13: past-sends history. Refetched after every send so the
  // panel updates without a page reload.
  const [sends, setSends] = useState<OutreachSendRow[]>([]);
  // v1.47.0 fold: the composer holds only SHARED context now — the Rejuv
  // figures that apply to the whole batch. Per-recipient email/name/spa live
  // on the roster (via the + Recipient dialog / upload), not here.
  const [form, setForm] = useState({
    rejuvRecoveredAmount: REJUV_RECOVERED_DEFAULT,
    rejuvRecoveredWeeks: REJUV_RECOVERED_WEEKS_DEFAULT,
  });
  // v1.44 → v1.47 shared-body overrides. null = use template default; string =
  // rep edited the SHARED body. Reset on template change so each template
  // starts from its own default. Untweaked recipients float on this body.
  const [subjectOverride, setSubjectOverride] = useState<string | null>(null);
  const [bodyOverride, setBodyOverride] = useState<string | null>(null);
  // v1.47.0: the rep's saved drafts = the roster (one row per recipient+template).
  const [drafts, setDrafts] = useState<OutreachDraft[]>([]);
  // v1.47.0 P2→P3: batch send of the whole roster.
  const [sendingBatch, setSendingBatch] = useState(false);
  const [batchResult, setBatchResult] = useState<{
    sent: number;
    failed: number;
    total: number;
  } | null>(null);
  // v1.47.8: save-as-template. mode 'save' = standalone save; mode 'send' =
  // prompted on Send all when the body's been edited (save then send).
  const [saveTplOpen, setSaveTplOpen] = useState(false);
  const [saveTplMode, setSaveTplMode] = useState<"save" | "send">("save");
  const [savingTpl, setSavingTpl] = useState(false);
  // v1.47.7: the fold left the shared composer body as ephemeral state — edit
  // it, refresh, and it was gone (no Save persisted it). Autosave the shared
  // subject/body per (audience, template) to localStorage so composing sticks.
  // On template/tab change, restore any saved draft for that slot; else clear.
  useEffect(() => {
    setBatchResult(null);
    if (!selected || typeof window === "undefined") {
      setSubjectOverride(null);
      setBodyOverride(null);
      return;
    }
    try {
      const raw = window.localStorage.getItem(sharedBodyKey(audience, selected.id));
      if (raw) {
        const saved = JSON.parse(raw) as {
          subjectOverride?: string | null;
          bodyOverride?: string | null;
        };
        setSubjectOverride(saved.subjectOverride ?? null);
        setBodyOverride(saved.bodyOverride ?? null);
        return;
      }
    } catch {
      // Corrupt/blocked storage — fall through to a clean slate.
    }
    setSubjectOverride(null);
    setBodyOverride(null);
  }, [selected?.id, audience]);

  // Autosave the shared composer body as the rep types. Clears the slot when
  // both overrides are null (back to the template default).
  useEffect(() => {
    if (!selected || typeof window === "undefined") return;
    const key = sharedBodyKey(audience, selected.id);
    try {
      if (subjectOverride === null && bodyOverride === null) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(
          key,
          JSON.stringify({ subjectOverride, bodyOverride }),
        );
      }
    } catch {
      // Storage full/blocked — non-fatal; the body still works in-session.
    }
  }, [subjectOverride, bodyOverride, selected?.id, audience]);

  useEffect(() => {
    if (authLoading) return;
    if (!accessToken) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const viewAsUserId =
          typeof window !== "undefined" ? getAdminViewAsUserId() : undefined;
        const [repRes, tplRes, modeRes, sendsRes, draftsRes, statsRes] =
          await Promise.all([
            getMyRepAccount({ data: { accessToken, viewAsUserId } }),
            // v1.47.0 P3a: templates scoped to the active book's audience.
            listOutreachTemplates({ data: { accessToken, audience } }).catch(
              () => ({ templates: [] }),
            ),
            // v404 Pinch #14b: fetch send-mode alongside profile/templates so
            // the button labels render correctly on first paint, not after a
            // post-click reveal. Fail-soft to dry-run framing if it errors.
            getOutreachSendMode({ data: { accessToken } }).catch(() => ({
              liveEnabled: false,
            })),
            // v405.3 Pinch #13 + P3a: past-sends scoped to this book's purpose.
            listMyOutreachSends({
              data: {
                accessToken,
                purpose: audience === "rep" ? "rep_recruit" : "spa_outreach",
              },
            }).catch(() => ({ sends: [] })),
            // v1.47.0 P1 + P3a: this rep's saved drafts for the active audience.
            listOutreachDrafts({ data: { accessToken, audience } }).catch(
              () => ({ drafts: [] }),
            ),
            // v1.47.0 P3a: recruit-pitch stats (used only by the Recruits tab;
            // fetched unconditionally so a tab switch has them ready).
            getMyRecruitStats({ data: { accessToken } }).catch(() => ({
              myCommissionRate: "3%",
              myMonthEarnings: null,
              myDownstreamCount: null,
            })),
          ]);
        if (cancelled) return;
        setRep(repRes.rep);
        setTemplates(tplRes.templates);
        setLiveEnabled(modeRes.liveEnabled);
        setSends(sendsRes.sends);
        setDrafts(draftsRes.drafts);
        setStats(statsRes);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Couldn't load outreach.",
          );
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, accessToken, audience]);

  // v1.47.0 P3a: switching books clears the selected template + any send/batch
  // result so a Prospects template never lingers on the Recruits tab.
  useEffect(() => {
    setSelected(null);
    setBatchResult(null);
  }, [audience]);

  // v1.47.8: the global library groups by ICP; the rep's own saved templates
  // get their own "My templates" section (shown by name, not channel).
  const grouped = useMemo(
    () => groupByIcp(templates.filter((t) => !t.ownerRepUserId)),
    [templates],
  );
  const myTemplates = useMemo(
    () => templates.filter((t) => t.ownerRepUserId),
    [templates],
  );

  // v407 Pinch #16: auto-select template when the URL specifies icp + channel.
  // Runs after templates load (the auto-pick can't happen until the library
  // is in state). Guarded by `selected` so a manual deselect doesn't get
  // reverted on re-render.
  useEffect(() => {
    if (selected || !templates.length) return;
    if (prefill.icp == null || !prefill.channel) return;
    const match = templates.find(
      (t) => t.icp === prefill.icp && t.channel === prefill.channel,
    );
    if (match) setSelected(match);
  }, [templates, prefill.icp, prefill.channel, selected]);

  // v1.47.0 P2→P3: dry-run send every unsent saved draft for the
  // selected template. Forces dryRun:true so this gate never fires real email.
  // Shared subject/body = the composer's current overrides (null/untouched =>
  // the dispatch helper falls to the template default per recipient).
  const handleSendBatch = async () => {
    if (!accessToken || !selected || sendingBatch) return;
    setSendingBatch(true);
    setError(null);
    setBatchResult(null);
    try {
      const res = await sendOutreachBatch({
        data: {
          accessToken,
          templateId: selected.id,
          icp: selected.icp,
          channel: selected.channel,
          audience: selected.audience,
          sharedSubject: subjectOverride ?? undefined,
          sharedBody: bodyOverride ?? undefined,
          // Shared context only; per-recipient spa name comes from each draft row.
          context: {
            rejuvRecoveredAmount: form.rejuvRecoveredAmount || undefined,
            rejuvRecoveredWeeks: form.rejuvRecoveredWeeks || undefined,
          },
          sourceContext: rep ? `rep:${rep.displayName}` : undefined,
          dryRun: true,
        },
      });
      setBatchResult({ sent: res.sent, failed: res.failed, total: res.total });
      // Refresh drafts (sent ones now stamped) + sends history.
      try {
        const [draftsRes, sendsRes] = await Promise.all([
          listOutreachDrafts({ data: { accessToken, audience } }),
          listMyOutreachSends({
            data: {
              accessToken,
              purpose: audience === "rep" ? "rep_recruit" : "spa_outreach",
            },
          }),
        ]);
        setDrafts(draftsRes.drafts);
        setSends(sendsRes.sends);
      } catch {
        // Non-fatal — next load picks it up.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Batch send failed.");
    } finally {
      setSendingBatch(false);
    }
  };

  // v1.47.0 P3b: roster mutations. Add = save a draft with null overrides (the
  // recipient floats on the shared body). Tweak = save a per-account
  // body_override. Reset = clear it. Remove = delete the draft row. Each keeps
  // the local drafts state in sync so the roster updates without a refetch.
  const handleAddRecipient = async (r: RosterRecipient) => {
    if (!accessToken || !selected) return;
    const { draft } = await saveOutreachDraft({
      data: {
        accessToken,
        templateId: selected.id,
        icp: selected.icp,
        channel: selected.channel,
        audience: selected.audience,
        recipientEmail: r.email,
        recipientFirstName: r.firstName || null,
        spaName: r.spaName || null,
        subjectOverride: null,
        bodyOverride: null,
      },
    });
    setDrafts((prev) => [draft, ...prev.filter((d) => d.id !== draft.id)]);
  };

  const persistDraftOverride = async (
    draft: OutreachDraft,
    bodyOverride: string | null,
  ) => {
    if (!accessToken) return;
    const { draft: updated } = await saveOutreachDraft({
      data: {
        accessToken,
        templateId: draft.templateId,
        icp: draft.icp,
        channel: draft.channel,
        audience: draft.audience,
        recipientEmail: draft.recipientEmail,
        recipientFirstName: draft.recipientFirstName,
        spaName: draft.spaName,
        subjectOverride: draft.subjectOverride,
        bodyOverride,
      },
    });
    setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
  };

  const handleTweakSave = (draft: OutreachDraft, bodyOverride: string) =>
    persistDraftOverride(draft, bodyOverride);
  const handleResetTweak = (draft: OutreachDraft) =>
    persistDraftOverride(draft, null);

  const handleRemoveRecipient = async (draft: OutreachDraft) => {
    if (!accessToken) return;
    await deleteOutreachDraft({ data: { accessToken, id: draft.id } });
    setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
  };

  // v1.47.0 P4: bulk add from paste/CSV. on-conflict-do-nothing means a
  // re-paste never clobbers a tweaked override. Refetch the roster afterward
  // so the new rows appear (bulk insert returns only the newly-added rows).
  const handleBulkImport = async (
    recipients: ImportRecipient[],
  ): Promise<{ inserted: number; skipped: number }> => {
    if (!accessToken || !selected) return { inserted: 0, skipped: 0 };
    const res = await saveOutreachDraftsBulk({
      data: {
        accessToken,
        templateId: selected.id,
        icp: selected.icp,
        channel: selected.channel,
        audience: selected.audience,
        recipients,
      },
    });
    try {
      const { drafts: latest } = await listOutreachDrafts({
        data: { accessToken, audience },
      });
      setDrafts(latest);
    } catch {
      // Non-fatal — next load picks it up.
    }
    return { inserted: res.inserted, skipped: res.skipped };
  };

  // v1.47.8: clicking Send all when the shared body has been edited prompts to
  // save it as a reusable template first; an unedited send goes straight through.
  const handleSendAllClick = () => {
    const edited = subjectOverride !== null || bodyOverride !== null;
    if (edited) {
      setSaveTplMode("send");
      setSaveTplOpen(true);
    } else {
      handleSendBatch();
    }
  };

  // v1.47.8: persist the edited message as a rep-private named template. In
  // 'send' mode (prompted from Send all) it then dispatches the batch; in
  // 'save' mode (standalone button) it switches to the freshly-saved template.
  const handleSaveTemplate = async (name: string) => {
    if (!accessToken || !selected || savingTpl) return;
    setSavingTpl(true);
    setError(null);
    try {
      const tpl = await saveAsRepTemplate({
        data: {
          accessToken,
          icp: selected.icp,
          audience: selected.audience,
          name,
          subject: subjectOverride !== null ? subjectOverride : selected.subject,
          body: bodyOverride ?? selected.body,
        },
      });
      // Refresh the library so "My templates" shows the new one.
      try {
        const { templates: latest } = await listOutreachTemplates({
          data: { accessToken, audience },
        });
        setTemplates(latest);
      } catch {
        // Non-fatal — next load picks it up.
      }
      setSaveTplOpen(false);
      if (saveTplMode === "send") {
        await handleSendBatch();
      } else {
        // Save-only: switch to the freshly-saved template (its body IS the edit),
        // clearing the overrides + the old autosave slot for a clean slate.
        if (typeof window !== "undefined") {
          try {
            window.localStorage.removeItem(sharedBodyKey(selected.audience, selected.id));
          } catch {
            // ignore
          }
        }
        setSubjectOverride(null);
        setBodyOverride(null);
        setSelected(tpl);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save template.");
    } finally {
      setSavingTpl(false);
    }
  };

  if (authLoading || !loaded) {
    return <Pulse label="Loading outreach…" />;
  }

  if (!accessToken) {
    return (
      <Page>
        <Heading>Outreach</Heading>
        <Lede>Sign in to access the outreach library.</Lede>
      </Page>
    );
  }

  if (!rep) {
    return (
      <Page>
        <Heading>Outreach</Heading>
        <Lede>
          Set up your rep profile to use the outreach library. Every send is
          attributed to you, so the spa owner sees your name — not a generic
          Refill persona.
        </Lede>
        <Link
          to="/app/rep/referral-links"
          className="inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition"
          style={{ background: "#056048", color: "#fbfaf7" }}
        >
          Set up rep profile
        </Link>
      </Page>
    );
  }

  return (
    <Page wide>
      <OutreachTabs audience={audience} onChange={setAudience} />

      {audience === "rep" ? (
        <>
          <Heading>Recruit reps</Heading>
          <Lede>
            Invite peer reps into your downstream. You earn{" "}
            <strong>1% cascade, lifetime</strong>, on every dollar of recovered
            revenue from spas your sub-reps introduce — on top of your own 3%
            direct rate. The compounding scales beyond your own hours.
          </Lede>
          {stats && <RecruitStatsBar stats={stats} />}
        </>
      ) : (
        <>
          <Heading>Outreach</Heading>
          <Lede>
            Pick a template, fill in the prospect&apos;s details, and the email
            goes out as <strong>{rep.displayName}</strong>. Replies route back
            through the platform so you can track conversion.
          </Lede>
        </>
      )}

      {templates.length === 0 ? (
        <EmptyTemplates />
      ) : (
        <div className="grid md:grid-cols-[1fr_1fr] gap-6 mt-6">
          {/* Left column: template grid */}
          <div className="space-y-5">
            {[1, 2, 3].map((icp) => {
              const tpls = grouped.get(icp) ?? [];
              if (tpls.length === 0) return null;
              return (
                <IcpSection
                  key={icp}
                  icp={icp}
                  audience={audience}
                  templates={tpls}
                  selectedId={selected?.id}
                  onPick={(t) => {
                    setSelected(t);
                    setError(null);
                  }}
                />
              );
            })}
            {myTemplates.length > 0 && (
              <MyTemplatesSection
                templates={myTemplates}
                selectedId={selected?.id}
                onPick={(t) => {
                  setSelected(t);
                  setError(null);
                }}
              />
            )}
            {audience === "rep" && <ShareLinkAffordance />}
          </div>

          {/* Right column: detail + send */}
          <div className="md:sticky md:top-6 self-start">
            {selected ? (
              <>
                <SendPanel
                  template={selected}
                  audience={audience}
                  form={form}
                  onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
                  onClose={() => setSelected(null)}
                  subjectOverride={subjectOverride}
                  bodyOverride={bodyOverride}
                  onSubjectOverrideChange={setSubjectOverride}
                  onBodyOverrideChange={setBodyOverride}
                  onSaveAsTemplate={() => {
                    setSaveTplMode("save");
                    setSaveTplOpen(true);
                  }}
                />
                <RecipientRoster
                  audience={audience}
                  template={selected}
                  roster={drafts.filter(
                    (d) => d.templateId === selected.id && !d.sentAt,
                  )}
                  sharedSubjectOverride={subjectOverride}
                  sharedBodyOverride={bodyOverride}
                  liveEnabled={liveEnabled}
                  sendingBatch={sendingBatch}
                  batchResult={batchResult}
                  onAddRecipient={handleAddRecipient}
                  onBulkImport={handleBulkImport}
                  onTweakSave={handleTweakSave}
                  onResetTweak={handleResetTweak}
                  onRemove={handleRemoveRecipient}
                  onSendAll={handleSendAllClick}
                />
              </>
            ) : (
              <Hint>Pick a template on the left to see the preview.</Hint>
            )}
          </div>
        </div>
      )}

      {error && (
        <div
          className="mt-4 rounded-md px-3 py-2 text-[13px]"
          style={{ background: "#fdecec", color: "#8a1616" }}
        >
          {error}
        </div>
      )}

      {/* v405.3 Pinch #13: past-sends panel. Surfaces the rep's outreach
          history below the template grid so every visit to /outreach is
          aware of prior work — no more first-touch-every-time feel. */}
      {sends.length > 0 && <PastSendsPanel sends={sends} />}

      <SaveTemplateDialog
        open={saveTplOpen}
        mode={saveTplMode}
        busy={savingTpl}
        onClose={() => setSaveTplOpen(false)}
        onSave={handleSaveTemplate}
        onSendWithoutSaving={() => {
          setSaveTplOpen(false);
          handleSendBatch();
        }}
      />
    </Page>
  );
}

function PastSendsPanel({ sends }: { sends: OutreachSendRow[] }) {
  return (
    <div
      className="mt-10 rounded-xl border bg-white"
      style={{ borderColor: "#e6e2d6" }}
    >
      <div
        className="flex items-center justify-between px-5 py-3 border-b"
        style={{ borderColor: "#f0ebe0", background: "#fbfaf7" }}
      >
        <h2
          className="text-[14px] font-semibold tracking-tight"
          style={{ color: "#1c2024" }}
        >
          Your recent sends
        </h2>
        <span
          className="text-[11px] uppercase tracking-wider font-semibold"
          style={{ color: "#8a9098" }}
        >
          {sends.length} {sends.length === 1 ? "send" : "sends"}
        </span>
      </div>
      <ul className="divide-y" style={{ borderColor: "#f0ebe0" }}>
        {sends.map((s) => (
          <PastSendRow key={s.id} send={s} />
        ))}
      </ul>
    </div>
  );
}

function PastSendRow({ send }: { send: OutreachSendRow }) {
  const recipientLabel =
    send.recipientFirstName
      ? `${send.recipientFirstName} · ${send.recipientEmail}`
      : send.recipientEmail;
  return (
    <li className="flex items-center justify-between gap-4 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div
          className="text-[13px] font-medium truncate"
          style={{ color: "#1c2024" }}
        >
          {recipientLabel}
        </div>
        <div
          className="text-[12px] mt-0.5 truncate"
          style={{ color: "#8a9098" }}
        >
          ICP {send.icp} · {send.channel}
          {send.renderedSubject ? ` · "${send.renderedSubject}"` : ""}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <ConversionPills send={send} />
        <SendModeBadge mode={send.sendMode} />
        <span
          className="text-[12px] tabular-nums"
          style={{ color: "#8a9098" }}
        >
          {formatRelativeShort(send.sentAt)}
        </span>
      </div>
    </li>
  );
}

function ConversionPills({ send }: { send: OutreachSendRow }) {
  return (
    <>
      {send.convertedAt ? (
        <span
          className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5"
          style={{ background: "#e8f3ed", color: "#056048" }}
        >
          Converted
        </span>
      ) : send.responseReceivedAt ? (
        <span
          className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5"
          style={{ background: "#e8f3ed", color: "#056048" }}
        >
          Replied
        </span>
      ) : send.openedAt ? (
        <span
          className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5"
          style={{ background: "#fdf6e6", color: "#8a6d10" }}
        >
          Opened
        </span>
      ) : null}
    </>
  );
}

function SendModeBadge({ mode }: { mode: string }) {
  const palette =
    mode === "live"
      ? { bg: "#fde8e8", fg: "#b91c1c" }
      : mode === "test"
        ? { bg: "#fdf6e6", fg: "#8a6d10" }
        : { bg: "#f0ebe0", fg: "#5a6068" };
  const label = mode === "live" ? "Live" : mode === "test" ? "Test" : "Dry-run";
  return (
    <span
      className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5"
      style={{ background: palette.bg, color: palette.fg }}
    >
      {label}
    </span>
  );
}

function formatRelativeShort(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// ─── v1.47.8: the rep's own saved templates (shown by name, not channel) ──
function MyTemplatesSection({
  templates,
  selectedId,
  onPick,
}: {
  templates: OutreachTemplate[];
  selectedId?: string;
  onPick: (t: OutreachTemplate) => void;
}) {
  return (
    <div>
      <div
        className="text-[11px] uppercase tracking-wider font-semibold mb-2"
        style={{ color: "#8a9098" }}
      >
        My templates
      </div>
      <div className="space-y-2">
        {templates.map((t) => {
          const isSelected = t.id === selectedId;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onPick(t)}
              className="w-full text-left rounded-lg border p-3 transition hover:shadow-sm"
              style={{
                borderColor: isSelected ? "#056048" : "#e6e2d6",
                background: isSelected ? "#f0f5ef" : "#fff",
                boxShadow: isSelected ? "0 0 0 2px rgba(5,96,72,0.12)" : undefined,
              }}
            >
              <div className="text-[13px] font-semibold" style={{ color: "#1c2024" }}>
                {t.name ?? t.channel}
              </div>
              <div className="text-[12px] mt-0.5" style={{ color: "#8a9098" }}>
                Saved template · ICP {t.icp}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── v1.47.8: name-and-save an edited message as a rep-private template ───
function SaveTemplateDialog({
  open,
  mode,
  busy,
  onClose,
  onSave,
  onSendWithoutSaving,
}: {
  open: boolean;
  mode: "save" | "send";
  busy: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
  onSendWithoutSaving: () => void;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif">
            {mode === "send" ? "Save your edited message?" : "Save as template"}
          </DialogTitle>
          <DialogDescription>
            {mode === "send"
              ? "You've edited this template. Name it to keep it as a reusable template — or send this batch without saving."
              : "Give your edited message a name. It'll show under “My templates” so you can reuse it anytime."}
          </DialogDescription>
        </DialogHeader>
        <div className="py-1">
          <Field
            label="Template name"
            value={name}
            onChange={setName}
            placeholder="e.g. Skinnovations intro"
          />
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={mode === "send" ? onSendWithoutSaving : onClose}
            disabled={busy}
            className="rounded-md border px-4 py-2 text-[13px] font-semibold transition hover:bg-[#fbfaf7] disabled:opacity-50"
            style={{ borderColor: "#e6e2d6", background: "#fff", color: "#1c2024" }}
          >
            {mode === "send" ? "Send without saving" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => onSave(name.trim())}
            disabled={busy || !name.trim()}
            className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "#056048", color: "#fbfaf7" }}
          >
            <Save className="h-3.5 w-3.5" />
            {busy ? "Saving…" : mode === "send" ? "Save & send" : "Save template"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── v1.47.0 P3a: Prospects / Recruits tab bar ───────────────────────────
function OutreachTabs({
  audience,
  onChange,
}: {
  audience: "spa" | "rep";
  onChange: (a: "spa" | "rep") => void;
}) {
  const tabs: { key: "spa" | "rep"; label: string }[] = [
    { key: "spa", label: "Prospects" },
    { key: "rep", label: "Recruits" },
  ];
  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border p-1 mb-5"
      style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
      role="tablist"
      aria-label="Outreach book"
    >
      {tabs.map((t) => {
        const active = audience === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className="rounded-md px-4 py-1.5 text-[13px] font-semibold transition"
            style={{
              background: active ? "#fff" : "transparent",
              color: active ? "#056048" : "#8a9098",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : undefined,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── v1.47.0 P3a: recruit-pitch live-stat chips (Recruits tab only) ───────
function RecruitStatsBar({ stats }: { stats: RecruitStats }) {
  return (
    <div
      className="mt-5 flex flex-wrap items-center gap-2"
      role="status"
      aria-label="Your live recruit pitch stats"
    >
      <StatChip label="[my commission rate]" value={stats.myCommissionRate} accent />
      <StatChip
        label="[my month earnings]"
        value={stats.myMonthEarnings ? `$${stats.myMonthEarnings}` : "—"}
        muted={!stats.myMonthEarnings}
      />
      <StatChip
        label="[my downstream count]"
        value={stats.myDownstreamCount ?? "—"}
        muted={!stats.myDownstreamCount}
      />
    </div>
  );
}

function StatChip({
  label,
  value,
  accent,
  muted,
}: {
  label: string;
  value: string;
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className="inline-flex items-baseline gap-2 rounded-full border px-3 py-1"
      style={{
        background: accent ? "#e8f3ed" : muted ? "#fbfaf7" : "#fff",
        borderColor: accent ? "#cfe4d8" : "#e6e2d6",
      }}
    >
      <span
        className="text-[10px] uppercase tracking-wider font-mono"
        style={{ color: "#8a9098" }}
      >
        {label}
      </span>
      <span
        className="text-[13px] font-semibold tabular-nums"
        style={{ color: accent ? "#056048" : muted ? "#8a9098" : "#1c2024" }}
      >
        {value}
      </span>
    </div>
  );
}

function ShareLinkAffordance() {
  return (
    <Link
      to="/app/rep/referral-links"
      className="block rounded-lg border p-4 transition hover:shadow-sm"
      style={{
        borderColor: "#e6e2d6",
        background: "#fbfaf7",
        borderStyle: "dashed",
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
          style={{ background: "#e8f3ed", color: "#056048" }}
        >
          <Link2 className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div
            className="text-[13px] font-semibold mb-0.5"
            style={{ color: "#1c2024" }}
          >
            Or just share your link
          </div>
          <div
            className="text-[12px] leading-[1.5]"
            style={{ color: "#5a6068" }}
          >
            iMessage, Slack DM, Instagram, in person — every channel that
            isn&apos;t email. Grab the short URL and send.
          </div>
        </div>
      </div>
    </Link>
  );
}

function groupByIcp(
  templates: OutreachTemplate[],
): Map<number, OutreachTemplate[]> {
  const map = new Map<number, OutreachTemplate[]>();
  for (const t of templates) {
    const list = map.get(t.icp) ?? [];
    list.push(t);
    map.set(t.icp, list);
  }
  return map;
}

function IcpSection({
  icp,
  audience,
  templates,
  selectedId,
  onPick,
}: {
  icp: number;
  audience: "spa" | "rep";
  templates: OutreachTemplate[];
  selectedId?: string;
  onPick: (t: OutreachTemplate) => void;
}) {
  // v1.47.0 P3a: ICP labels differ by book. Prospects (spa) = the spa-outreach
  // ladder; Recruits (rep) = peer-rep warmth.
  const label =
    audience === "rep"
      ? icp === 1
        ? "ICP 1 · warm peer"
        : icp === 2
          ? "ICP 2 · cold peer"
          : "ICP 3"
      : icp === 1
        ? "ICP 1 · warm intro"
        : icp === 2
          ? "ICP 2 · cold spa"
          : "ICP 3 · Acuity-detected";
  return (
    <div>
      <div
        className="text-[11px] uppercase tracking-wider font-semibold mb-2"
        style={{ color: "#8a9098" }}
      >
        {label}
      </div>
      <div className="space-y-2">
        {templates.map((t) => {
          const isSelected = t.id === selectedId;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onPick(t)}
              className="w-full text-left rounded-lg border p-3 transition hover:shadow-sm"
              style={{
                borderColor: isSelected ? "#056048" : "#e6e2d6",
                background: isSelected ? "#f0f5ef" : "#fff",
                boxShadow: isSelected
                  ? "0 0 0 2px rgba(5,96,72,0.12)"
                  : undefined,
              }}
            >
              <div
                className="text-[13px] font-semibold mb-0.5"
                style={{ color: "#1c2024" }}
              >
                {t.channel}
              </div>
              <div
                className="text-[12px] truncate"
                style={{ color: "#5a6068" }}
              >
                {t.subject ?? "(no subject — Loom-style channel)"}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── v1.47.0 P3b: recipient roster ───────────────────────────────────────
// The real multi-recipient list for the selected template (edit model A).
// Each row is a saved draft; rows with a body_override carry the "edited"
// badge. + Recipient opens a dialog to stack recipients one at a time
// (infinite add). Tweak expands an inline editor that saves a per-account
// override. Send all fires the whole roster through sendOutreachBatch.

type RosterRecipient = { email: string; firstName: string; spaName: string };

function AddRecipientDialog({
  open,
  audience,
  onClose,
  onAdd,
}: {
  open: boolean;
  audience: "spa" | "rep";
  onClose: () => void;
  onAdd: (r: RosterRecipient) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [spaName, setSpaName] = useState("");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  // Reset the running counter each time the dialog re-opens.
  useEffect(() => {
    if (open) {
      setAdded(0);
      setErr(null);
    }
  }, [open]);

  const save = async (): Promise<boolean> => {
    const e = email.trim().toLowerCase();
    if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      setErr("Enter a valid email.");
      return false;
    }
    setAdding(true);
    setErr(null);
    try {
      await onAdd({ email: e, firstName: firstName.trim(), spaName: spaName.trim() });
      setAdded((n) => n + 1);
      setEmail("");
      setFirstName("");
      setSpaName("");
      return true;
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Couldn't add recipient.");
      return false;
    } finally {
      setAdding(false);
    }
  };

  // v1.47.10: "Done" must COMMIT the current entry, not discard it. If there's
  // something typed, save it (validation blocks close on a bad email); if the
  // form is empty, just close.
  const done = async () => {
    if (!email.trim()) {
      onClose();
      return;
    }
    if (await save()) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif">Add recipient</DialogTitle>
          <DialogDescription>
            {audience === "rep"
              ? "Add a peer rep to this batch. Save & add another to keep stacking."
              : "Add a spa to this batch. Save & add another to keep stacking."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <Field
            label="Recipient email"
            value={email}
            onChange={setEmail}
            placeholder="kelly@example.com"
            type="email"
          />
          <Field
            label="First name"
            value={firstName}
            onChange={setFirstName}
            placeholder="Kelly"
          />
          {audience === "spa" && (
            <Field
              label="Spa name"
              value={spaName}
              onChange={setSpaName}
              placeholder="Lakeside Aesthetics"
            />
          )}
          {err && (
            <div className="text-[12px]" style={{ color: "#8a1616" }}>
              {err}
            </div>
          )}
          {added > 0 && !err && (
            <div className="text-[12px]" style={{ color: "#056048" }}>
              ✓ {added} added to this batch
            </div>
          )}
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={done}
            disabled={adding}
            className="rounded-md border px-4 py-2 text-[13px] font-semibold transition hover:bg-[#fbfaf7] disabled:opacity-50"
            style={{ borderColor: "#e6e2d6", background: "#fff", color: "#1c2024" }}
          >
            Done
          </button>
          <button
            type="button"
            onClick={save}
            disabled={adding || !email}
            className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "#056048", color: "#fbfaf7" }}
          >
            <UserPlus className="h-3.5 w-3.5" />
            {adding ? "Saving…" : "Save & add another"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecipientRow({
  draft,
  audience,
  template,
  sharedSubjectOverride,
  sharedBodyOverride,
  onTweakSave,
  onResetTweak,
  onRemove,
}: {
  draft: OutreachDraft;
  audience: "spa" | "rep";
  template: OutreachTemplate;
  sharedSubjectOverride: string | null;
  sharedBodyOverride: string | null;
  onTweakSave: (draft: OutreachDraft, bodyOverride: string) => Promise<void>;
  onResetTweak: (draft: OutreachDraft) => Promise<void>;
  onRemove: (draft: OutreachDraft) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  // Effective body this recipient will send with: per-account override wins,
  // else the composer's shared body, else the template default.
  const effectiveBody =
    draft.bodyOverride ?? sharedBodyOverride ?? template.body;
  const [draftBody, setDraftBody] = useState(effectiveBody);
  const edited = draft.bodyOverride !== null || draft.subjectOverride !== null;

  const openTweak = () => {
    setDraftBody(draft.bodyOverride ?? sharedBodyOverride ?? template.body);
    setExpanded(true);
  };
  const saveTweak = async () => {
    setBusy(true);
    try {
      await onTweakSave(draft, draftBody);
      setExpanded(false);
    } finally {
      setBusy(false);
    }
  };
  const resetTweak = async () => {
    setBusy(true);
    try {
      await onResetTweak(draft);
      setExpanded(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="text-[13px] font-medium truncate"
              style={{ color: "#1c2024" }}
            >
              {draft.recipientFirstName || draft.recipientEmail}
            </span>
            {edited && (
              <span
                className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
                style={{ background: "#fdf6e6", color: "#8a6d10" }}
              >
                edited
              </span>
            )}
          </div>
          <div
            className="text-[12px] mt-0.5 truncate"
            style={{ color: "#8a9098" }}
          >
            {draft.recipientEmail}
            {audience === "spa" && draft.spaName ? ` · ${draft.spaName}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => (expanded ? setExpanded(false) : openTweak())}
            className="text-[12px] font-semibold underline-offset-2 hover:underline"
            style={{ color: "#056048" }}
          >
            {expanded ? "Close" : "Tweak"}
          </button>
          <button
            type="button"
            onClick={() => onRemove(draft)}
            aria-label="Remove recipient"
            className="rounded p-1 transition hover:bg-[#fbfaf7]"
            style={{ color: "#8a9098" }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="mt-3">
          <div
            className="text-[11px] uppercase tracking-wider font-semibold mb-1"
            style={{ color: "#8a9098" }}
          >
            Body for {draft.recipientFirstName || draft.recipientEmail}
          </div>
          <TemplateEditor
            value={draftBody}
            onChange={setDraftBody}
            rows={8}
            ariaLabel={`Body for ${draft.recipientEmail}`}
            placeholderHints={["[first name]", "[spa name]", "$[exact figure]", "[N] weeks"]}
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={saveTweak}
              disabled={busy}
              className="rounded-md px-3 py-1.5 text-[12px] font-semibold transition disabled:opacity-50"
              style={{ background: "#056048", color: "#fbfaf7" }}
            >
              {busy ? "Saving…" : "Save override"}
            </button>
            {edited && (
              <button
                type="button"
                onClick={resetTweak}
                disabled={busy}
                className="text-[12px] underline-offset-2 hover:underline disabled:opacity-50"
                style={{ color: "#5a6068" }}
              >
                Reset to shared
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function RecipientRoster({
  audience,
  template,
  roster,
  sharedSubjectOverride,
  sharedBodyOverride,
  liveEnabled,
  sendingBatch,
  batchResult,
  onAddRecipient,
  onBulkImport,
  onTweakSave,
  onResetTweak,
  onRemove,
  onSendAll,
}: {
  audience: "spa" | "rep";
  template: OutreachTemplate;
  roster: OutreachDraft[];
  sharedSubjectOverride: string | null;
  sharedBodyOverride: string | null;
  liveEnabled: boolean | null;
  sendingBatch: boolean;
  batchResult: { sent: number; failed: number; total: number } | null;
  onAddRecipient: (r: RosterRecipient) => Promise<void>;
  onBulkImport: (
    recipients: ImportRecipient[],
  ) => Promise<{ inserted: number; skipped: number }>;
  onTweakSave: (draft: OutreachDraft, bodyOverride: string) => Promise<void>;
  onResetTweak: (draft: OutreachDraft) => Promise<void>;
  onRemove: (draft: OutreachDraft) => Promise<void>;
  onSendAll: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const count = roster.length;

  return (
    <div
      className="mt-4 rounded-xl border bg-white p-4"
      style={{ borderColor: "#e6e2d6" }}
    >
      <div className="flex items-center justify-between gap-3 mb-1">
        <div
          className="text-[11px] uppercase tracking-wider font-semibold"
          style={{ color: "#8a9098" }}
        >
          Recipients{count > 0 ? ` · ${count}` : ""}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setUploadOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition hover:bg-[#fbfaf7]"
            style={{ borderColor: "#e6e2d6", background: "#fff", color: "#1c2024" }}
          >
            <Upload className="h-3.5 w-3.5" style={{ color: "#056048" }} />
            Upload list
          </button>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition hover:bg-[#fbfaf7]"
            style={{ borderColor: "#e6e2d6", background: "#fff", color: "#1c2024" }}
          >
            <UserPlus className="h-3.5 w-3.5" style={{ color: "#056048" }} />
            Recipient
          </button>
        </div>
      </div>

      {count === 0 ? (
        <p className="text-[13px] py-3" style={{ color: "#8a9098" }}>
          No recipients yet. <strong>Upload a list</strong> to start, add one
          with <strong>+ Recipient</strong>, or save a draft above.
        </p>
      ) : (
        <ul
          className="divide-y rounded-lg border mt-2"
          style={{ borderColor: "#f0ebe0" }}
        >
          {roster.map((d) => (
            <RecipientRow
              key={d.id}
              draft={d}
              audience={audience}
              template={template}
              sharedSubjectOverride={sharedSubjectOverride}
              sharedBodyOverride={sharedBodyOverride}
              onTweakSave={onTweakSave}
              onResetTweak={onResetTweak}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[12px]" style={{ color: "#8a9098" }}>
          {liveEnabled === true
            ? "OUTREACH_LIVE is ON — Send all fires real emails."
            : "Dry-run — Send all logs rows, no email fires."}
        </span>
        <button
          type="button"
          onClick={onSendAll}
          disabled={sendingBatch || count === 0 || liveEnabled === null}
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: liveEnabled === true ? "#b91c1c" : "#056048",
            color: "#fbfaf7",
          }}
        >
          <Send className="h-3.5 w-3.5" />
          {sendingBatch
            ? "Sending…"
            : liveEnabled === true
              ? `Send all LIVE (${count})`
              : `Send all (${count})`}
        </button>
      </div>

      {batchResult && (
        <div
          className="mt-3 rounded-md px-3 py-2 text-[12.5px]"
          style={{ background: "#e8f3ed", color: "#056048" }}
        >
          Batch complete — {batchResult.sent} sent
          {batchResult.failed > 0 ? `, ${batchResult.failed} failed` : ""} of{" "}
          {batchResult.total}. Re-send skips already-sent rows.
        </div>
      )}

      <AddRecipientDialog
        open={dialogOpen}
        audience={audience}
        onClose={() => setDialogOpen(false)}
        onAdd={onAddRecipient}
      />
      <RecipientBulkImport
        open={uploadOpen}
        audience={audience}
        onClose={() => setUploadOpen(false)}
        onImport={onBulkImport}
      />
    </div>
  );
}

// v1.47.0 fold: SendPanel is now the SHARED COMPOSER only — the one body the
// whole batch sends with. Per-recipient identity (email/name/spa) + Save +
// Send live on the RecipientRoster below; this panel just shapes the message.
function SendPanel({
  template,
  audience,
  form,
  onChange,
  onClose,
  subjectOverride,
  bodyOverride,
  onSubjectOverrideChange,
  onBodyOverrideChange,
  onSaveAsTemplate,
}: {
  template: OutreachTemplate;
  audience: "spa" | "rep";
  form: {
    rejuvRecoveredAmount: string;
    rejuvRecoveredWeeks: string;
  };
  onChange: (patch: Partial<typeof form>) => void;
  onClose: () => void;
  subjectOverride: string | null;
  bodyOverride: string | null;
  onSubjectOverrideChange: (v: string | null) => void;
  onBodyOverrideChange: (v: string | null) => void;
  onSaveAsTemplate: () => void;
}) {
  // Shared subject/body: rep override wins, falls back to template default.
  const effectiveSubject = subjectOverride ?? template.subject ?? "";
  const effectiveBody = bodyOverride ?? template.body;
  const isDirty = subjectOverride !== null || bodyOverride !== null;

  // Preview substitutes only the SHARED context (Rejuv figures). [first name]
  // / [spa name] stay literal here because they vary per recipient — they fill
  // at send time from each roster row.
  const previewBody = useMemo(
    () =>
      applyOutreachSubstitutions(effectiveBody, {
        firstName: "",
        spaName: "",
        rejuvRecoveredAmount: form.rejuvRecoveredAmount,
        rejuvRecoveredWeeks: form.rejuvRecoveredWeeks,
      }),
    [effectiveBody, form.rejuvRecoveredAmount, form.rejuvRecoveredWeeks],
  );
  const previewSubject = useMemo(
    () =>
      effectiveSubject
        ? applyOutreachSubstitutions(effectiveSubject, {
            firstName: "",
            spaName: "",
            rejuvRecoveredAmount: form.rejuvRecoveredAmount,
            rejuvRecoveredWeeks: form.rejuvRecoveredWeeks,
          })
        : null,
    [effectiveSubject, form.rejuvRecoveredAmount, form.rejuvRecoveredWeeks],
  );

  return (
    <div
      className="rounded-xl border bg-white p-5"
      style={{ borderColor: "#e6e2d6" }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div
            className="text-[11px] uppercase tracking-wider font-semibold"
            style={{ color: "#8a9098" }}
          >
            Shared message · ICP {template.icp} · {template.channel}
            {isDirty && (
              <span
                className="ml-2 rounded-full px-1.5 py-0.5 text-[9px]"
                style={{ background: "#fdf6e6", color: "#8a6d10" }}
              >
                edited
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 transition hover:bg-[#fbfaf7]"
          style={{ color: "#8a9098" }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* The shared body every recipient sends with — unless they're tweaked
          in the roster below. Edit here and every untweaked recipient follows. */}
      {template.subject !== null && (
        <Field
          label="Subject"
          value={effectiveSubject}
          onChange={(v) => onSubjectOverrideChange(v)}
          placeholder="Email subject"
        />
      )}
      <div className="mt-3">
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span
            className="text-[11px] uppercase tracking-wider font-semibold"
            style={{ color: "#8a9098" }}
          >
            Body
          </span>
          {isDirty && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onSaveAsTemplate}
                className="inline-flex items-center gap-1 text-[11px] font-semibold underline-offset-2 hover:underline"
                style={{ color: "#056048" }}
              >
                <Save className="h-3 w-3" />
                Save as template
              </button>
              <button
                type="button"
                onClick={() => {
                  onSubjectOverrideChange(null);
                  onBodyOverrideChange(null);
                }}
                className="text-[11px] underline-offset-2 hover:underline"
                style={{ color: "#8a9098" }}
              >
                Reset to default
              </button>
            </div>
          )}
        </div>
        <TemplateEditor
          value={effectiveBody}
          onChange={(html) => onBodyOverrideChange(html)}
          rows={10}
          ariaLabel="Shared email body"
          placeholderHints={[
            "[first name]",
            "[spa name]",
            "$[exact figure]",
            "[N] weeks",
          ]}
        />
      </div>

      {/* Live preview — shared figures fill, names stay literal (per recipient). */}
      <details className="mt-4" open>
        <summary
          className="text-[12px] cursor-pointer"
          style={{ color: "#5a6068" }}
        >
          Preview · <span style={{ color: "#8a9098" }}>[first name] / [spa name] fill per recipient</span>
        </summary>
        {previewSubject && (
          <div
            className="mt-2 text-[13px] font-semibold"
            style={{ color: "#1c2024" }}
          >
            {previewSubject}
          </div>
        )}
        <div
          className="mt-2 rounded-md border p-3 text-[13px] leading-[1.55] max-h-64 overflow-y-auto"
          style={{
            borderColor: "#f0ebe0",
            background: "#fbfaf7",
            color: "#1c2024",
          }}
          dangerouslySetInnerHTML={{ __html: previewBody }}
        />
      </details>

      {/* v1.47.0: Rejuv figures are SHARED across the whole batch (spa-outreach
          only). Per-recipient first name + spa name live on the roster. */}
      {audience === "spa" && (
        <>
          <hr className="my-4" style={{ borderColor: "#f0ebe0" }} />
          <div
            className="text-[11px] uppercase tracking-wider font-semibold mb-2"
            style={{ color: "#8a9098" }}
          >
            Shared figures
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="$ recovered (optional)"
              value={form.rejuvRecoveredAmount}
              onChange={(v) => onChange({ rejuvRecoveredAmount: v })}
              placeholder="4,275"
            />
            <Field
              label="Weeks (optional)"
              value={form.rejuvRecoveredWeeks}
              onChange={(v) => onChange({ rejuvRecoveredWeeks: v })}
              placeholder="5"
            />
          </div>
        </>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span
        className="text-[11px] uppercase tracking-wider font-semibold"
        style={{ color: "#8a9098" }}
      >
        {label}
      </span>
      <input
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border px-3 py-2 text-[14px] focus:outline-none transition"
        style={{
          borderColor: "#e6e2d6",
          background: "#fff",
          color: "#1c2024",
        }}
      />
    </label>
  );
}

function EmptyTemplates() {
  return (
    <div
      className="rounded-lg border p-6 text-center mt-4"
      style={{
        borderColor: "#e6e2d6",
        background: "#fbfaf7",
        borderStyle: "dashed",
      }}
    >
      <div
        className="text-[15px] font-semibold mb-1.5"
        style={{ color: "#1c2024" }}
      >
        No templates available yet
      </div>
      <p
        className="text-[13px] leading-[1.55] max-w-md mx-auto"
        style={{ color: "#5a6068" }}
      >
        The shared template library is empty. An admin can populate it from
        the polished outreach doc.
      </p>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl border-2 border-dashed p-6 text-center"
      style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
    >
      <p className="text-[13px]" style={{ color: "#5a6068" }}>
        {children}
      </p>
    </div>
  );
}

// ─── presentational shell ────────────────────────────────────────────────

function Page({
  children,
  wide,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="min-h-screen px-5 sm:px-8 py-12 sm:py-16"
      style={{ background: "#fbfaf7", color: "#1c2024" }}
    >
      <div
        className={`w-full mx-auto ${wide ? "max-w-4xl" : "max-w-2xl"}`}
      >
        <div
          className="rounded-xl border bg-white p-7 sm:p-10 shadow-sm"
          style={{ borderColor: "#e6e2d6" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h1
      className="text-[28px] leading-[1.15] font-semibold tracking-tight mb-3"
      style={{
        fontFamily: "Georgia, 'Times New Roman', serif",
        color: "#1c2024",
      }}
    >
      {children}
    </h1>
  );
}

function Lede({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[15px] leading-[1.6] mb-2" style={{ color: "#5a6068" }}>
      {children}
    </p>
  );
}

function Pulse({ label }: { label: string }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-4"
      style={{ background: "#fbfaf7" }}
      role="status"
      aria-live="polite"
    >
      <div
        className="h-9 w-9 rounded-full animate-pulse"
        style={{ background: "#056048" }}
        aria-hidden
      />
      <div className="text-[14px]" style={{ color: "#5a6068" }}>
        {label}
      </div>
    </div>
  );
}
