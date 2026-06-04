/**
 * /app/rep/recruit — Rep-to-rep recruiting outreach (v408).
 *
 * Mirror of /app/rep/outreach with audience='rep'. Reps send invites
 * to OTHER REPS (peer-rep recruiting), who get a 3% direct commission on
 * spas they introduce while the recruiting rep clips 1% cascade lifetime.
 * The compounding growth lever — scales beyond the recruiting rep's own
 * hours.
 *
 * Substrate reused from the spa-outreach surface (v393-v407):
 *   - outreach_templates (now filtered by audience='rep')
 *   - sendOutreachEmail (now passes audience='rep' + purpose='rep_recruit')
 *   - outreach_engagement_events (new purpose column filters past-sends)
 *   - [from first name] placeholder engine
 *   - past-sends panel pattern
 *   - URL-param-driven pre-fill schema
 *
 * What's different from /outreach:
 *   - Heading + lede repositioned (peer-rep tone, not spa-prospect tone)
 *   - Recipient label: "Peer rep email" / "First name" — no spa name field
 *   - Live-stat chips: commission rate / 30-day earnings / downstream count
 *     pulled from getMyRecruitStats; these surface to the rep so she sees
 *     exactly what's substituting into the [my commission rate] /
 *     [my month earnings] / [my downstream count] template placeholders
 *   - Send button verb: "Send to {firstName}" (peer-friendly, vs the
 *     spa-outreach "Send LIVE" muscle-memory-break)
 *   - "Or just share your link" affordance links to /app/rep/referral-links
 *     (recognizes that DM/iMessage/Instagram is often the real channel —
 *     email outreach is one path, not the only path)
 *   - From: line resolves to {firstName}@getrefill.app via buildRecruitFrom
 *     (peer-rep voice wants kelly@, not karen@)
 *   - Past-sends panel filters purpose='rep_recruit'
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Link2, Send, Sparkles, UserPlus, X } from "lucide-react";
import { z } from "zod";

import { TemplateEditor } from "@/components/refill/TemplateEditor";
import { getAdminViewAsUserId } from "@/lib/admin-view-as";
import { useAuth } from "@/lib/auth";
import {
  getMyRepAccount,
  type RepAccountRow,
} from "@/server/rep-platform";
import {
  listMyOutreachSends,
  listOutreachTemplates,
  type OutreachSendRow,
  type OutreachTemplate,
} from "@/server/refill-outreach";
import {
  getMyRecruitStats,
  getOutreachSendMode,
  sendOutreachEmail,
  type SendMode,
} from "@/server/refill-outreach-send";

const recruitSearchSchema = z.object({
  to: z.string().email().max(120).optional(),
  firstName: z.string().min(1).max(80).optional(),
  icp: z.coerce.number().int().min(1).max(3).optional(),
  channel: z.string().min(1).max(40).optional(),
});

export const Route = createFileRoute("/app/rep/recruit")({
  validateSearch: (search: Record<string, unknown>) =>
    recruitSearchSchema.parse(search),
  component: RecruitPage,
});

type SendResult = {
  mode: SendMode;
  eventId: string;
  renderedSubject: string | null;
  renderedBody: string;
  replyTo: string;
  message: string;
};

type RecruitStats = {
  myCommissionRate: string;
  myMonthEarnings: string | null;
  myDownstreamCount: string | null;
};

function RecruitPage() {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;
  const prefill = Route.useSearch();

  const [rep, setRep] = useState<RepAccountRow | null>(null);
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [stats, setStats] = useState<RecruitStats | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<OutreachTemplate | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [liveEnabled, setLiveEnabled] = useState<boolean | null>(null);
  const [sends, setSends] = useState<OutreachSendRow[]>([]);
  const [form, setForm] = useState({
    recipientEmail: prefill.to ?? "",
    firstName: prefill.firstName ?? "",
  });
  // v1.44 per-send overrides. Same shape as outreach — null = template
  // default, string = rep tweaked. Reset on template selection change.
  const [subjectOverride, setSubjectOverride] = useState<string | null>(null);
  const [bodyOverride, setBodyOverride] = useState<string | null>(null);
  useEffect(() => {
    setSubjectOverride(null);
    setBodyOverride(null);
  }, [selected?.id]);

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
        const [repRes, tplRes, modeRes, sendsRes, statsRes] = await Promise.all([
          getMyRepAccount({ data: { accessToken, viewAsUserId } }),
          listOutreachTemplates({
            data: { accessToken, audience: "rep" },
          }).catch(() => ({ templates: [] })),
          getOutreachSendMode({ data: { accessToken } }).catch(() => ({
            liveEnabled: false,
          })),
          listMyOutreachSends({
            data: { accessToken, purpose: "rep_recruit" },
          }).catch(() => ({ sends: [] })),
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
        setStats(statsRes);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Couldn't load recruit.",
          );
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, accessToken]);

  const grouped = useMemo(() => groupByIcp(templates), [templates]);

  useEffect(() => {
    if (selected || !templates.length) return;
    if (prefill.icp == null || !prefill.channel) return;
    const match = templates.find(
      (t) => t.icp === prefill.icp && t.channel === prefill.channel,
    );
    if (match) setSelected(match);
  }, [templates, prefill.icp, prefill.channel, selected]);

  const handleSend = async () => {
    if (!accessToken || !selected || sending) return;
    if (!form.recipientEmail || !form.firstName) {
      setError("Recipient email + first name are required.");
      return;
    }
    setSending(true);
    setError(null);
    setResult(null);
    try {
      const res = await sendOutreachEmail({
        data: {
          accessToken,
          audience: "rep",
          icp: selected.icp,
          channel: selected.channel,
          recipientEmail: form.recipientEmail,
          recipientFirstName: form.firstName,
          sourceContext: rep ? `recruit:${rep.displayName}` : undefined,
          context: {
            firstName: form.firstName,
          },
          ...(bodyOverride !== null ? { bodyOverride } : {}),
          ...(subjectOverride !== null ? { subjectOverride } : {}),
        },
      });
      setResult({
        mode: res.mode,
        eventId: res.eventId,
        renderedSubject: res.renderedSubject,
        renderedBody: res.renderedBody,
        replyTo: res.replyTo,
        message: res.message,
      });
      try {
        const { sends: latest } = await listMyOutreachSends({
          data: { accessToken, purpose: "rep_recruit" },
        });
        setSends(latest);
      } catch {
        // Ignore — the next page load will pick it up.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed.");
    } finally {
      setSending(false);
    }
  };

  if (authLoading || !loaded) {
    return <Pulse label="Loading recruit…" />;
  }

  if (!accessToken) {
    return (
      <Page>
        <Heading>Recruit reps</Heading>
        <Lede>Sign in to access the recruit library.</Lede>
      </Page>
    );
  }

  if (!rep) {
    return (
      <Page>
        <Heading>Recruit reps</Heading>
        <Lede>
          Set up your rep profile first. Every recruit invite is attributed
          to you so when your invitee converts a spa, you clip the 1% cascade.
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
      <Heading>Recruit reps</Heading>
      <Lede>
        Invite peer reps into your downstream. You earn{" "}
        <strong>1% cascade, lifetime</strong>, on every dollar of recovered
        revenue from spas your sub-reps introduce — on top of your own 3%
        direct rate. The compounding scales beyond your own hours.
      </Lede>

      {stats && <RecruitStatsBar stats={stats} />}

      {templates.length === 0 ? (
        <EmptyTemplates />
      ) : (
        <div className="grid md:grid-cols-[1fr_1fr] gap-6 mt-6">
          <div className="space-y-5">
            {[1, 2, 3].map((icp) => {
              const tpls = grouped.get(icp) ?? [];
              if (tpls.length === 0) return null;
              return (
                <IcpSection
                  key={icp}
                  icp={icp}
                  templates={tpls}
                  selectedId={selected?.id}
                  onPick={(t) => {
                    setSelected(t);
                    setResult(null);
                    setError(null);
                  }}
                />
              );
            })}
            <ShareLinkAffordance />
          </div>

          <div className="md:sticky md:top-6 self-start">
            {selected ? (
              <SendPanel
                template={selected}
                form={form}
                onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
                onClose={() => {
                  setSelected(null);
                  setResult(null);
                }}
                onSend={handleSend}
                sending={sending}
                result={result}
                liveEnabled={liveEnabled}
                senderFirstName={rep.displayName.split(" ")[0] || rep.displayName}
                stats={stats}
                subjectOverride={subjectOverride}
                bodyOverride={bodyOverride}
                onSubjectOverrideChange={setSubjectOverride}
                onBodyOverrideChange={setBodyOverride}
              />
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

      {sends.length > 0 && <PastSendsPanel sends={sends} />}
    </Page>
  );
}

function RecruitStatsBar({ stats }: { stats: RecruitStats }) {
  // v408: live placeholder values rendered as read-only chips so the rep
  // sees exactly what'll substitute into [my commission rate] /
  // [my month earnings] / [my downstream count] before clicking Send.
  // Null values render the literal placeholder bracketed so the gap is
  // visible — matches the [[feedback-math-must-be-exact]] discipline
  // (no silent "$0" or "0 reps" in a recruit pitch).
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
          Your recent recruit sends
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
  const recipientLabel = send.recipientFirstName
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
          Joined
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
  templates,
  selectedId,
  onPick,
}: {
  icp: number;
  templates: OutreachTemplate[];
  selectedId?: string;
  onPick: (t: OutreachTemplate) => void;
}) {
  // Recruit-audience ICP labels differ from spa-outreach.
  const label =
    icp === 1
      ? "ICP 1 · warm peer"
      : icp === 2
        ? "ICP 2 · cold peer"
        : "ICP 3";
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

function SendPanel({
  template,
  form,
  onChange,
  onClose,
  onSend,
  sending,
  result,
  liveEnabled,
  senderFirstName,
  stats,
  subjectOverride,
  bodyOverride,
  onSubjectOverrideChange,
  onBodyOverrideChange,
}: {
  template: OutreachTemplate;
  form: {
    recipientEmail: string;
    firstName: string;
  };
  onChange: (patch: Partial<typeof form>) => void;
  onClose: () => void;
  onSend: () => void;
  sending: boolean;
  result: SendResult | null;
  liveEnabled: boolean | null;
  senderFirstName: string;
  stats: RecruitStats | null;
  subjectOverride: string | null;
  bodyOverride: string | null;
  onSubjectOverrideChange: (v: string | null) => void;
  onBodyOverrideChange: (v: string | null) => void;
}) {
  // v1.44 effective subject/body: rep override wins, falls back to template.
  // First keystroke promotes to "override" (dirty); Reset wipes back to null.
  const effectiveSubject = subjectOverride ?? template.subject ?? "";
  const effectiveBody = bodyOverride ?? template.body;
  const isDirty = subjectOverride !== null || bodyOverride !== null;

  // Live post-substitution preview, computed off the effective (override-or-
  // template) text so the preview tracks edits in real time. Same placeholder
  // set the server fn substitutes at send time.
  const substitute = (text: string) => {
    let out = text;
    if (form.firstName) {
      out = out.replace(/\[first name\]/gi, form.firstName);
      out = out.replace(/\[name\]/gi, form.firstName);
    }
    if (senderFirstName) {
      out = out.replace(/\[from first name\]/gi, senderFirstName);
      out = out.replace(/\[from\]/gi, senderFirstName);
    }
    if (stats?.myCommissionRate) {
      out = out.replace(/\[my commission rate\]/gi, stats.myCommissionRate);
    }
    if (stats?.myMonthEarnings) {
      out = out.replace(/\[my month earnings\]/gi, stats.myMonthEarnings);
    }
    if (stats?.myDownstreamCount) {
      out = out.replace(/\[my downstream count\]/gi, stats.myDownstreamCount);
    }
    return out;
  };

  const previewBody = useMemo(
    () => substitute(effectiveBody),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveBody, form.firstName, senderFirstName, stats],
  );

  const previewSubject = useMemo(
    () => (effectiveSubject ? substitute(effectiveSubject) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveSubject, form.firstName, senderFirstName, stats],
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
            ICP {template.icp} · {template.channel}
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

      {!result ? (
        <>
          {/* v1.44 inline editor — subject + body editable per-send. Server
              still substitutes placeholders so [first name] / [from first name]
              / [my month earnings] fill from the recipient form + stats. */}
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
                <button
                  type="button"
                  onClick={() => {
                    onSubjectOverrideChange(null);
                    onBodyOverrideChange(null);
                  }}
                  className="text-[11px] underline-offset-2 hover:underline"
                  style={{ color: "#056048" }}
                >
                  Reset to default
                </button>
              )}
            </div>
            {/* v1.45.0: TipTap WYSIWYG. Recruit placeholders render as chips. */}
            <TemplateEditor
              value={effectiveBody}
              onChange={(html) => onBodyOverrideChange(html)}
              rows={10}
              ariaLabel="Email body"
              placeholderHints={[
                "[first name]",
                "[from first name]",
                "[my commission rate]",
                "[my month earnings]",
                "[my downstream count]",
              ]}
            />
          </div>

          {/* Live post-substitution preview — what the recipient will read. */}
          <details className="mt-4" open>
            <summary
              className="text-[12px] cursor-pointer"
              style={{ color: "#5a6068" }}
            >
              Preview as recipient
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

          <hr className="my-4" style={{ borderColor: "#f0ebe0" }} />

          <div className="space-y-3">
            <Field
              label="Peer rep email"
              value={form.recipientEmail}
              onChange={(v) => onChange({ recipientEmail: v })}
              placeholder="randi@example.com"
              type="email"
            />
            <Field
              label="First name"
              value={form.firstName}
              onChange={(v) => onChange({ firstName: v })}
              placeholder="Randi"
            />
          </div>

          <button
            type="button"
            onClick={onSend}
            disabled={sending || liveEnabled === null}
            className="mt-4 inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: liveEnabled === true ? "#b91c1c" : "#056048",
              color: "#fbfaf7",
            }}
          >
            <Send className="h-4 w-4" />
            {sending
              ? "Sending…"
              : liveEnabled === true
                ? `Send LIVE to ${form.firstName || "rep"}`
                : `Send to ${form.firstName || "rep"} (dry-run)`}
          </button>
          <p className="text-[12px] mt-2" style={{ color: "#8a9098" }}>
            <Sparkles
              className="inline h-3 w-3 mr-0.5"
              style={{
                color: liveEnabled === true ? "#b91c1c" : "#8a6d10",
              }}
            />
            {liveEnabled === true
              ? "OUTREACH_LIVE is ON — clicking Send fires a real email."
              : "OUTREACH_LIVE is OFF — Send logs a dry-run row, no email fires."}
            {" "}From line:{" "}
            <code className="font-mono text-[11px]">
              {senderFirstName.toLowerCase().replace(/[^a-z0-9]/g, "")}@getrefill.app
            </code>
            . Replies route back through the platform.
          </p>
        </>
      ) : (
        <SendResultPanel result={result} />
      )}
    </div>
  );
}

function SendResultPanel({ result }: { result: SendResult }) {
  const modeBadge =
    result.mode === "live"
      ? { bg: "#e8f3ed", fg: "#056048", label: "Live · sent" }
      : result.mode === "test"
        ? { bg: "#fdf6e6", fg: "#8a6d10", label: "Test render" }
        : { bg: "#f0ebe0", fg: "#5a6068", label: "Dry run · queued" };

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span
          className="text-[11px] font-semibold uppercase tracking-wide rounded-full px-2.5 py-0.5"
          style={{ background: modeBadge.bg, color: modeBadge.fg }}
        >
          {modeBadge.label}
        </span>
      </div>
      <p
        className="text-[13px] leading-[1.55] mb-3"
        style={{ color: "#5a6068" }}
      >
        {result.message}
      </p>
      {result.renderedSubject && (
        <div className="mb-3">
          <div
            className="text-[10px] uppercase tracking-wider font-semibold mb-1"
            style={{ color: "#8a9098" }}
          >
            Subject
          </div>
          <div
            className="text-[13px] font-semibold"
            style={{ color: "#1c2024" }}
          >
            {result.renderedSubject}
          </div>
        </div>
      )}
      <div className="mb-3">
        <div
          className="text-[10px] uppercase tracking-wider font-semibold mb-1"
          style={{ color: "#8a9098" }}
        >
          Reply-To
        </div>
        <div
          className="text-[12px] font-mono break-all"
          style={{ color: "#5a6068" }}
        >
          {result.replyTo}
        </div>
      </div>
      <div>
        <div
          className="text-[10px] uppercase tracking-wider font-semibold mb-1"
          style={{ color: "#8a9098" }}
        >
          Body sent
        </div>
        <div
          className="rounded-md border p-3 text-[13px] leading-[1.55] max-h-64 overflow-y-auto"
          style={{
            borderColor: "#f0ebe0",
            background: "#fbfaf7",
            color: "#1c2024",
          }}
          dangerouslySetInnerHTML={{ __html: result.renderedBody }}
        />
      </div>
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
        className="flex items-center justify-center mb-2"
        style={{ color: "#8a9098" }}
      >
        <UserPlus className="h-5 w-5" />
      </div>
      <div
        className="text-[15px] font-semibold mb-1.5"
        style={{ color: "#1c2024" }}
      >
        No recruit templates yet
      </div>
      <p
        className="text-[13px] leading-[1.55] max-w-md mx-auto"
        style={{ color: "#5a6068" }}
      >
        Run the v408 migration to seed the rep-audience template library, or
        ask an admin to import recruit copy via the admin outreach page.
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
