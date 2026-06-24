/**
 * /app/refill/settings/manufacturers — Manufacturer Profile + AI
 * extraction (v1.34.2.1).
 *
 * Per project_recognition_allocation_engine_spec: each manufacturer has
 * a "profile" describing its loyalty/rebate program structure. Karen
 * pastes a program doc here; Refill extracts the structured tiers via
 * Claude; Karen reviews + saves. v1.34.5's Recognition Allocation engine
 * reads these profiles to know rebate-unit math.
 *
 * v1.34.2.1 ships LIST + ADD-VIA-AI + EDIT-AS-JSON + DELETE. Manual
 * structured editor (per-program / per-tier forms) is queued for a
 * follow-on; raw-JSON edit is the v1.34.2.1 fallback.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  Edit3,
  ImageUp,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  TrendingUp,
  Trophy,
  Wand2,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { SettingsTabStrip } from "@/components/refill/SettingsTabStrip";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  listManufacturerProfiles,
  upsertManufacturerProfile,
  deleteManufacturerProfile,
  aiExtractManufacturerProfile,
  type ManufacturerProfile,
} from "@/server/refill-manufacturer-profile.functions";
import {
  captureProgramSnapshotFn,
  type CaptureProgramSnapshotResult,
} from "@/server/program-intel.functions";
import type { ProgramSnapshot } from "@/lib/program-intel";
import { cn } from "@/lib/utils";

export const Route = createFileRoute(
  "/app/refill/settings/manufacturers",
)({
  component: ManufacturersPage,
});

function ManufacturersPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [profiles, setProfiles] = useState<ManufacturerProfile[]>([]);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAiModal, setShowAiModal] = useState(false);
  const [showCaptureModal, setShowCaptureModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ManufacturerProfile | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      const list = await listManufacturerProfiles({
        data: { accessToken: token, viewAsUserId },
      });
      setProfiles(list);
      setAccessToken(token);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    } finally {
      setLoading(false);
    }
  }, [viewAsUserId]);

  useEffect(() => {
    if (membership.status === "loading") return;
    void load();
  }, [membership.status, load]);

  // Deep-link from the Program tab's "Capture rewards snapshot" CTA: land here
  // with #capture and open the modal straight away (one click to the action).
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#capture") {
      setShowCaptureModal(true);
    }
  }, []);

  async function handleDelete(p: ManufacturerProfile) {
    if (!accessToken) return;
    if (!window.confirm(`Delete '${p.displayName}' profile? This can't be undone.`)) {
      return;
    }
    try {
      await deleteManufacturerProfile({
        data: {
          accessToken,
          viewAsUserId,
          manufacturer: p.manufacturer,
        },
      });
      setProfiles((prev) => prev.filter((x) => x.manufacturer !== p.manufacturer));
      toast.success(`'${p.displayName}' deleted.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete.");
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <PageHeader
        title="Manufacturer profiles"
        eyebrow="Incentives"
        description="Per-manufacturer loyalty program structure. Recognition allocation reads these to know which units a spa can earn back per tier."
        breadcrumbs={[
          { label: "Refill", to: "/app/refill" },
          { label: "Incentives", to: "/app/refill/recognition/inventory" },
          { label: "Manufacturers" },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowCaptureModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald/40 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-ink shadow-sm hover:bg-emerald-soft/40 transition"
            >
              <Camera className="h-3.5 w-3.5" />
              Capture rewards snapshot
            </button>
            <button
              type="button"
              onClick={() => setShowAiModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-3 py-1.5 text-xs font-semibold text-paper shadow-sm hover:opacity-95 transition"
            >
              <Wand2 className="h-3.5 w-3.5" />
              Add via AI
            </button>
          </div>
        }
      />

      <SettingsTabStrip active="manufacturers" />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-[960px] w-full mx-auto space-y-5">
        {loadError ? (
          <div className="rounded-2xl border border-rose/30 bg-rose-soft p-5 text-sm">
            <div className="font-semibold text-rose">Couldn't load</div>
            <p className="text-xs text-ink-soft mt-1">{loadError}</p>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading…
          </div>
        ) : profiles.length === 0 ? (
          <EmptyManufacturersState onAddAi={() => setShowAiModal(true)} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {profiles.map((p) => (
              <ProfileCard
                key={p.manufacturer}
                profile={p}
                onEdit={() => setEditingProfile(p)}
                onDelete={() => void handleDelete(p)}
              />
            ))}
          </div>
        )}
      </div>

      {showAiModal && accessToken && (
        <AiExtractModal
          accessToken={accessToken}
          viewAsUserId={viewAsUserId}
          onClose={() => setShowAiModal(false)}
          onSaved={(saved) => {
            setProfiles((prev) => {
              const idx = prev.findIndex(
                (x) => x.manufacturer === saved.manufacturer,
              );
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = saved;
                return next;
              }
              return [...prev, saved];
            });
            setShowAiModal(false);
          }}
        />
      )}

      {editingProfile && accessToken && (
        <EditProfileModal
          accessToken={accessToken}
          viewAsUserId={viewAsUserId}
          profile={editingProfile}
          onClose={() => setEditingProfile(null)}
          onSaved={(saved) => {
            setProfiles((prev) =>
              prev.map((x) =>
                x.manufacturer === saved.manufacturer ? saved : x,
              ),
            );
            setEditingProfile(null);
          }}
        />
      )}

      {showCaptureModal && accessToken && (
        <CaptureSnapshotModal
          accessToken={accessToken}
          viewAsUserId={viewAsUserId}
          onClose={() => setShowCaptureModal(false)}
        />
      )}
    </div>
  );
}

function EmptyManufacturersState({ onAddAi }: { onAddAi: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-rule bg-paper/30 p-10 text-center">
      <div className="h-12 w-12 mx-auto rounded-full bg-emerald-soft text-emerald-ink flex items-center justify-center mb-3">
        <Sparkles className="h-6 w-6" />
      </div>
      <h2 className="text-base font-semibold text-ink mb-1">
        No manufacturer profiles yet
      </h2>
      <p className="text-sm text-ink-soft max-w-md mx-auto mb-5">
        Paste a manufacturer's program doc (Allē for Business, ASPIRE
        Rewards, etc.) and Refill extracts the tier structure for you.
        Recognition allocation reads these to know which units your spa
        earns at which spend.
      </p>
      <button
        type="button"
        onClick={onAddAi}
        className="inline-flex items-center gap-2 rounded-lg bg-emerald px-4 py-2 text-sm font-semibold text-paper shadow-sm hover:opacity-95 transition"
      >
        <Wand2 className="h-4 w-4" />
        Paste a program doc
      </button>
    </div>
  );
}

function ProfileCard({
  profile,
  onEdit,
  onDelete,
}: {
  profile: ManufacturerProfile;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const programCount = profile.programs.length;
  const tierCount = profile.programs.reduce((s, p) => s + p.tiers.length, 0);
  const allBrands = Array.from(
    new Set(profile.programs.flatMap((p) => p.brands)),
  );

  return (
    <article className="rounded-2xl border border-rule bg-white p-4 flex flex-col gap-3">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-ink truncate">
            {profile.displayName}
          </h3>
          <p className="text-[10px] text-ink-faint">
            updated {new Date(profile.updatedAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 rounded border border-rule bg-white px-2 py-1 text-[11px] font-medium text-ink-soft hover:text-ink transition"
            title="Edit JSON"
          >
            <Edit3 className="h-3 w-3" />
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-1 rounded border border-rose/30 bg-white px-2 py-1 text-[11px] font-medium text-rose hover:bg-rose-soft transition"
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <Stat label="Programs" value={programCount} />
        <Stat label="Tiers" value={tierCount} />
      </div>

      {allBrands.length > 0 && (
        <div>
          <div className="text-[9px] uppercase tracking-wider text-ink-faint mb-1">
            Brands
          </div>
          <div className="flex flex-wrap gap-1">
            {allBrands.slice(0, 6).map((b) => (
              <span
                key={b}
                className="inline-flex items-center rounded-full bg-emerald-soft text-emerald-ink px-2 py-0.5 text-[10px] font-medium"
              >
                {b}
              </span>
            ))}
            {allBrands.length > 6 && (
              <span className="text-[10px] text-ink-faint">
                +{allBrands.length - 6} more
              </span>
            )}
          </div>
        </div>
      )}

      <details className="text-[11px]">
        <summary className="cursor-pointer text-ink-soft hover:text-ink">
          {programCount} program{programCount === 1 ? "" : "s"}
        </summary>
        <div className="mt-2 space-y-2">
          {profile.programs.map((p, i) => (
            <div key={i} className="rounded-lg border border-rule p-2">
              <div className="font-semibold text-ink">
                {p.name}{" "}
                <span className="text-ink-faint font-normal">· {p.period}</span>
              </div>
              <ul className="mt-1 space-y-0.5">
                {p.tiers.map((t, j) => (
                  <li key={j} className="text-ink-soft">
                    <strong className="text-ink">{t.name}</strong>{" "}
                    — spend ${t.thresholdUsd.toLocaleString()} ·{" "}
                    earn {t.unitsRebated} units
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-rule bg-paper/30 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div className="text-sm font-semibold text-ink">{value}</div>
    </div>
  );
}

function AiExtractModal({
  accessToken,
  viewAsUserId,
  onClose,
  onSaved,
}: {
  accessToken: string;
  viewAsUserId: string | undefined;
  onClose: () => void;
  onSaved: (p: ManufacturerProfile) => void;
}) {
  const [text, setText] = useState("");
  const [hintManufacturer, setHintManufacturer] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{
    manufacturer: string;
    displayName: string;
    programs: ManufacturerProfile["programs"];
    notes: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function extract() {
    setError(null);
    if (text.trim().length < 20) {
      setError("Paste at least 20 chars of the program doc.");
      return;
    }
    setExtracting(true);
    try {
      const result = await aiExtractManufacturerProfile({
        data: {
          accessToken,
          viewAsUserId,
          text,
          hintManufacturer: hintManufacturer.trim() || undefined,
        },
      });
      setPreview({
        manufacturer: result.manufacturer,
        displayName: result.displayName,
        programs: result.extracted.map((p) => ({
          name: p.name,
          period: p.period,
          tiers: p.tiers.map((t) => ({
            name: t.name,
            thresholdUsd: t.thresholdUsd,
            unitsRebated: t.unitsRebated,
            notes: t.notes ?? null,
          })),
          brands: p.brands,
          cooldownMonths: p.cooldownMonths ?? null,
        })),
        notes: result.notes,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extraction failed.");
    } finally {
      setExtracting(false);
    }
  }

  async function save() {
    if (!preview) return;
    setSaving(true);
    try {
      const saved = await upsertManufacturerProfile({
        data: {
          accessToken,
          viewAsUserId,
          manufacturer: preview.manufacturer,
          displayName: preview.displayName,
          programs: preview.programs.map((p) => ({
            name: p.name,
            period: p.period,
            tiers: p.tiers.map((t) => ({
              name: t.name,
              thresholdUsd: t.thresholdUsd,
              unitsRebated: t.unitsRebated,
              notes: t.notes,
            })),
            brands: p.brands,
            cooldownMonths: p.cooldownMonths,
          })),
          notes: preview.notes,
        },
      });
      toast.success(`'${saved.displayName}' saved.`);
      onSaved(saved);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl max-h-[calc(100vh-2rem)] flex flex-col rounded-2xl border border-rule bg-white shadow-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-rule bg-emerald-soft/40 flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-emerald-ink" />
          <div className="text-[13px] font-semibold text-emerald-ink">
            Extract manufacturer profile from program doc
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-ink-soft hover:text-ink transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {!preview ? (
            <>
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
                  Manufacturer hint (optional)
                </label>
                <input
                  type="text"
                  value={hintManufacturer}
                  onChange={(e) => setHintManufacturer(e.target.value)}
                  placeholder="allergan, galderma, merz, revance…"
                  className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                />
                <p className="text-[10px] text-ink-faint mt-0.5">
                  Helps the AI when the doc doesn't say the manufacturer name explicitly.
                </p>
              </div>
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
                  Program doc text
                </label>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Paste the manufacturer's program structure here — tier names, spend thresholds, units rebated, eligible brands…"
                  className="w-full h-72 rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30 font-mono"
                />
                <p className="text-[10px] text-ink-faint mt-0.5">
                  {text.length.toLocaleString()} chars · paste from email, PDF, or web page
                </p>
              </div>
              {error && (
                <div className="rounded border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose">
                  {error}
                </div>
              )}
            </>
          ) : (
            <PreviewEditor
              preview={preview}
              onChange={setPreview}
            />
          )}
        </div>

        <div className="px-5 py-3 border-t border-rule bg-rule-soft/30 flex items-center gap-2">
          {!preview ? (
            <button
              type="button"
              onClick={() => void extract()}
              disabled={extracting}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
            >
              {extracting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wand2 className="h-3.5 w-3.5" />
              )}
              {extracting ? "Extracting…" : "Extract"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                Save profile
              </button>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="inline-flex items-center gap-1 rounded-md border border-rule bg-white px-3 py-2 text-[12px] font-medium text-ink-soft hover:text-ink transition"
              >
                <ArrowLeft className="h-3 w-3" />
                Re-extract
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={extracting || saving}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-rule bg-white px-3 py-2 text-[12px] font-medium text-ink-soft hover:text-ink transition disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewEditor({
  preview,
  onChange,
}: {
  preview: NonNullable<Parameters<typeof JSON.stringify>[0]> & {
    manufacturer: string;
    displayName: string;
    programs: ManufacturerProfile["programs"];
    notes: string | null;
  };
  onChange: (p: typeof preview) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded border border-emerald/30 bg-emerald-soft/40 px-3 py-2 text-[11px] text-emerald-ink flex items-center gap-2">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Extracted. Review below + edit the JSON if anything is off.
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
            Manufacturer key (lowercase)
          </label>
          <input
            type="text"
            value={preview.manufacturer}
            onChange={(e) =>
              onChange({ ...preview, manufacturer: e.target.value.toLowerCase().trim() })
            }
            className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
          />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
            Display name
          </label>
          <input
            type="text"
            value={preview.displayName}
            onChange={(e) => onChange({ ...preview, displayName: e.target.value })}
            className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
          />
        </div>
      </div>
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
          Programs (JSON)
        </label>
        <textarea
          value={JSON.stringify(preview.programs, null, 2)}
          onChange={(e) => {
            try {
              const parsed = JSON.parse(e.target.value);
              if (Array.isArray(parsed)) {
                onChange({ ...preview, programs: parsed });
              }
            } catch {
              // ignore mid-typing parse errors
            }
          }}
          className="w-full h-72 rounded border border-rule bg-white px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald/30"
        />
      </div>
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
          Notes
        </label>
        <textarea
          value={preview.notes ?? ""}
          onChange={(e) => onChange({ ...preview, notes: e.target.value || null })}
          className="w-full h-16 rounded border border-rule bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald/30"
        />
      </div>
    </div>
  );
}

function EditProfileModal({
  accessToken,
  viewAsUserId,
  profile,
  onClose,
  onSaved,
}: {
  accessToken: string;
  viewAsUserId: string | undefined;
  profile: ManufacturerProfile;
  onClose: () => void;
  onSaved: (p: ManufacturerProfile) => void;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [programsText, setProgramsText] = useState(
    JSON.stringify(profile.programs, null, 2),
  );
  const [notes, setNotes] = useState(profile.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    let programs: ManufacturerProfile["programs"];
    try {
      programs = JSON.parse(programsText);
    } catch {
      setError("Programs JSON is malformed.");
      return;
    }
    if (!Array.isArray(programs) || programs.length === 0) {
      setError("Programs must be a non-empty array.");
      return;
    }
    setSaving(true);
    try {
      const saved = await upsertManufacturerProfile({
        data: {
          accessToken,
          viewAsUserId,
          manufacturer: profile.manufacturer,
          displayName,
          programs,
          notes: notes.trim() || null,
        },
      });
      toast.success("Profile updated.");
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl max-h-[calc(100vh-2rem)] flex flex-col rounded-2xl border border-rule bg-white shadow-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
          <Edit3 className="h-4 w-4 text-ink-soft" />
          <div className="text-[13px] font-semibold text-ink">
            Edit {profile.displayName}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-ink-soft hover:text-ink transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
              Display name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
              Programs (JSON)
            </label>
            <textarea
              value={programsText}
              onChange={(e) => setProgramsText(e.target.value)}
              className="w-full h-72 rounded border border-rule bg-white px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald/30"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full h-16 rounded border border-rule bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald/30"
            />
          </div>
          {error && (
            <div className="rounded border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose">
              {error}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-rule bg-rule-soft/30 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Save
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-rule bg-white px-3 py-2 text-[12px] font-medium text-ink-soft hover:text-ink transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Capture rewards snapshot (Slice 2: vision dashboard → program_snapshots) ──

const CAPTURE_MANUFACTURER_HINTS: Array<{ value: string; label: string }> = [
  { value: "", label: "Auto-detect (let vision decide)" },
  { value: "galderma", label: "Galderma (ASPIRE)" },
  { value: "abbvie", label: "Allergan / AbbVie (Allē for Business)" },
  { value: "evolus", label: "Evolus Rewards" },
  { value: "merz", label: "Merz" },
  { value: "revance", label: "Revance" },
];

const CAPTURE_OK_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
type CaptureImageMedia = (typeof CAPTURE_OK_IMAGE_TYPES)[number];
type CaptureImagePayload = {
  data: string;
  mediaType: CaptureImageMedia;
  name: string;
  previewUrl: string;
};

/** Read a File into the base64 payload the engine expects (no data: prefix). */
function captureFileToPayload(file: File): Promise<CaptureImagePayload> {
  return new Promise((resolve, reject) => {
    if (!CAPTURE_OK_IMAGE_TYPES.includes(file.type as CaptureImageMedia)) {
      reject(new Error(`${file.name}: use a PNG, JPEG, WebP, or GIF image.`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const base64 = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
      if (!base64) {
        reject(new Error(`${file.name}: couldn't read that image.`));
        return;
      }
      resolve({
        data: base64,
        mediaType: file.type as CaptureImageMedia,
        name: file.name,
        previewUrl: result,
      });
    };
    reader.onerror = () => reject(new Error(`${file.name}: read failed.`));
    reader.readAsDataURL(file);
  });
}

function captureManufacturerLabel(key: string): string {
  if (!key) return "Unknown manufacturer";
  return (
    CAPTURE_MANUFACTURER_HINTS.find((m) => m.value === key)?.label ??
    key.charAt(0).toUpperCase() + key.slice(1)
  );
}

function CaptureSnapshotModal({
  accessToken,
  viewAsUserId,
  onClose,
}: {
  accessToken: string;
  viewAsUserId: string | undefined;
  onClose: () => void;
}) {
  const [manufacturer, setManufacturer] = useState("");
  const [images, setImages] = useState<CaptureImagePayload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [result, setResult] = useState<CaptureProgramSnapshotResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    try {
      const payloads = await Promise.all(list.map(captureFileToPayload));
      setImages((prev) => [...prev, ...payloads].slice(0, 8)); // engine caps at 8
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read that image.");
    }
  }, []);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
  }

  async function onCapture() {
    if (capturing || images.length === 0) return;
    setCapturing(true);
    try {
      const res = await captureProgramSnapshotFn({
        data: {
          accessToken,
          viewAsUserId,
          manufacturer: manufacturer || undefined,
          images: images.map((im) => ({ data: im.data, mediaType: im.mediaType })),
        },
      });
      setResult(res);
      toast.success("Snapshot captured — your live program standing is now in Refill.", {
        duration: 7000,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read that dashboard.", {
        duration: 10000,
      });
    } finally {
      setCapturing(false);
    }
  }

  function reset() {
    setResult(null);
    setImages([]);
    setManufacturer("");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl max-h-[calc(100vh-2rem)] flex flex-col rounded-2xl border border-rule bg-white shadow-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-rule bg-emerald-soft/40 flex items-center gap-2">
          <Camera className="h-4 w-4 text-emerald-ink" />
          <div className="text-[13px] font-semibold text-emerald-ink">
            Capture your rewards-dashboard standing
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-ink-soft hover:text-ink transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {!result ? (
            <>
              <p className="text-[12px] text-ink-soft leading-relaxed">
                Snap or upload your manufacturer <strong className="text-ink">rewards dashboard</strong> —
                the page that shows your <em>tier, points, and rebate trackers</em> (Galderma ASPIRE
                Program Details, Allē for Business, Evolus Rewards…). We read where you stand and keep it
                in Refill so Incentives can show your live progress and the “what changed” diff over time.
                These are the auth-walled numbers no spreadsheet can reach — only a photo from inside your
                own account.
              </p>

              <div>
                <label className="text-[10px] uppercase tracking-wider font-semibold text-ink-soft mb-1.5 block">
                  Manufacturer (optional)
                </label>
                <select
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                  disabled={capturing}
                  className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                >
                  {CAPTURE_MANUFACTURER_HINTS.map((m) => (
                    <option key={m.value || "auto"} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "rounded-xl border-2 border-dashed px-6 py-9 text-center transition cursor-pointer",
                  dragging
                    ? "border-emerald bg-emerald-soft"
                    : "border-rule bg-paper/40 hover:border-emerald/40",
                )}
              >
                <div className="mx-auto inline-flex items-center justify-center rounded-full bg-emerald-soft p-3">
                  <ImageUp className="h-6 w-6 text-emerald" />
                </div>
                <h3 className="mt-3 text-[15px] font-semibold text-ink">
                  Drop a rewards-dashboard screenshot
                </h3>
                <p className="mt-1.5 text-[12px] text-ink-soft max-w-md mx-auto leading-relaxed">
                  The tier / points / rebate-tracker screen from your manufacturer rewards portal. Phone
                  screenshot or desktop capture — up to 8 images for a multi-tab dashboard.
                </p>
                <span className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition">
                  <Camera className="h-4 w-4" />
                  Choose image
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) void addFiles(e.target.files);
                    e.target.value = ""; // allow re-picking the same file
                  }}
                />
              </div>

              {images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {images.map((im, i) => (
                    <div
                      key={`${im.name}-${i}`}
                      className="relative group rounded-lg border border-rule overflow-hidden bg-bg-soft"
                    >
                      <img src={im.previewUrl} alt={im.name} className="h-20 w-28 object-cover" />
                      <button
                        type="button"
                        onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                        className="absolute top-1 right-1 inline-flex items-center justify-center rounded-full bg-white/90 p-0.5 text-ink-soft hover:text-rose shadow-sm"
                        title="Remove"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <SnapshotReadout snapshot={result.snapshot} />
          )}
        </div>

        <div className="px-5 py-3 border-t border-rule bg-rule-soft/30 flex items-center gap-2">
          {!result ? (
            <>
              <button
                type="button"
                onClick={() => void onCapture()}
                disabled={capturing || images.length === 0}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-[13px] font-semibold shadow-sm transition",
                  capturing || images.length === 0
                    ? "bg-rule text-ink-faint cursor-not-allowed"
                    : "bg-emerald text-paper hover:opacity-95",
                )}
              >
                {capturing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Reading {images.length} {images.length === 1 ? "image" : "images"}…
                  </>
                ) : images.length === 0 ? (
                  <>
                    <ImageUp className="h-3.5 w-3.5" />
                    Add a screenshot first
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5" />
                    Capture snapshot
                  </>
                )}
              </button>
              {images.length > 0 && !capturing && (
                <button
                  type="button"
                  onClick={() => setImages([])}
                  className="text-[12px] text-ink-soft hover:text-ink transition"
                >
                  Clear
                </button>
              )}
            </>
          ) : (
            <>
              <Link
                to="/app/refill/recognition/program"
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
              >
                <TrendingUp className="h-3.5 w-3.5" />
                View your standing
              </Link>
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-1 rounded-md border border-rule bg-white px-3 py-2 text-[12px] font-medium text-ink-soft hover:text-ink transition"
              >
                <Camera className="h-3 w-3" />
                Capture another
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={capturing}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-rule bg-white px-3 py-2 text-[12px] font-medium text-ink-soft hover:text-ink transition disabled:opacity-50"
          >
            {result ? "Done" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SnapshotReadout({ snapshot }: { snapshot: ProgramSnapshot }) {
  const statusCfg: Record<
    ProgramSnapshot["rebates"][number]["status"],
    { label: string; cls: string }
  > = {
    achieved: { label: "Achieved", cls: "bg-emerald/10 text-emerald-ink" },
    in_progress: { label: "In progress", cls: "bg-amber-soft text-amber-ink" },
    not_eligible: { label: "Not eligible", cls: "bg-rule-soft text-ink-soft" },
  };

  return (
    <div className="space-y-4">
      <div className="rounded border border-emerald/30 bg-emerald-soft/40 px-3 py-2 text-[11px] text-emerald-ink flex items-center gap-2">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        Captured just now from {captureManufacturerLabel(snapshot.manufacturer)} — here’s what we read.
        It’s live in Incentives, and we’ll diff your next capture against it.
      </div>

      {/* Tier standing */}
      <div className="rounded-xl border border-rule bg-paper/30 px-4 py-3 flex items-center gap-3">
        <div className="inline-flex items-center justify-center rounded-full bg-emerald-soft p-2 shrink-0">
          <Trophy className="h-5 w-5 text-emerald" />
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-ink">
            {snapshot.currentTier ?? "Tier not shown"}
          </div>
          <div className="text-[12px] text-ink-soft">
            {snapshot.pointsCurrent != null
              ? `${snapshot.pointsCurrent.toLocaleString()} points`
              : "Points not shown"}
            {snapshot.pointsToNextTier != null
              ? ` · ${snapshot.pointsToNextTier.toLocaleString()} to next level`
              : ""}
          </div>
        </div>
      </div>

      {/* Rebate trackers */}
      {snapshot.rebates.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1.5">
            Rebate trackers
          </div>
          <div className="space-y-2">
            {snapshot.rebates.map((r) => {
              const s = statusCfg[r.status];
              return (
                <div key={r.key} className="rounded-lg border border-rule px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[13px] font-semibold text-ink truncate">
                      {r.label}
                      {r.rebatePct != null && (
                        <span className="text-ink-faint font-normal"> · {r.rebatePct}%</span>
                      )}
                    </div>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider shrink-0",
                        s.cls,
                      )}
                    >
                      {s.label}
                    </span>
                  </div>
                  {r.note && <p className="mt-0.5 text-[11px] text-ink-soft">{r.note}</p>}
                  {r.requirements.length > 0 && (
                    <p className="mt-0.5 text-[10px] text-ink-faint">
                      {r.requirements.length} tracked product
                      {r.requirements.length === 1 ? "" : "s"}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tiers + pricing summary */}
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <Stat label="Membership levels read" value={snapshot.tiers.length} />
        <Stat label="Signature prices read" value={snapshot.pricing.length} />
      </div>
    </div>
  );
}
