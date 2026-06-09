/**
 * /app/refill/recognition/manufacturers — Manufacturer Profile + AI
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

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  CheckCircle2,
  Edit3,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { RecognitionTabs } from "@/components/refill/RecognitionTabs";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  listManufacturerProfiles,
  upsertManufacturerProfile,
  deleteManufacturerProfile,
  aiExtractManufacturerProfile,
  type ManufacturerProfile,
} from "@/server/refill-manufacturer-profile.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute(
  "/app/refill/recognition/manufacturers",
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
        eyebrow="Promos"
        description="Per-manufacturer loyalty program structure. Recognition allocation reads these to know which units a spa can earn back per tier."
        breadcrumbs={[
          { label: "Refill", to: "/app/refill" },
          { label: "Promos", to: "/app/refill/recognition/inventory" },
          { label: "Manufacturers" },
        ]}
        actions={
          <button
            type="button"
            onClick={() => setShowAiModal(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-3 py-1.5 text-xs font-semibold text-paper shadow-sm hover:opacity-95 transition"
          >
            <Wand2 className="h-3.5 w-3.5" />
            Add via AI
          </button>
        }
      />

      <RecognitionTabs active="manufacturers" />

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
