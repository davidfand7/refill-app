/**
 * /app/refill/patients/$patientId — Patient Architecture P2 detail page.
 *
 * The "everything Emma knows about this patient" view. Mirrors the shape of
 * app.lizzie.accounts.$accountId.tsx (the rep-side analogue) on purpose —
 * symmetry between Lizzie(OS) and Emma(OS) makes the platform feel one,
 * even though the products are standalone (see project_emma_lizzie_independence).
 *
 * Sections, top to bottom:
 *   1. ContactCard         — phone, email, days-since-last, banned chip
 *   2. SummaryCard         — lifetime spend (gross + net), visits, first/last
 *   3. ManufacturerMixCard — line-count per manufacturer with brand chips
 *   4. LoyaltyCard         — rewards redemptions per program
 *   5. TransactionsSection — full table with kind chips + 12mo / all-time toggle
 *
 * URL key: patient_node uuid (mirrors v328's switch from lookupKey →
 * accountId — UUIDs survive name normalization changes cleanly).
 *
 * Established 2026-05-15 (Patient Architecture P2).
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Ban,
  Calendar,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Gift,
  Loader2,
  Mail,
  Minus,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Sparkles,
  Tag,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  addPatientCustomTag,
  clearPatientSoftTag,
  deletePatientCustomTag,
  getPatientById,
  recomputePatientPatterns,
  setPatientSoftTag,
  updatePatientCustomTag,
  type PatientDetail,
  type PatientListRow,
  type PatientTransactionRow,
} from "@/server/patient-ingest.functions";
import type {
  ProductKind,
  ProductManufacturer,
} from "@/lib/product-manufacturer-map";
import type {
  CadenceMetrics,
  PatientCustomTag,
  PatientPurchasePatterns,
  PatientSoftTagEntry,
  PatientSoftTagKey,
  PatientSoftTags,
} from "@/lib/patient-csv";
import { useTenantMembership } from "@/lib/use-tenant-membership";

export const Route = createFileRoute("/app/refill/patients/$patientId")({
  component: PatientDetailPage,
});

type Window = "12mo" | "all";

function PatientDetailPage() {
  const { patientId } = Route.useParams();
  const [data, setData] = useState<PatientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [windowMode, setWindowMode] = useState<Window>("12mo");

  // v1.20 admin viewing-as: see app.refill.patients.index.tsx for pattern.
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  useEffect(() => {
    if (membership.status === "loading") return;
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) {
          if (!cancelled) {
            setLoading(false);
            setLoadError("Please sign in to view this patient.");
          }
          return;
        }
        const detail = await getPatientById({
          data: { accessToken: token, patientId, viewAsUserId },
        });
        if (!cancelled) {
          setData(detail);
          setLoading(false);
          if (!detail) setLoadError("Patient not found.");
        }
      } catch (e) {
        if (!cancelled) {
          setLoading(false);
          setLoadError(e instanceof Error ? e.message : "Couldn't load patient.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, membership.status, viewAsUserId]);

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <PageHeader
        title={data?.patient.displayName ?? (loading ? "Loading…" : "Patient")}
        description={
          data?.patient.firstVisit
            ? `Seen at your practice since ${formatDate(data.patient.firstVisit)}.`
            : undefined
        }
        breadcrumbs={[
          { label: "Refill", to: "/app/refill" },
          { label: "Patients", to: "/app/refill/patients" },
          { label: data?.patient.displayName ?? "Patient" },
        ]}
        actions={
          <Link
            to="/app/refill/patients"
            className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-rule-soft transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All patients
          </Link>
        }
      />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-5xl w-full mx-auto space-y-5">
        {loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading patient…
          </div>
        ) : loadError ? (
          <div className="rounded-2xl border border-rose/30 bg-rose-soft p-5 text-sm">
            <div className="font-semibold text-rose">
              Couldn't load this patient
            </div>
            <p className="text-xs text-ink-soft mt-1">{loadError}</p>
            <Link
              to="/app/refill/patients"
              className="inline-flex items-center gap-1.5 mt-3 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium hover:bg-rule-soft transition"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to patient list
            </Link>
          </div>
        ) : data ? (
          <>
            <ContactCard patient={data.patient} />
            <SummaryCard patient={data.patient} />
            <SoftTagsCard
              patient={data.patient}
              viewAsUserId={viewAsUserId}
              onTagsChange={(next) =>
                setData((prev) =>
                  prev
                    ? {
                        ...prev,
                        patient: { ...prev.patient, softTags: next },
                      }
                    : prev,
                )
              }
            />
            <PurchasePatternsCard
              patient={data.patient}
              viewAsUserId={viewAsUserId}
              onPatientChange={(next) =>
                setData((prev) =>
                  prev ? { ...prev, patient: next } : prev,
                )
              }
            />
            <ManufacturerMixCard patient={data.patient} />
            <LoyaltyCard patient={data.patient} />
            <TransactionsSection
              transactions={data.transactions}
              windowMode={windowMode}
              onWindowChange={setWindowMode}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── Contact card ─────────────────────────────────────────────────────────

function ContactCard({ patient }: { patient: PatientListRow }) {
  const hasAny = patient.phone || patient.email || patient.banned;
  if (!hasAny) {
    return (
      <section className="rounded-xl border border-dashed border-rule bg-white/50 px-5 py-4 text-xs text-ink-soft flex items-center justify-between gap-3">
        <span>
          No contact info on file for this patient.
        </span>
        <Link
          to="/app/refill/patients/contacts"
          className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium hover:bg-rule-soft transition"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Find a match
        </Link>
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-rule bg-white px-5 py-4">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
        {patient.phone && (
          <Pair
            icon={<Phone className="h-3.5 w-3.5" />}
            label="Phone"
            value={
              <a
                href={`tel:${patient.phone}`}
                className="text-emerald hover:underline"
              >
                {formatPhone(patient.phone)}
              </a>
            }
          />
        )}
        {patient.email && (
          <Pair
            icon={<Mail className="h-3.5 w-3.5" />}
            label="Email"
            value={
              <a
                href={`mailto:${patient.email}`}
                className="text-emerald hover:underline"
              >
                {patient.email}
              </a>
            }
          />
        )}
        {patient.daysSinceLastAppointment !== null && (
          <Pair
            icon={<CalendarClock className="h-3.5 w-3.5" />}
            label="Days since last appt"
            value={patient.daysSinceLastAppointment.toLocaleString()}
          />
        )}
        {patient.banned && (
          <div className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-rose-soft text-rose px-3 py-1 text-[11px] font-semibold uppercase tracking-wider">
            <Ban className="h-3 w-3" />
            Banned — no outbound
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Summary card ─────────────────────────────────────────────────────────

function SummaryCard({ patient }: { patient: PatientListRow }) {
  return (
    <section className="rounded-xl border border-rule bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-rule bg-rule-soft/60">
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
          Lifetime
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-rule">
        <Stat
          icon={<Users className="h-3.5 w-3.5" />}
          label="Total visits"
          value={patient.totalVisits.toLocaleString()}
        />
        <Stat
          icon={<Wallet className="h-3.5 w-3.5" />}
          label="Lifetime spend"
          value={formatCurrency(patient.lifetimeSpendUsd)}
          note={
            patient.lifetimeSpendUsd !== patient.netSpendUsd
              ? `net ${formatCurrency(patient.netSpendUsd)}`
              : undefined
          }
        />
        <Stat
          icon={<Calendar className="h-3.5 w-3.5" />}
          label="First visit"
          value={patient.firstVisit ? formatDate(patient.firstVisit) : "—"}
        />
        <Stat
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          label="Last visit"
          value={patient.lastVisit ? formatDate(patient.lastVisit) : "—"}
        />
      </div>
    </section>
  );
}

// ─── Manufacturer mix card ────────────────────────────────────────────────

function ManufacturerMixCard({ patient }: { patient: PatientListRow }) {
  const entries = useMemo(
    () =>
      Object.entries(patient.productMix).sort(
        (a, b) => (b[1] ?? 0) - (a[1] ?? 0),
      ) as Array<[ProductManufacturer, number]>,
    [patient.productMix],
  );
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return (
    <section className="rounded-xl border border-rule bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
          Brand mix
        </div>
        {patient.primaryManufacturer && (
          <span className="text-[11px] text-ink-soft">
            primary{" "}
            <ManufacturerChip mfr={patient.primaryManufacturer} compact />
          </span>
        )}
      </div>
      <div className="px-5 py-4 flex flex-wrap gap-2">
        {entries.map(([mfr, count]) => (
          <ManufacturerCount
            key={mfr}
            mfr={mfr}
            count={count}
            share={count / total}
          />
        ))}
      </div>
    </section>
  );
}

function ManufacturerCount({
  mfr,
  count,
  share,
}: {
  mfr: ProductManufacturer;
  count: number;
  share: number;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-rule bg-white px-3 py-1.5 text-xs">
      <ManufacturerChip mfr={mfr} compact />
      <span className="font-medium tabular-nums">{count.toLocaleString()}</span>
      <span className="text-ink-faint tabular-nums">
        ({Math.round(share * 100)}%)
      </span>
    </div>
  );
}

// ─── Loyalty card ─────────────────────────────────────────────────────────

function LoyaltyCard({ patient }: { patient: PatientListRow }) {
  const entries = useMemo(
    () =>
      Object.entries(patient.loyaltyEngagement).sort(
        (a, b) => (b[1] ?? 0) - (a[1] ?? 0),
      ) as Array<[ProductManufacturer, number]>,
    [patient.loyaltyEngagement],
  );
  if (entries.length === 0) return null;
  return (
    <section className="rounded-xl border border-rule bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
        <Gift className="h-3.5 w-3.5 text-ink-soft" />
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
          Loyalty redemptions
        </div>
      </div>
      <div className="px-5 py-4 flex flex-wrap gap-3">
        {entries.map(([mfr, count]) => (
          <div
            key={mfr}
            className="inline-flex items-center gap-2 rounded-lg border border-rule bg-white px-3 py-2"
          >
            <ManufacturerChip mfr={mfr} compact />
            <div>
              <div className="text-sm font-semibold tabular-nums">
                {count.toLocaleString()}{" "}
                <span className="text-[11px] font-normal text-ink-soft">
                  redemption{count === 1 ? "" : "s"}
                </span>
              </div>
              <div className="text-[10px] text-ink-faint uppercase tracking-wider">
                {rewardProgramLabel(mfr)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Soft tags card (v1.31.0) ─────────────────────────────────────────────
//
// Karen-set editorial layer per Profitability Engine spec §3.2. Six tags,
// all owner-tap-set with optional reason note. Never inferred by ML — the
// only write path is this card. Visibility scope is owner-only by default
// (server fn reads scope to effectiveUserId).

type EnumDef<T extends string> = { value: T; label: string };

const INCOME_OPTIONS: EnumDef<"high" | "mid" | "low" | "unknown">[] = [
  { value: "high", label: "High" },
  { value: "mid", label: "Mid" },
  { value: "low", label: "Low" },
  { value: "unknown", label: "Unknown" },
];
const NEGOTIATOR_OPTIONS: EnumDef<"never" | "occasional" | "always">[] = [
  { value: "never", label: "Never" },
  { value: "occasional", label: "Occasional" },
  { value: "always", label: "Always" },
];
const PERSONALITY_OPTIONS: EnumDef<"easy" | "neutral" | "complainer">[] = [
  { value: "easy", label: "Easy" },
  { value: "neutral", label: "Neutral" },
  { value: "complainer", label: "Complainer" },
];
const LOYALTY_OPTIONS: EnumDef<"loyal" | "comparison" | "unknown">[] = [
  { value: "loyal", label: "Loyal" },
  { value: "comparison", label: "Comparison" },
  { value: "unknown", label: "Unknown" },
];

function SoftTagsCard({
  patient,
  viewAsUserId,
  onTagsChange,
}: {
  patient: PatientListRow;
  viewAsUserId: string | undefined;
  onTagsChange: (next: PatientSoftTags) => void;
}) {
  const [openKey, setOpenKey] = useState<PatientSoftTagKey | null>(null);
  const [busyKey, setBusyKey] = useState<PatientSoftTagKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tags = patient.softTags ?? {};

  const withToken = async (
    fn: (token: string) => Promise<{ softTags: PatientSoftTags }>,
    key: PatientSoftTagKey,
  ) => {
    setError(null);
    setBusyKey(key);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Please sign in again to save this tag.");
      const result = await fn(token);
      onTagsChange(result.softTags);
      setOpenKey(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save tag.");
    } finally {
      setBusyKey(null);
    }
  };

  const saveEnum = (
    key: Exclude<PatientSoftTagKey, "specialsSeeker" | "culturalNotes">,
    value: string,
    reason: string,
  ) =>
    withToken(
      (token) =>
        setPatientSoftTag({
          data: {
            accessToken: token,
            viewAsUserId,
            patientNodeId: patient.id,
            tag: { key, value } as never,
            reason: reason.trim() || null,
          },
        }),
      key,
    );

  const saveBool = (value: boolean, reason: string) =>
    withToken(
      (token) =>
        setPatientSoftTag({
          data: {
            accessToken: token,
            viewAsUserId,
            patientNodeId: patient.id,
            tag: { key: "specialsSeeker", value },
            reason: reason.trim() || null,
          },
        }),
      "specialsSeeker",
    );

  const saveText = (value: string, reason: string) =>
    withToken(
      (token) =>
        setPatientSoftTag({
          data: {
            accessToken: token,
            viewAsUserId,
            patientNodeId: patient.id,
            tag: { key: "culturalNotes", value },
            reason: reason.trim() || null,
          },
        }),
      "culturalNotes",
    );

  const clear = (key: PatientSoftTagKey) =>
    withToken(
      (token) =>
        clearPatientSoftTag({
          data: {
            accessToken: token,
            viewAsUserId,
            patientNodeId: patient.id,
            key,
          },
        }),
      key,
    );

  const toggleOpen = (key: PatientSoftTagKey) =>
    setOpenKey((prev) => (prev === key ? null : key));

  return (
    <section className="rounded-xl border border-rule bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-ink-soft" />
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
          Soft tags
        </div>
        <div className="ml-auto text-[10px] text-ink-faint italic">
          Karen-set · never inferred · owner-only
        </div>
      </div>
      <div className="divide-y divide-rule">
        <EnumTagRow
          label="Income tier"
          options={INCOME_OPTIONS}
          entry={tags.incomeTier ?? null}
          open={openKey === "incomeTier"}
          busy={busyKey === "incomeTier"}
          onToggle={() => toggleOpen("incomeTier")}
          onSave={(v, r) => saveEnum("incomeTier", v, r)}
          onClear={() => clear("incomeTier")}
        />
        <EnumTagRow
          label="Negotiator"
          options={NEGOTIATOR_OPTIONS}
          entry={tags.negotiator ?? null}
          open={openKey === "negotiator"}
          busy={busyKey === "negotiator"}
          onToggle={() => toggleOpen("negotiator")}
          onSave={(v, r) => saveEnum("negotiator", v, r)}
          onClear={() => clear("negotiator")}
        />
        <BoolTagRow
          label="Specials seeker"
          entry={tags.specialsSeeker ?? null}
          open={openKey === "specialsSeeker"}
          busy={busyKey === "specialsSeeker"}
          onToggle={() => toggleOpen("specialsSeeker")}
          onSave={saveBool}
          onClear={() => clear("specialsSeeker")}
        />
        <EnumTagRow
          label="Personality"
          options={PERSONALITY_OPTIONS}
          entry={tags.personality ?? null}
          open={openKey === "personality"}
          busy={busyKey === "personality"}
          onToggle={() => toggleOpen("personality")}
          onSave={(v, r) => saveEnum("personality", v, r)}
          onClear={() => clear("personality")}
        />
        <EnumTagRow
          label="Shopper loyalty"
          options={LOYALTY_OPTIONS}
          entry={tags.shopperLoyalty ?? null}
          open={openKey === "shopperLoyalty"}
          busy={busyKey === "shopperLoyalty"}
          onToggle={() => toggleOpen("shopperLoyalty")}
          onSave={(v, r) => saveEnum("shopperLoyalty", v, r)}
          onClear={() => clear("shopperLoyalty")}
        />
        <TextTagRow
          label="Cultural notes"
          entry={tags.culturalNotes ?? null}
          open={openKey === "culturalNotes"}
          busy={busyKey === "culturalNotes"}
          onToggle={() => toggleOpen("culturalNotes")}
          onSave={saveText}
          onClear={() => clear("culturalNotes")}
        />
      </div>
      <CustomTagsSection
        patient={patient}
        viewAsUserId={viewAsUserId}
        onTagsChange={onTagsChange}
      />
      {error && (
        <div className="px-5 py-3 border-t border-rose/30 bg-rose-soft text-xs text-rose">
          {error}
        </div>
      )}
    </section>
  );
}

// ─── Custom tags (v1.31.1) ────────────────────────────────────────────────

type CustomTagDraft = {
  id: string | null;
  name: string;
  value: string;
  reason: string;
};

const EMPTY_CUSTOM_DRAFT: CustomTagDraft = {
  id: null,
  name: "",
  value: "",
  reason: "",
};

function CustomTagsSection({
  patient,
  viewAsUserId,
  onTagsChange,
}: {
  patient: PatientListRow;
  viewAsUserId: string | undefined;
  onTagsChange: (next: PatientSoftTags) => void;
}) {
  const customs: PatientCustomTag[] = patient.softTags?.custom ?? [];
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CustomTagDraft>(EMPTY_CUSTOM_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const beginAdd = () => {
    setEditingId(null);
    setDraft(EMPTY_CUSTOM_DRAFT);
    setAdding(true);
  };
  const beginEdit = (tag: PatientCustomTag) => {
    setAdding(false);
    setEditingId(tag.id);
    setDraft({
      id: tag.id,
      name: tag.name,
      value: tag.value,
      reason: tag.reason ?? "",
    });
  };
  const cancel = () => {
    setAdding(false);
    setEditingId(null);
    setDraft(EMPTY_CUSTOM_DRAFT);
    setError(null);
  };

  const withToken = async (
    fn: (token: string) => Promise<{ softTags: PatientSoftTags }>,
  ) => {
    setError(null);
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Please sign in again.");
      const result = await fn(token);
      onTagsChange(result.softTags);
      cancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save tag.");
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const name = draft.name.trim();
    const value = draft.value.trim();
    if (!name || !value) return;
    if (draft.id) {
      const id = draft.id;
      void withToken((token) =>
        updatePatientCustomTag({
          data: {
            accessToken: token,
            viewAsUserId,
            patientNodeId: patient.id,
            id,
            name,
            value,
            reason: draft.reason.trim() || null,
          },
        }),
      );
    } else {
      void withToken((token) =>
        addPatientCustomTag({
          data: {
            accessToken: token,
            viewAsUserId,
            patientNodeId: patient.id,
            name,
            value,
            reason: draft.reason.trim() || null,
          },
        }),
      );
    }
  };

  const remove = (id: string) =>
    withToken((token) =>
      deletePatientCustomTag({
        data: {
          accessToken: token,
          viewAsUserId,
          patientNodeId: patient.id,
          id,
        },
      }),
    );

  return (
    <div className="border-t border-rule bg-rule-soft/30">
      <div className="px-5 py-2 flex items-center gap-2">
        <Tag className="h-3 w-3 text-ink-faint" />
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          Custom tags
        </div>
        <div className="ml-auto text-[10px] text-ink-faint">
          {customs.length} {customs.length === 1 ? "tag" : "tags"}
        </div>
      </div>
      <div className="divide-y divide-rule bg-white">
        {customs.map((tag) =>
          editingId === tag.id ? (
            <CustomTagForm
              key={tag.id}
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              onSave={save}
              onCancel={cancel}
              onDelete={() => remove(tag.id)}
            />
          ) : (
            <CustomTagRow
              key={tag.id}
              tag={tag}
              onEdit={() => beginEdit(tag)}
              disabled={busy || adding || editingId !== null}
            />
          ),
        )}
        {adding && (
          <CustomTagForm
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            onSave={save}
            onCancel={cancel}
          />
        )}
        {!adding && editingId === null && (
          <button
            type="button"
            onClick={beginAdd}
            className="w-full px-5 py-3 text-left text-[12px] text-ink-soft hover:text-ink hover:bg-rule-soft/50 transition inline-flex items-center gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Add a custom tag
          </button>
        )}
      </div>
      {error && (
        <div className="px-5 py-2 text-[11px] text-rose">{error}</div>
      )}
    </div>
  );
}

function CustomTagRow({
  tag,
  onEdit,
  disabled,
}: {
  tag: PatientCustomTag;
  onEdit: () => void;
  disabled: boolean;
}) {
  return (
    <div className="px-5 py-3 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-soft">
          {tag.name}
        </div>
        <div className="mt-1 text-[13px] text-ink whitespace-pre-wrap break-words">
          {tag.value}
        </div>
        {tag.reason && (
          <div className="mt-1 text-[12px] text-ink-soft italic">
            &ldquo;{tag.reason}&rdquo;
          </div>
        )}
        <div className="mt-1 text-[10px] text-ink-faint">
          Set {formatDate(tag.setAt.slice(0, 10))}
        </div>
      </div>
      <button
        type="button"
        onClick={onEdit}
        disabled={disabled}
        className="shrink-0 inline-flex items-center gap-1 rounded-md border border-rule bg-white px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition disabled:opacity-50"
      >
        <Pencil className="h-3 w-3" />
        Edit
      </button>
    </div>
  );
}

function CustomTagForm({
  draft,
  setDraft,
  busy,
  onSave,
  onCancel,
  onDelete,
}: {
  draft: CustomTagDraft;
  setDraft: (next: CustomTagDraft) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const canSave = draft.name.trim().length > 0 && draft.value.trim().length > 0;
  return (
    <div className="px-5 py-3 space-y-2 bg-emerald-soft/30">
      <input
        type="text"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        placeholder="Tag name (e.g., Allergies, Pet name, Preferred day)"
        maxLength={80}
        disabled={busy}
        className="w-full rounded-md border border-rule bg-white px-3 py-1.5 text-[12px] font-medium text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
      />
      <textarea
        value={draft.value}
        onChange={(e) => setDraft({ ...draft, value: e.target.value })}
        placeholder="Value (e.g., 'lidocaine sensitivity', 'Bella the maltese', 'Tuesdays only')"
        maxLength={2000}
        rows={2}
        disabled={busy}
        className="w-full rounded-md border border-rule bg-white px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
      />
      <input
        type="text"
        value={draft.reason}
        onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
        placeholder="Reason / context (optional)"
        maxLength={500}
        disabled={busy}
        className="w-full rounded-md border border-rule bg-white px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
      />
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !canSave}
          className="inline-flex items-center gap-1 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-rule bg-white px-2.5 py-1.5 text-[11px] font-medium text-ink-soft hover:text-ink transition disabled:opacity-50"
        >
          Cancel
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-rose hover:text-rose/80 transition disabled:opacity-50"
          >
            <X className="h-3 w-3" />
            Delete tag
          </button>
        )}
      </div>
    </div>
  );
}

function TagRowShell({
  label,
  entry,
  open,
  busy,
  onToggle,
  onClear,
  valuePill,
  editor,
}: {
  label: string;
  entry: PatientSoftTagEntry<unknown> | null;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onClear: () => void;
  valuePill: React.ReactNode;
  editor: React.ReactNode;
}) {
  return (
    <div className="px-5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-soft">
            {label}
          </div>
          {!open && (
            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
              {entry ? valuePill : (
                <span className="text-xs text-ink-faint italic">Not set</span>
              )}
            </div>
          )}
          {!open && entry?.reason && (
            <div className="mt-1 text-[12px] text-ink-soft italic">
              &ldquo;{entry.reason}&rdquo;
            </div>
          )}
          {!open && entry?.setAt && (
            <div className="mt-1 text-[10px] text-ink-faint">
              Set {formatDate(entry.setAt.slice(0, 10))}
            </div>
          )}
        </div>
        {!open && (
          <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-rule bg-white px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition disabled:opacity-50"
          >
            {entry ? (
              <>
                <Pencil className="h-3 w-3" />
                Edit
              </>
            ) : (
              <>
                <Tag className="h-3 w-3" />
                Set tag
              </>
            )}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          {editor}
          <div className="flex items-center gap-2 pt-1">
            {entry && (
              <button
                type="button"
                onClick={onClear}
                disabled={busy}
                className="ml-auto inline-flex items-center gap-1 text-[11px] text-rose hover:text-rose/80 transition disabled:opacity-50"
              >
                <X className="h-3 w-3" />
                Clear tag
              </button>
            )}
            <button
              type="button"
              onClick={onToggle}
              disabled={busy}
              className={
                (entry ? "" : "ml-auto ") +
                "inline-flex items-center gap-1 rounded-md border border-rule bg-white px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:text-ink transition disabled:opacity-50"
              }
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {busy && (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-ink-faint">
          <Loader2 className="h-3 w-3 animate-spin" />
          Saving…
        </div>
      )}
    </div>
  );
}

function ChipButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "rounded-full px-3 py-1 text-[11px] font-medium border transition disabled:opacity-50 " +
        (active
          ? "border-emerald bg-emerald-soft text-emerald-ink"
          : "border-rule bg-white text-ink-soft hover:border-emerald/40 hover:text-ink")
      }
    >
      {children}
    </button>
  );
}

function EnumTagRow<T extends string>({
  label,
  options,
  entry,
  open,
  busy,
  onToggle,
  onSave,
  onClear,
}: {
  label: string;
  options: EnumDef<T>[];
  entry: PatientSoftTagEntry<T> | null;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onSave: (value: T, reason: string) => void;
  onClear: () => void;
}) {
  const [draftValue, setDraftValue] = useState<T | null>(entry?.value ?? null);
  const [draftReason, setDraftReason] = useState<string>(entry?.reason ?? "");

  useEffect(() => {
    if (open) {
      setDraftValue(entry?.value ?? null);
      setDraftReason(entry?.reason ?? "");
    }
  }, [open, entry]);

  const currentLabel = entry
    ? options.find((o) => o.value === entry.value)?.label ?? String(entry.value)
    : null;

  return (
    <TagRowShell
      label={label}
      entry={entry}
      open={open}
      busy={busy}
      onToggle={onToggle}
      onClear={onClear}
      valuePill={
        <span className="inline-flex items-center rounded-full bg-emerald-soft px-3 py-1 text-[11px] font-semibold text-emerald-ink">
          {currentLabel}
        </span>
      }
      editor={
        <>
          <div className="flex flex-wrap gap-1.5">
            {options.map((opt) => (
              <ChipButton
                key={opt.value}
                active={draftValue === opt.value}
                disabled={busy}
                onClick={() => setDraftValue(opt.value)}
              >
                {opt.label}
              </ChipButton>
            ))}
          </div>
          <input
            type="text"
            value={draftReason}
            onChange={(e) => setDraftReason(e.target.value)}
            placeholder="Reason (optional) — what tipped you off?"
            maxLength={500}
            disabled={busy}
            className="w-full rounded-md border border-rule bg-white px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => draftValue !== null && onSave(draftValue, draftReason)}
            disabled={busy || draftValue === null}
            className="inline-flex items-center gap-1 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
          >
            Save
          </button>
        </>
      }
    />
  );
}

function BoolTagRow({
  label,
  entry,
  open,
  busy,
  onToggle,
  onSave,
  onClear,
}: {
  label: string;
  entry: PatientSoftTagEntry<boolean> | null;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onSave: (value: boolean, reason: string) => void;
  onClear: () => void;
}) {
  const [draftValue, setDraftValue] = useState<boolean | null>(
    entry?.value ?? null,
  );
  const [draftReason, setDraftReason] = useState<string>(entry?.reason ?? "");

  useEffect(() => {
    if (open) {
      setDraftValue(entry?.value ?? null);
      setDraftReason(entry?.reason ?? "");
    }
  }, [open, entry]);

  return (
    <TagRowShell
      label={label}
      entry={entry}
      open={open}
      busy={busy}
      onToggle={onToggle}
      onClear={onClear}
      valuePill={
        <span
          className={
            "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold " +
            (entry?.value
              ? "bg-rose-soft text-rose"
              : "bg-emerald-soft text-emerald-ink")
          }
        >
          {entry?.value ? "Yes" : "No"}
        </span>
      }
      editor={
        <>
          <div className="flex flex-wrap gap-1.5">
            <ChipButton
              active={draftValue === true}
              disabled={busy}
              onClick={() => setDraftValue(true)}
            >
              Yes
            </ChipButton>
            <ChipButton
              active={draftValue === false}
              disabled={busy}
              onClick={() => setDraftValue(false)}
            >
              No
            </ChipButton>
          </div>
          <input
            type="text"
            value={draftReason}
            onChange={(e) => setDraftReason(e.target.value)}
            placeholder="Reason (optional)"
            maxLength={500}
            disabled={busy}
            className="w-full rounded-md border border-rule bg-white px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => draftValue !== null && onSave(draftValue, draftReason)}
            disabled={busy || draftValue === null}
            className="inline-flex items-center gap-1 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
          >
            Save
          </button>
        </>
      }
    />
  );
}

function TextTagRow({
  label,
  entry,
  open,
  busy,
  onToggle,
  onSave,
  onClear,
}: {
  label: string;
  entry: PatientSoftTagEntry<string> | null;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onSave: (value: string, reason: string) => void;
  onClear: () => void;
}) {
  const [draftValue, setDraftValue] = useState<string>(entry?.value ?? "");
  const [draftReason, setDraftReason] = useState<string>(entry?.reason ?? "");

  useEffect(() => {
    if (open) {
      setDraftValue(entry?.value ?? "");
      setDraftReason(entry?.reason ?? "");
    }
  }, [open, entry]);

  return (
    <TagRowShell
      label={label}
      entry={entry}
      open={open}
      busy={busy}
      onToggle={onToggle}
      onClear={onClear}
      valuePill={
        <span className="text-[12px] text-ink whitespace-pre-wrap">
          {entry?.value}
        </span>
      }
      editor={
        <>
          <textarea
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            placeholder="Notes only Karen sees — language preference, family context, sensitivities, etc."
            maxLength={2000}
            rows={3}
            disabled={busy}
            className="w-full rounded-md border border-rule bg-white px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
          />
          <input
            type="text"
            value={draftReason}
            onChange={(e) => setDraftReason(e.target.value)}
            placeholder="Source / context (optional)"
            maxLength={500}
            disabled={busy}
            className="w-full rounded-md border border-rule bg-white px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => draftValue.trim() && onSave(draftValue.trim(), draftReason)}
            disabled={busy || draftValue.trim().length === 0}
            className="inline-flex items-center gap-1 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
          >
            Save
          </button>
        </>
      }
    />
  );
}

// ─── Purchase patterns card (v1.31.2) ─────────────────────────────────────
//
// THE differentiator per Grasshopper 2026-06-01: every engine downstream
// (no-show fill, recognition allocation, combo upsell, manufacturer-
// promoted moments, anniversary touch) targets offers against THIS
// patient's real purchase habits, not population norms. This card
// surfaces the substrate for human-readable verification.

const KIND_PRIORITY: ProductKind[] = [
  "toxin",
  "filler",
  "biostimulator",
  "device",
  "service",
  "retail",
  "reward",
];

function kindDisplayLabel(kind: ProductKind): string {
  switch (kind) {
    case "toxin":
      return "Toxin";
    case "filler":
      return "Filler";
    case "biostimulator":
      return "Biostim";
    case "device":
      return "Device";
    case "service":
      return "Service";
    case "retail":
      return "Retail";
    case "reward":
      return "Reward";
    case "payment":
      return "Payment";
    case "discount":
      return "Discount";
    case "note":
      return "Note";
    default:
      return kind;
  }
}

function PurchasePatternsCard({
  patient,
  viewAsUserId,
  onPatientChange,
}: {
  patient: PatientListRow;
  viewAsUserId: string | undefined;
  onPatientChange: (next: PatientListRow) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recompute = async () => {
    setError(null);
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Please sign in again.");
      const result = await recomputePatientPatterns({
        data: {
          accessToken: token,
          viewAsUserId,
          patientNodeId: patient.id,
        },
      });
      onPatientChange(result.patient);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't recompute.");
    } finally {
      setBusy(false);
    }
  };

  const patterns = patient.purchasePatterns;

  if (!patterns) {
    return (
      <section className="rounded-xl border border-rule bg-white overflow-hidden">
        <div className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
          <Activity className="h-3.5 w-3.5 text-ink-soft" />
          <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
            Purchase patterns
          </div>
          <div className="ml-auto text-[10px] text-ink-faint italic">
            Her individual cadence — across every kind, brand, product
          </div>
        </div>
        <div className="px-5 py-8 text-center">
          <div className="text-sm text-ink-soft">
            No purchase pattern data yet for this patient.
          </div>
          <div className="text-[12px] text-ink-faint mt-1">
            Drop your latest QB CSV to populate, or recompute from existing transactions now.
          </div>
          <button
            type="button"
            onClick={recompute}
            disabled={busy}
            className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-emerald/40 bg-emerald-soft px-3 py-1.5 text-[12px] font-semibold text-emerald-ink hover:opacity-90 transition disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Compute patterns from transactions
          </button>
          {error && (
            <div className="mt-3 text-[11px] text-rose">{error}</div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-rule bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-ink-soft" />
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
          Purchase patterns
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] text-ink-faint italic">
            Her individual cadence
          </span>
          <button
            type="button"
            onClick={recompute}
            disabled={busy}
            title="Recompute from transactions"
            className="inline-flex items-center gap-1 rounded-md border border-rule bg-white px-2 py-0.5 text-[10px] font-medium text-ink-faint hover:text-ink hover:border-emerald/40 transition disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <RefreshCw className="h-2.5 w-2.5" />
            )}
            Refresh
          </button>
        </div>
      </div>
      <PatternBand
        title="Clinical (per kind)"
        rows={Object.entries(patterns.byKind)
          .sort(
            (a, b) =>
              KIND_PRIORITY.indexOf(a[0] as ProductKind) -
              KIND_PRIORITY.indexOf(b[0] as ProductKind),
          )
          .map(([kind, metrics]) => ({
            key: kind,
            label: kindDisplayLabel(kind as ProductKind),
            metrics: metrics!,
          }))}
        emptyLabel="No clinical visits captured yet."
      />
      <PatternBand
        title="By manufacturer"
        rows={Object.entries(patterns.byManufacturer)
          .sort((a, b) => b[1]!.visitCount - a[1]!.visitCount)
          .map(([mfr, metrics]) => ({
            key: mfr,
            label: manufacturerLabel(mfr as ProductManufacturer),
            metrics: metrics!,
          }))}
        emptyLabel="No manufacturer-tagged visits yet."
        defaultLimit={5}
      />
      <PatternBand
        title="By product"
        rows={Object.entries(patterns.byProduct)
          .sort((a, b) => b[1].visitCount - a[1].visitCount)
          .map(([name, metrics]) => ({
            key: name,
            label: name,
            metrics,
          }))}
        emptyLabel="No product detail captured yet."
        defaultLimit={8}
      />
      {error && (
        <div className="px-5 py-3 border-t border-rose/30 bg-rose-soft text-xs text-rose">
          {error}
        </div>
      )}
    </section>
  );
}

type PatternRow = {
  key: string;
  label: string;
  metrics: CadenceMetrics;
};

function PatternBand({
  title,
  rows,
  emptyLabel,
  defaultLimit,
}: {
  title: string;
  rows: PatternRow[];
  emptyLabel: string;
  defaultLimit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const limit = defaultLimit ?? rows.length;
  const truncated = rows.length > limit && !expanded;
  const visible = truncated ? rows.slice(0, limit) : rows;

  return (
    <div className="border-b border-rule last:border-b-0">
      <div className="px-5 py-2 bg-rule-soft/30 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          {title}
        </div>
        {rows.length > 0 && (
          <div className="text-[10px] text-ink-faint">
            {rows.length} {rows.length === 1 ? "entry" : "entries"}
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="px-5 py-3 text-xs text-ink-faint italic">{emptyLabel}</div>
      ) : (
        <>
          <div className="divide-y divide-rule">
            {visible.map((row) => (
              <PatternRowView key={row.key} row={row} />
            ))}
          </div>
          {rows.length > limit && (
            <button
              type="button"
              onClick={() => setExpanded((p) => !p)}
              className="w-full px-5 py-2 text-left text-[11px] text-ink-soft hover:text-ink hover:bg-rule-soft/40 transition inline-flex items-center gap-1.5"
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-3 w-3" />
                  Show fewer
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" />
                  Show all {rows.length}
                </>
              )}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function PatternRowView({ row }: { row: PatternRow }) {
  const m = row.metrics;
  return (
    <div className="px-5 py-2.5 flex items-start gap-3 hover:bg-rule-soft/30 transition">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-[13px] font-medium text-ink truncate">
            {row.label}
          </div>
          <span className="text-[10px] text-ink-faint tabular-nums">
            {m.visitCount}× visit{m.visitCount === 1 ? "" : "s"}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-ink-soft tabular-nums">
          {m.lifetimeAvgDays !== null ? (
            <>
              avg <strong>{m.lifetimeAvgDays}d</strong>
              {m.recentAvgDays !== null && m.recentAvgDays !== m.lifetimeAvgDays && (
                <>
                  {" · "}recent <strong>{m.recentAvgDays}d</strong>
                </>
              )}
            </>
          ) : (
            <span className="italic text-ink-faint">single visit · no cadence yet</span>
          )}
          {m.daysSinceLastVisit !== null && (
            <>
              {" · "}last{" "}
              <strong>
                {m.daysSinceLastVisit === 0
                  ? "today"
                  : `${m.daysSinceLastVisit}d ago`}
              </strong>
            </>
          )}
          {m.lifetimeAvgDays !== null && m.daysSinceLastVisit !== null && (
            <>
              {" · "}
              <span className="text-ink-faint">
                next ~
                {Math.max(
                  0,
                  (m.recentAvgDays ?? m.lifetimeAvgDays) - m.daysSinceLastVisit,
                )}
                d
              </span>
            </>
          )}
        </div>
      </div>
      <div className="shrink-0 flex flex-col items-end gap-1">
        <StatusPill status={m.status} />
        {m.trend && <TrendChip trend={m.trend} />}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: CadenceMetrics["status"] }) {
  const config = {
    "on-cadence": {
      label: "On cadence",
      bg: "bg-emerald-soft",
      text: "text-emerald-ink",
    },
    overdue: {
      label: "Overdue",
      bg: "bg-amber-100",
      text: "text-amber-700",
    },
    lapsed: {
      label: "Lapsed",
      bg: "bg-rose-soft",
      text: "text-rose",
    },
    unknown: {
      label: "—",
      bg: "bg-rule-soft",
      text: "text-ink-faint",
    },
  }[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${config.bg} ${config.text}`}
    >
      {config.label}
    </span>
  );
}

function TrendChip({ trend }: { trend: NonNullable<CadenceMetrics["trend"]> }) {
  if (trend === "accelerating") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-ink">
        <TrendingUp className="h-2.5 w-2.5" />
        more often
      </span>
    );
  }
  if (trend === "slowing") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] text-rose">
        <TrendingDown className="h-2.5 w-2.5" />
        slowing
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-ink-faint">
      <Minus className="h-2.5 w-2.5" />
      steady
    </span>
  );
}

// ─── Transactions section ─────────────────────────────────────────────────

function TransactionsSection({
  transactions,
  windowMode,
  onWindowChange,
}: {
  transactions: PatientTransactionRow[];
  windowMode: Window;
  onWindowChange: (w: Window) => void;
}) {
  const cutoffDate = useMemo(() => {
    if (windowMode === "all") return null;
    const d = new Date();
    d.setMonth(d.getMonth() - 12);
    return d.toISOString().slice(0, 10);
  }, [windowMode]);

  const filtered = useMemo(() => {
    if (!cutoffDate) return transactions;
    return transactions.filter((t) => t.transactionDate >= cutoffDate);
  }, [transactions, cutoffDate]);

  const grouped = useMemo(() => groupByDateInvoice(filtered), [filtered]);

  return (
    <section className="rounded-xl border border-rule bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
            Transactions
          </div>
          <div className="text-[11px] text-ink-faint mt-0.5">
            {filtered.length.toLocaleString()} line
            {filtered.length === 1 ? "" : "s"} ·{" "}
            {grouped.length.toLocaleString()} invoice
            {grouped.length === 1 ? "" : "s"} ·{" "}
            {windowMode === "12mo" ? "Last 12 months" : "All time"}
          </div>
        </div>
        <WindowToggle value={windowMode} onChange={onWindowChange} />
      </div>
      {filtered.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-ink-soft">
          No transactions in this window.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-rule-soft/60">
              <tr className="text-left text-[10px] uppercase tracking-wider text-ink-soft">
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold">Product</th>
                <th className="px-4 py-3 font-semibold">Brand</th>
                <th className="px-4 py-3 font-semibold text-right">Qty</th>
                <th className="px-4 py-3 font-semibold text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {grouped.map((group) => (
                <InvoiceGroup key={group.key} group={group} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type InvoiceGroupData = {
  key: string;
  date: string;
  invoiceNum: string | null;
  lines: PatientTransactionRow[];
  totalAmount: number;
};

function groupByDateInvoice(
  txns: PatientTransactionRow[],
): InvoiceGroupData[] {
  const byKey = new Map<string, InvoiceGroupData>();
  for (const t of txns) {
    const key = `${t.transactionDate}::${t.invoiceNum ?? ""}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        date: t.transactionDate,
        invoiceNum: t.invoiceNum,
        lines: [],
        totalAmount: 0,
      };
      byKey.set(key, g);
    }
    g.lines.push(t);
    g.totalAmount += t.amountUsd;
  }
  // Already date-desc from the server fn; keep the order.
  return Array.from(byKey.values());
}

function InvoiceGroup({ group }: { group: InvoiceGroupData }) {
  return (
    <>
      {group.lines.map((line, idx) => (
        <tr
          key={line.id}
          className={
            "hover:bg-rule-soft/40 transition " +
            (idx === 0 ? "border-t-2 border-rule" : "")
          }
        >
          <td className="px-4 py-3 align-top">
            {idx === 0 ? (
              <div>
                <div className="text-sm font-medium">
                  {formatDate(group.date)}
                </div>
                {group.invoiceNum && (
                  <div className="text-[11px] text-ink-faint">
                    Invoice #{group.invoiceNum}
                  </div>
                )}
              </div>
            ) : (
              <span className="text-ink-faint">·</span>
            )}
          </td>
          <td className="px-4 py-3">
            <div className="font-medium">{line.productName}</div>
            {line.description && line.description !== line.productName && (
              <div className="text-[11px] text-ink-faint">
                {line.description}
              </div>
            )}
            {line.productKind && (
              <div className="mt-1">
                <KindChip kind={line.productKind} />
              </div>
            )}
          </td>
          <td className="px-4 py-3">
            {line.productManufacturer ? (
              <ManufacturerChip mfr={line.productManufacturer} compact />
            ) : (
              <span className="text-ink-faint text-[11px]">—</span>
            )}
          </td>
          <td className="px-4 py-3 text-right tabular-nums text-ink-soft">
            {line.quantity !== null ? line.quantity.toLocaleString() : "—"}
          </td>
          <td
            className={
              "px-4 py-3 text-right tabular-nums font-medium " +
              (line.amountUsd < 0 ? "text-emerald-700 dark:text-emerald-400" : "")
            }
          >
            {formatCurrency(line.amountUsd)}
          </td>
        </tr>
      ))}
      {group.lines.length > 1 && (
        <tr className="bg-rule/20 text-[11px] text-ink-soft">
          <td className="px-4 py-2" colSpan={4}>
            Invoice total
          </td>
          <td className="px-4 py-2 text-right tabular-nums font-semibold">
            {formatCurrency(group.totalAmount)}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────────

function Pair({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5 text-ink-faint">{icon}</div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-ink-soft font-semibold">
          {label}
        </div>
        <div className="text-sm">{value}</div>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  note,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-soft font-semibold mb-1">
        {icon}
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {note && <div className="text-[11px] text-ink-faint mt-0.5">{note}</div>}
    </div>
  );
}

function WindowToggle({
  value,
  onChange,
}: {
  value: Window;
  onChange: (w: Window) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-lg border border-rule bg-white p-0.5 text-xs">
      <button
        type="button"
        onClick={() => onChange("12mo")}
        className={
          "px-3 py-1 rounded-md font-medium transition " +
          (value === "12mo"
            ? "bg-emerald text-paper"
            : "text-ink-soft hover:text-ink")
        }
      >
        Last 12mo
      </button>
      <button
        type="button"
        onClick={() => onChange("all")}
        className={
          "px-3 py-1 rounded-md font-medium transition " +
          (value === "all"
            ? "bg-emerald text-paper"
            : "text-ink-soft hover:text-ink")
        }
      >
        All time
      </button>
    </div>
  );
}

function ManufacturerChip({
  mfr,
  compact = false,
}: {
  mfr: ProductManufacturer;
  compact?: boolean;
}) {
  const palette =
    MANUFACTURER_COLORS[mfr] ?? "bg-rule text-ink";
  return (
    <span
      className={
        "inline-flex items-center rounded-full font-semibold uppercase tracking-wider " +
        (compact
          ? "px-2 py-0.5 text-[10px] "
          : "px-2.5 py-1 text-[11px] ") +
        palette
      }
    >
      {manufacturerLabel(mfr)}
    </span>
  );
}

function KindChip({ kind }: { kind: ProductKind }) {
  const cls = KIND_COLORS[kind] ?? "bg-rule text-ink";
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
        cls
      }
    >
      {kindLabel(kind)}
    </span>
  );
}

const MANUFACTURER_COLORS: Partial<Record<ProductManufacturer, string>> = {
  evolus: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
  abbvie: "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200",
  merz: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
  galderma: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
  "abbvie-coolsculpting":
    "bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-200",
  skinceuticals:
    "bg-stone-100 text-stone-800 dark:bg-stone-500/20 dark:text-stone-200",
  eltamd: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
  neocutis: "bg-teal-100 text-teal-800 dark:bg-teal-500/20 dark:text-teal-200",
  obagi: "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-200",
  sciton: "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200",
};

const KIND_COLORS: Partial<Record<ProductKind, string>> = {
  toxin: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
  filler: "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200",
  biostimulator:
    "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-500/20 dark:text-fuchsia-200",
  device: "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200",
  retail: "bg-stone-100 text-stone-800 dark:bg-stone-500/20 dark:text-stone-200",
  reward: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
  payment: "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300",
  discount: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
  service: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
  note: "bg-rule text-ink",
};

function manufacturerLabel(mfr: ProductManufacturer): string {
  switch (mfr) {
    case "evolus":
      return "Evolus";
    case "abbvie":
      return "AbbVie";
    case "merz":
      return "Merz";
    case "galderma":
      return "Galderma";
    case "abbvie-coolsculpting":
      return "CoolSculpting";
    case "skinceuticals":
      return "SkinCeuticals";
    case "eltamd":
      return "EltaMD";
    case "neocutis":
      return "Neocutis";
    case "obagi":
      return "Obagi";
    case "revance":
      return "Revance";
    case "rha":
      return "RHA";
    case "sciton":
      return "Sciton";
    default:
      return mfr;
  }
}

function rewardProgramLabel(mfr: ProductManufacturer): string {
  switch (mfr) {
    case "evolus":
      return "Evolus Rewards";
    case "abbvie":
      return "Alle";
    case "merz":
      return "Merz Rewards";
    case "galderma":
      return "Aspire";
    default:
      return manufacturerLabel(mfr);
  }
}

function kindLabel(kind: ProductKind): string {
  switch (kind) {
    case "toxin":
      return "Toxin";
    case "filler":
      return "Filler";
    case "biostimulator":
      return "Biostim";
    case "device":
      return "Device";
    case "retail":
      return "Retail";
    case "reward":
      return "Reward";
    case "payment":
      return "Payment";
    case "discount":
      return "Discount";
    case "service":
      return "Service";
    case "note":
      return "Note";
    default:
      return kind;
  }
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Denver",
  });
}

function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!m) return e164;
  return `(${m[1]}) ${m[2]}-${m[3]}`;
}

function formatCurrency(usd: number): string {
  return usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

