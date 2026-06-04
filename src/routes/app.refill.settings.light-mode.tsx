/**
 * /app/refill/settings/light-mode — Light Mode onboarding wizard (v1.42.0).
 *
 * Sibling route (NOT nested under /app/refill/settings/scheduler) to
 * avoid feedback_tanstack_outlet_trap. The settings card on
 * scheduler.tsx links here when the spa taps "Connect Light Mode" on
 * any of the 5 gated-platform cards.
 *
 * Onboarding flow:
 *   1. Pick platform (driven by ?platform=zenoti query param when
 *      arriving from a platform card; otherwise platform picker).
 *   2. Server fn enableLightMode generates a per-spa inbound address
 *      (<slug>@inbound.getrefill.app).
 *   3. Wizard walks owner through Gmail filter setup with deep link to
 *      Gmail filter creation page + pre-filled criteria per platform.
 *   4. Verification: when first email parses cleanly, status flips
 *      'pending' → 'active' and a "Light Mode active" banner renders.
 *
 * The wizard mirrors feedback_setup_wizards_auto_advance: every step a
 * customer-loss risk; we deep-link rather than instruct; we surface
 * status visibly so the operator knows they succeeded.
 */

import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  CheckCircle2,
  Clock,
  Loader2,
  Mail,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { SettingsTabStrip } from "@/components/refill/SettingsTabStrip";
import { supabase } from "@/integrations/supabase/client";
import {
  enableLightMode,
  listLightModeConnections,
  getPendingGmailVerification,
  type LightModeConnection,
  type LightModePlatform,
} from "@/server/light-mode.functions";

type SearchParams = { platform?: LightModePlatform };

const LIGHT_MODE_PLATFORMS: ReadonlyArray<{
  key: LightModePlatform;
  label: string;
  filterFrom: string;
  filterHint: string;
}> = [
  {
    key: "zenoti",
    label: "Zenoti",
    filterFrom: "noreply@zenoti.com",
    filterHint:
      "Default Zenoti sender. Custom-From Enterprise tenants: also add your custom sender if you've set one.",
  },
  {
    key: "mindbody",
    label: "Mindbody",
    filterFrom: "(your Mindbody From address)",
    filterHint:
      "Mindbody sender is tenant-configurable. Use whatever From your Marketing Suite is configured to use, plus 'mindbody' anywhere in the subject as a fallback filter.",
  },
  {
    key: "booker",
    label: "Booker",
    filterFrom: "(your Booker From address)",
    filterHint:
      "Booker shares the Mindbody Marketing Suite stack. Use your configured From + 'booker' in the body as fallback.",
  },
  {
    key: "boulevard",
    label: "Boulevard",
    filterFrom: "@joinblvd.com",
    filterHint:
      "Boulevard-controlled sender. Filter on the joinblvd.com domain.",
  },
  {
    key: "jane",
    label: "JaneApp",
    filterFrom: "@jane.app",
    filterHint:
      "Jane batches up to N appointments per email on a ~3-minute window — Refill unpacks all of them.",
  },
];

export const Route = createFileRoute("/app/refill/settings/light-mode")({
  validateSearch: (raw: Record<string, unknown>): SearchParams => {
    const p = typeof raw.platform === "string" ? raw.platform : undefined;
    if (
      p === "zenoti" ||
      p === "mindbody" ||
      p === "booker" ||
      p === "boulevard" ||
      p === "jane"
    ) {
      return { platform: p };
    }
    return {};
  },
  component: LightModeWizardPage,
});

function LightModeWizardPage() {
  const search = useSearch({ from: "/app/refill/settings/light-mode" });
  const navigate = useNavigate();

  const [picked, setPicked] = useState<LightModePlatform | null>(
    search.platform ?? null,
  );
  const [connections, setConnections] = useState<LightModeConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabling, setEnabling] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        return;
      }
      const { connections: rows } = await listLightModeConnections({
        data: { accessToken: token },
      });
      setConnections(rows);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't load Light Mode state.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentConnection = useMemo(() => {
    if (!picked) return null;
    return connections.find((c) => c.platform === picked) ?? null;
  }, [picked, connections]);

  const onEnable = useCallback(async () => {
    if (!picked) return;
    setEnabling(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        return;
      }
      const result = await enableLightMode({
        data: { accessToken: token, platform: picked },
      });
      toast.success(
        result.reactivated
          ? "Light Mode reactivated."
          : "Light Mode address generated.",
      );
      await refresh();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't enable Light Mode.",
      );
    } finally {
      setEnabling(false);
    }
  }, [picked, refresh]);

  const meta = useMemo(
    () => (picked ? LIGHT_MODE_PLATFORMS.find((p) => p.key === picked) : null),
    [picked],
  );

  return (
    <div className="mx-auto max-w-3xl px-4 pb-16">
      <PageHeader title="Light Mode setup" subtitle="Email-forward connector" />
      <SettingsTabStrip active="light-mode" />

      <button
        type="button"
        onClick={() =>
          void navigate({
            to: "/app/refill/settings/scheduler",
            search: {},
            replace: false,
          })
        }
        className="mt-4 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Scheduler settings
      </button>

      {loading ? (
        <div className="mt-8 flex items-center gap-2 text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : !picked ? (
        <PickerStep onPick={setPicked} />
      ) : (
        <WizardStep
          platform={picked}
          platformLabel={meta?.label ?? picked}
          filterFrom={meta?.filterFrom ?? ""}
          filterHint={meta?.filterHint ?? ""}
          connection={currentConnection}
          enabling={enabling}
          onEnable={onEnable}
          onResetPick={() => setPicked(null)}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}

function PickerStep(props: { onPick: (p: LightModePlatform) => void }) {
  return (
    <div className="mt-8 space-y-4">
      <h2 className="text-lg font-semibold">Which platform's emails?</h2>
      <p className="text-sm text-ink-soft">
        Light Mode parses the appointment-confirmation and cancellation
        emails your scheduler already sends you. Pick the platform whose
        emails you want to forward.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {LIGHT_MODE_PLATFORMS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => props.onPick(p.key)}
            className="text-left rounded-lg border bg-card p-4 hover:border-emerald hover:bg-emerald/5 transition-colors"
          >
            <div className="font-medium text-ink">{p.label}</div>
            <div className="mt-1 text-xs text-ink-soft">
              Filter: <code className="text-[11px]">{p.filterFrom}</code>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function WizardStep(props: {
  platform: LightModePlatform;
  platformLabel: string;
  filterFrom: string;
  filterHint: string;
  connection: LightModeConnection | null;
  enabling: boolean;
  onEnable: () => Promise<void>;
  onResetPick: () => void;
  onRefresh: () => Promise<void>;
}) {
  const inboundAddress = props.connection?.inboundAddress;

  // D-7: Poll for Gmail forwarding-verification email captured by our
  // inbound webhook. Surfaces a one-click confirm prompt when present.
  const [gmailVerify, setGmailVerify] = useState<{
    pending: false;
  } | {
    pending: true;
    id: string;
    subject: string | null;
    confirmUrl: string | null;
    receivedAt: string;
  }>({ pending: false });

  const refreshGmailVerify = useCallback(async () => {
    if (!props.connection) return;
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const result = await getPendingGmailVerification({
        data: { accessToken: token, platform: props.platform },
      });
      setGmailVerify(result);
    } catch {
      // soft-fail
    }
  }, [props.connection, props.platform]);

  useEffect(() => {
    void refreshGmailVerify();
    if (!props.connection || props.connection.status === "active") return;
    const t = setInterval(() => void refreshGmailVerify(), 15_000);
    return () => clearInterval(t);
  }, [props.connection, refreshGmailVerify]);

  const copyAddress = useCallback(() => {
    if (!inboundAddress) return;
    void navigator.clipboard.writeText(inboundAddress);
    toast.success("Copied — paste into the Gmail filter Forward To field.");
  }, [inboundAddress]);

  const gmailFilterUrl = useMemo(() => {
    // Deep-link to Gmail's create-filter UI pre-seeded with the
    // recommended sender filter.
    const from = encodeURIComponent(props.filterFrom);
    return `https://mail.google.com/mail/u/0/#search/from%3A${from}`;
  }, [props.filterFrom]);

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center justify-between rounded-lg bg-card border p-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-soft">
            Platform
          </div>
          <div className="text-lg font-semibold mt-0.5">
            {props.platformLabel}
          </div>
        </div>
        <button
          type="button"
          onClick={props.onResetPick}
          className="text-sm text-ink-soft hover:text-ink"
        >
          Change
        </button>
      </div>

      {!props.connection ? (
        <StepCard num={1} title="Generate your Light Mode address">
          <p className="text-sm text-ink-soft">
            We'll generate a unique inbound email address just for your spa.
            Every email Gmail forwards to that address gets parsed by Refill
            and lands as a recovery / recognition signal.
          </p>
          <button
            type="button"
            disabled={props.enabling}
            onClick={() => void props.onEnable()}
            className="mt-3 inline-flex items-center gap-2 rounded-md bg-emerald px-4 py-2 text-sm font-medium text-paper hover:bg-emerald/90 disabled:opacity-50"
          >
            {props.enabling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Mail className="h-4 w-4" />
            )}
            {props.enabling ? "Generating…" : "Generate inbound address"}
          </button>
        </StepCard>
      ) : (
        <StepCard num={1} title="Your Light Mode inbound address">
          <div className="rounded-md bg-ink/5 p-3 font-mono text-sm break-all">
            {inboundAddress}
          </div>
          <button
            type="button"
            onClick={copyAddress}
            className="mt-2 inline-flex items-center gap-1.5 text-sm text-emerald hover:underline"
          >
            <Copy className="h-3.5 w-3.5" /> Copy
          </button>
        </StepCard>
      )}

      {props.connection && gmailVerify.pending && (
        <div className="rounded-lg border border-amber/40 bg-amber/5 p-4">
          <div className="flex items-center gap-2 mb-1">
            <Mail className="h-4 w-4 text-amber" />
            <div className="font-medium text-ink">
              Gmail verification email received
            </div>
          </div>
          <p className="text-sm text-ink-soft">
            Gmail sent a verification email to your Refill inbound address.
            One tap to confirm the forwarding — your filter will be live
            immediately after.
          </p>
          {gmailVerify.confirmUrl ? (
            <a
              href={gmailVerify.confirmUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-sm font-medium text-paper hover:bg-emerald/90"
            >
              Confirm Gmail forwarding <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : (
            <p className="mt-2 text-xs text-ink-soft">
              We received the verification email but couldn't auto-extract
              the link. Open your Gmail forwarded mail and click the confirm
              link there to finish.
            </p>
          )}
          <p className="mt-2 text-[11px] text-ink-soft">
            Verification received {new Date(gmailVerify.receivedAt).toLocaleString()}
          </p>
        </div>
      )}

      {props.connection && (
        <>
          <StepCard num={2} title="Set up Gmail forwarding filter">
            <p className="text-sm text-ink-soft">
              In Gmail, create a filter that forwards{" "}
              <strong>{props.platformLabel}</strong> notification emails to
              the address above.
            </p>
            <div className="mt-3 rounded-md bg-card border p-3 text-xs text-ink-soft">
              <div className="font-medium text-ink mb-1">Filter criteria</div>
              <div>
                From:{" "}
                <code className="bg-ink/5 px-1.5 py-0.5 rounded">
                  {props.filterFrom}
                </code>
              </div>
              <div className="mt-2 text-[11px] leading-relaxed">
                {props.filterHint}
              </div>
            </div>
            <a
              href={gmailFilterUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-sm font-medium text-paper hover:bg-emerald/90"
            >
              Open Gmail filter setup <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <ol className="mt-4 list-decimal pl-5 text-xs text-ink-soft space-y-1">
              <li>Click the gear → "See all settings" → Filters and Blocked Addresses</li>
              <li>Click "Create a new filter"</li>
              <li>
                Put{" "}
                <code className="bg-ink/5 px-1 py-0.5 rounded">
                  {props.filterFrom}
                </code>{" "}
                in the From field → "Create filter"
              </li>
              <li>Check "Forward it to" → "Add forwarding address" → paste your Refill inbound address above</li>
              <li>Confirm the verification email Gmail sends to the inbound address (Refill auto-confirms)</li>
              <li>Save the filter — done</li>
            </ol>
          </StepCard>

          <StepCard num={3} title="Verify with a test booking">
            <p className="text-sm text-ink-soft">
              Book a fake appointment in your {props.platformLabel} portal —
              the confirmation email triggers Light Mode to flip from
              "pending" to "active".
            </p>
            <div className="mt-3 flex items-center gap-2">
              {props.connection.status === "active" ? (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald/10 text-emerald px-2.5 py-1 text-xs font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Light Mode active
                  {props.connection.lastEventAt
                    ? ` · last event ${new Date(
                        props.connection.lastEventAt,
                      ).toLocaleString()}`
                    : ""}
                </span>
              ) : props.connection.status === "silent" ? (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-destructive/10 text-destructive px-2.5 py-1 text-xs font-medium">
                  <Clock className="h-3.5 w-3.5" /> Silent &mdash; no events in 24h. Re-check Gmail forwarding.
                </span>
              ) : props.connection.status === "paused" ? (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-muted/40 text-ink-soft px-2.5 py-1 text-xs font-medium">
                  Paused
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-amber/10 text-amber px-2.5 py-1 text-xs font-medium">
                  <Clock className="h-3.5 w-3.5" /> Waiting for first event
                </span>
              )}
              <button
                type="button"
                onClick={() => void props.onRefresh()}
                className="text-xs text-ink-soft hover:text-ink underline"
              >
                Refresh
              </button>
            </div>
            <div className="mt-3 text-xs text-ink-soft">
              Events parsed: <strong>{props.connection.eventsParsedTotal}</strong>
              {" · "}
              Quarantined:{" "}
              <strong>{props.connection.eventsQuarantinedTotal}</strong>
            </div>
            {props.connection.lastError && (
              <div className="mt-3 rounded-md bg-amber/10 border border-amber/40 p-2 text-xs text-amber">
                Note: {props.connection.lastError}
              </div>
            )}
          </StepCard>
        </>
      )}
    </div>
  );
}

function StepCard(props: {
  num: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald text-paper text-sm font-semibold">
          {props.num}
        </div>
        <div className="flex-1">
          <h3 className="font-medium text-ink">{props.title}</h3>
          <div className="mt-2">{props.children}</div>
        </div>
      </div>
    </div>
  );
}
