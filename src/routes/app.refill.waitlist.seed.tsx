/**
 * /app/refill/waitlist/seed — admin tool for Karen/David to seed waitlist
 * intents for specific patients (v373).
 *
 * Flow:
 *   1. Search/pick a patient from the spa's existing knowledge_nodes
 *   2. Optionally see + pick one of their upcoming appointments
 *      (for the Type B "earlier slot for this Jun 15 Tox" case)
 *   3. Pick intent: catchall vs earlier_appointment
 *   4. Pick treatment_types (multi-select free-text)
 *   5. Click Generate → server creates paused waitlist row + token URL
 *   6. Copy the URL → paste into normal patient-communication channel
 *   7. Patient taps → confirms via optInToWaitlist → row flips to active
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  Search,
  CheckCircle2,
  ClipboardCopy,
  ClipboardCheck,
  Loader2,
  ArrowLeft,
  User,
  Calendar,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  listSeedablePatients,
  listUpcomingForPatient,
  seedWaitlistIntent,
  type AdminPatientCandidate,
  type UpcomingAppointment,
} from "@/server/emma-waitlist-seed.functions";

export const Route = createFileRoute("/app/refill/waitlist/seed")({
  component: WaitlistSeedPage,
});

type SeededResult = {
  optInUrl: string;
  alreadyActive: boolean;
};

function WaitlistSeedPage() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<AdminPatientCandidate[]>([]);
  const [loadingPatients, setLoadingPatients] = useState(true);

  const [picked, setPicked] = useState<AdminPatientCandidate | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingAppointment[]>([]);
  const [pickedAppointmentId, setPickedAppointmentId] = useState<string | null>(
    null,
  );

  const [intentType, setIntentType] = useState<"catchall" | "earlier_appointment">(
    "earlier_appointment",
  );
  const [treatmentsInput, setTreatmentsInput] = useState("");

  const [seeding, setSeeding] = useState(false);
  const [result, setResult] = useState<SeededResult | null>(null);
  const [copied, setCopied] = useState(false);

  // Bootstrap access token
  useEffect(() => {
    supabase.auth.getSession().then((r) => {
      setAccessToken(r.data.session?.access_token ?? null);
    });
  }, []);

  // Load patients when token is ready / query changes
  useEffect(() => {
    if (!accessToken) return;
    setLoadingPatients(true);
    listSeedablePatients({ data: { accessToken, query } })
      .then((r) => setPatients(r))
      .catch((e) => toast.error(`Couldn't load patients: ${e.message}`))
      .finally(() => setLoadingPatients(false));
  }, [accessToken, query]);

  // Load upcoming when a patient is picked
  useEffect(() => {
    if (!accessToken || !picked) {
      setUpcoming([]);
      setPickedAppointmentId(null);
      return;
    }
    listUpcomingForPatient({
      data: { accessToken, patientNodeId: picked.patientNodeId },
    })
      .then((r) => {
        setUpcoming(r);
        // Default-pick the soonest upcoming if there is one
        if (r.length > 0 && intentType === "earlier_appointment") {
          setPickedAppointmentId(r[0].id);
          if (r[0].treatmentType) {
            setTreatmentsInput(r[0].treatmentType);
          }
        }
      })
      .catch((e) => toast.error(`Couldn't load upcoming: ${e.message}`));
  }, [accessToken, picked, intentType]);

  const submit = useCallback(async () => {
    if (!accessToken || !picked) return;
    setSeeding(true);
    try {
      const treatments = treatmentsInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const r = await seedWaitlistIntent({
        data: {
          accessToken,
          patientNodeId: picked.patientNodeId,
          intentType,
          treatmentTypes: treatments,
          scheduledAppointmentId:
            intentType === "earlier_appointment" ? pickedAppointmentId : null,
          brand: "refill",
        },
      });
      setResult({ optInUrl: r.optInUrl, alreadyActive: r.alreadyActive });
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't seed waitlist row.",
      );
    } finally {
      setSeeding(false);
    }
  }, [accessToken, picked, intentType, treatmentsInput, pickedAppointmentId]);

  const reset = useCallback(() => {
    setPicked(null);
    setPickedAppointmentId(null);
    setIntentType("earlier_appointment");
    setTreatmentsInput("");
    setResult(null);
    setCopied(false);
  }, []);

  const copyLink = useCallback(async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.optInUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }, [result]);

  return (
    <div className="px-6 py-6 max-w-3xl mx-auto">
      <PageHeader
        title="Waitlist Seed"
        description="Generate a treatment-matched opt-in link for a specific patient. Karen sends it via her normal patient channel; patient taps to confirm."
      />

      <div className="mt-4 flex justify-end">
        <Link
          to="/app/refill/waitlist/bulk"
          className="inline-flex items-center gap-1.5 text-xs text-emerald-700 hover:text-emerald-900 font-medium"
        >
          Seeding 100+ at once? Try bulk mode →
        </Link>
      </div>

      {!picked && (
        <section className="mt-6 rounded-2xl border border-border bg-card p-6">
          <h2 className="text-sm font-semibold text-foreground mb-3">
            1. Pick a patient
          </h2>
          <div className="relative mb-4">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search by name, phone, or email…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-lg border border-border bg-background pl-10 pr-3 py-2 text-sm"
            />
          </div>
          {loadingPatients ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading patients…
            </div>
          ) : patients.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No matching patients.
            </div>
          ) : (
            <ul className="divide-y divide-border max-h-[420px] overflow-y-auto -mx-2">
              {patients.map((p) => (
                <li key={p.patientNodeId}>
                  <button
                    type="button"
                    onClick={() => setPicked(p)}
                    className="w-full text-left px-2 py-2.5 hover:bg-muted/40 rounded transition flex items-center gap-3"
                  >
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                      <User className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {p.name || "(no name)"}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {[p.phone, p.email].filter(Boolean).join(" · ") ||
                          "(no contact info)"}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {picked && !result && (
        <section className="mt-6 rounded-2xl border border-border bg-card p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                Seeding for
              </div>
              <div className="text-base font-semibold text-foreground">
                {picked.name || "(no name)"}
              </div>
              <div className="text-xs text-muted-foreground">
                {[picked.phone, picked.email].filter(Boolean).join(" · ")}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← change patient
            </button>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              2. Intent type
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setIntentType("earlier_appointment")}
                className={`text-left p-3 rounded-lg border-2 transition ${
                  intentType === "earlier_appointment"
                    ? "border-emerald-500 bg-emerald-50"
                    : "border-border hover:border-muted-foreground"
                }`}
              >
                <div className="text-sm font-medium">Earlier appointment</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Patient is already scheduled — wants notification if an
                  earlier same-treatment slot opens.
                </div>
              </button>
              <button
                type="button"
                onClick={() => setIntentType("catchall")}
                className={`text-left p-3 rounded-lg border-2 transition ${
                  intentType === "catchall"
                    ? "border-emerald-500 bg-emerald-50"
                    : "border-border hover:border-muted-foreground"
                }`}
              >
                <div className="text-sm font-medium">Catchall</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Patient wants notification any time a slot opens (less
                  selective). Use sparingly.
                </div>
              </button>
            </div>
          </div>

          {intentType === "earlier_appointment" && upcoming.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                3. Link to which upcoming appointment? (optional)
              </div>
              <select
                value={pickedAppointmentId ?? ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  setPickedAppointmentId(id);
                  const apt = upcoming.find((u) => u.id === id);
                  if (apt?.treatmentType) setTreatmentsInput(apt.treatmentType);
                }}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">(no specific appointment)</option>
                {upcoming.map((u) => (
                  <option key={u.id} value={u.id}>
                    {new Date(u.scheduledAt).toLocaleString()} ·{" "}
                    {u.treatmentType ?? "?"} · {u.providerName ?? "?"}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              {intentType === "earlier_appointment" ? "4." : "3."} Treatment
              types {intentType === "earlier_appointment" ? "(required)" : "(optional)"}
            </div>
            <input
              type="text"
              value={treatmentsInput}
              onChange={(e) => setTreatmentsInput(e.target.value)}
              placeholder="e.g. Tox w/ Karen, Filler w/ Karen — comma-separated"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono"
            />
            <div className="text-xs text-muted-foreground mt-1.5">
              Patient will ONLY get rescue SMS when a cancellation matches
              one of these treatments. Catchall = leave empty.
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              type="button"
              onClick={submit}
              disabled={
                seeding ||
                (intentType === "earlier_appointment" &&
                  !treatmentsInput.trim())
              }
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground px-5 py-2.5 text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
            >
              {seeding ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Calendar className="h-4 w-4" />
              )}
              Generate opt-in link
            </button>
            <span className="text-xs text-muted-foreground self-center">
              Creates a paused waitlist row + mints the patient's token.
              You then paste the URL into Karen's normal patient channel.
            </span>
          </div>
        </section>
      )}

      {result && (
        <section className="mt-6 rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="h-10 w-10 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold text-emerald-900">
                Opt-in link ready
                {result.alreadyActive &&
                  " (patient was already active — preferences updated)"}
              </div>
              <div className="text-xs text-emerald-800 mt-0.5">
                Send this URL to {picked?.name || "the patient"} via SMS or
                email. When they tap + confirm, their waitlist row flips
                from paused → active and they're eligible for treatment-
                matched rescue SMS.
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-white border border-emerald-200 p-4 mb-3">
            <div className="text-xs uppercase tracking-wider text-emerald-700 font-semibold mb-1">
              Opt-in URL
            </div>
            <div className="font-mono text-sm text-slate-900 break-all">
              {result.optInUrl}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              onClick={copyLink}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 text-white px-5 py-2.5 text-sm font-medium hover:bg-slate-800 transition"
            >
              {copied ? (
                <>
                  <ClipboardCheck className="h-4 w-4" />
                  Copied
                </>
              ) : (
                <>
                  <ClipboardCopy className="h-4 w-4" />
                  Copy link
                </>
              )}
            </button>
            {picked?.phone && (
              <a
                href={`sms:${picked.phone}?body=${encodeURIComponent(
                  `Hi ${picked.name?.split(" ")[0] ?? "there"} — if an earlier slot opens for your appointment, tap here to be notified: ${result.optInUrl}`,
                )}`}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-white border border-slate-200 text-slate-900 px-5 py-2.5 text-sm font-medium hover:bg-slate-50 transition"
              >
                Open SMS to {picked.phone}
              </a>
            )}
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center justify-center gap-2 rounded-lg text-emerald-700 hover:text-emerald-900 px-5 py-2.5 text-sm font-medium"
            >
              <ArrowLeft className="h-4 w-4" />
              Seed another patient
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
