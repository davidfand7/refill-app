/**
 * /app/refill/settings/brand — "Your Brand" editor (v2.66.0,
 * project_your_brand_white_label).
 *
 * The GET to v2.65.0's give. Two tiers, one page:
 *   FREE — name your assistant. Always editable, always honored.
 *   PAID — white-label the patient experience: your brand name, accent color,
 *          logo, and removing "powered by SmartSpa".
 *
 * GIVE BEFORE YOU GET (feedback_give_before_you_get): a non-entitled spa can
 * fully set up AND live-preview the white-label here for free — they only pay
 * to flip it live (entitled). The preview shows the branded result so the value
 * is felt before the paywall, never hidden behind it.
 *
 * The entitlement gate lives server-side in resolveBrand (the paid fields are
 * inert until entitled AND branding_active). This page reads `entitled` only to
 * tailor copy (upgrade banner vs "live" confirmation) — it never enforces.
 *
 * Impersonation: viewAsUserId threaded through read + write, mirroring
 * spa-profile. Live preview uses the pure mergeBrand() from @/lib/brand.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Loader2,
  Lock,
  Palette,
  Sparkles,
  Wand2,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getBrandSettingsFn,
  setBrandSettingsFn,
  setWhiteLabelAddonFn,
  type BrandSettingsBundle,
} from "@/server/brand-settings.functions";
import {
  REFILL_BRAND,
  mergeBrand,
  whiteLabelPriceLabel,
} from "@/lib/brand";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/settings/brand")({
  component: BrandPage,
});

type Draft = Omit<BrandSettingsBundle, "entitled">;

const EMPTY_DRAFT: Draft = {
  assistantName: null,
  brandDisplayName: null,
  accentColor: null,
  logoUrl: null,
  removePoweredBy: false,
  brandingActive: false,
};

function toDraft(b: BrandSettingsBundle): Draft {
  const { entitled: _entitled, ...rest } = b;
  return rest;
}

function BrandPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addonBusy, setAddonBusy] = useState(false);
  const [entitled, setEntitled] = useState(false);
  const [server, setServer] = useState<Draft>(EMPTY_DRAFT);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  useEffect(() => {
    if (membership.status !== "tenant") return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const result = await getBrandSettingsFn({
          data: { accessToken: token, viewAsUserId },
        });
        if (cancelled) return;
        setEntitled(result.entitled);
        const d = toDraft(result);
        setServer(d);
        setDraft(d);
      } catch (err) {
        if (!cancelled) {
          toast.error(
            err instanceof Error ? err.message : "Couldn't load brand settings.",
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

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(server),
    [draft, server],
  );
  const canSave = !saving && !loading && dirty;

  // Live preview: force the paid gate ON so the owner always sees what patients
  // WOULD see when their brand is live — the give-before-you-get sell. The real
  // live behavior is gated server-side by resolveBrand (entitled AND active).
  const preview = useMemo(
    () =>
      mergeBrand(REFILL_BRAND, {
        assistantName: draft.assistantName,
        brandDisplayName: draft.brandDisplayName,
        accentColor: draft.accentColor,
        logoUrl: draft.logoUrl,
        removePoweredBy: draft.removePoweredBy,
        brandingActive: true,
        entitled: true,
      }),
    [draft],
  );

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      await setBrandSettingsFn({
        data: {
          accessToken: token,
          viewAsUserId,
          assistantName: draft.assistantName,
          brandDisplayName: draft.brandDisplayName,
          accentColor: draft.accentColor,
          logoUrl: draft.logoUrl,
          removePoweredBy: draft.removePoweredBy,
          brandingActive: draft.brandingActive,
        },
      });
      setServer(draft);
      toast.success("Brand saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  // v2.68.0 — self-serve start/cancel of the paid white-label add-on. Flips
  // `entitled` (which both unlocks the paid fields and triggers the $29/mo line
  // on the monthly invoice). No hard card gate — the invoice push is graceful
  // without one; the banner nudges the owner to add a card in Billing.
  async function toggleAddon(active: boolean) {
    if (addonBusy) return;
    setAddonBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      await setWhiteLabelAddonFn({
        data: { accessToken: token, viewAsUserId, active },
      });
      setEntitled(active);
      toast.success(
        active
          ? "White-label is on — set your brand below and flip it live."
          : "White-label add-on cancelled.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the add-on.");
    } finally {
      setAddonBusy(false);
    }
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div>
      <PageHeader
        title="Your Brand"
        description="Make the patient experience yours — name your assistant, then white-label every patient-facing surface with your own name, color, and logo."
      />

      <div className="px-6 lg:px-10 py-6 max-w-5xl w-full mx-auto">
        <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
          {/* ── Editor ─────────────────────────────────────────────── */}
          <form onSubmit={onSave} className="space-y-6 min-w-0">
            {/* FREE: assistant name */}
            <section className="rounded-xl border border-rule bg-white p-5">
              <div className="flex items-center gap-2 mb-1">
                <div className="rounded-full bg-emerald-soft p-1.5">
                  <Wand2 className="h-4 w-4 text-emerald" />
                </div>
                <h2 className="text-[15px] font-semibold text-ink">
                  Name your assistant
                </h2>
                <span className="ml-auto inline-flex items-center rounded-full bg-emerald-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald">
                  Free
                </span>
              </div>
              <p className="text-[12px] text-ink-soft mb-3 leading-relaxed">
                Give the assistant behind your patient messages a name. Free, on
                every plan.
              </p>
              <input
                type="text"
                value={draft.assistantName ?? ""}
                onChange={(e) => set("assistantName", e.target.value || null)}
                placeholder={REFILL_BRAND.name}
                maxLength={60}
                disabled={loading || saving}
                className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 disabled:opacity-60"
              />
            </section>

            {/* PAID: white-label */}
            <section className="rounded-xl border border-rule bg-white p-5 space-y-5">
              <div className="flex items-center gap-2">
                <div className="rounded-full bg-amber-soft p-1.5">
                  <Sparkles className="h-4 w-4 text-amber" />
                </div>
                <h2 className="text-[15px] font-semibold text-ink">
                  White-label your patient experience
                </h2>
                <span className="ml-auto inline-flex items-center rounded-full bg-amber-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber">
                  Paid add-on
                </span>
              </div>

              {/* Entitlement banner + self-serve start/cancel */}
              {entitled ? (
                <div className="rounded-lg border border-emerald/30 bg-emerald-soft/50 px-3 py-2.5 space-y-2">
                  <div className="flex items-start gap-2 text-[12px] text-emerald">
                    <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>
                      White-label is active ({whiteLabelPriceLabel()}, billed on
                      your monthly invoice). Fill it in below and flip{" "}
                      <strong>Make my brand live</strong> on — patients will see
                      your brand everywhere.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void toggleAddon(false)}
                    disabled={addonBusy}
                    className="text-[12px] text-ink-soft hover:text-ink underline underline-offset-2 disabled:opacity-50"
                  >
                    {addonBusy ? "Working…" : "Cancel add-on"}
                  </button>
                </div>
              ) : (
                <div className="rounded-lg border border-amber/30 bg-amber-soft/50 px-3 py-2.5 space-y-2.5">
                  <div className="flex items-start gap-2 text-[12px] text-ink">
                    <Lock className="h-4 w-4 mt-0.5 shrink-0 text-amber" />
                    <span>
                      Set it all up and preview it free below — then turn it on to
                      go live for patients.{" "}
                      <strong className="text-amber">
                        {whiteLabelPriceLabel()}
                      </strong>
                      , billed on your usual monthly invoice (make sure a card is
                      on file in{" "}
                      <a href="/app/billing" className="underline underline-offset-2">
                        Billing
                      </a>
                      ).
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void toggleAddon(true)}
                    disabled={addonBusy}
                    className="inline-flex items-center gap-1.5 rounded-md bg-amber px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-50"
                  >
                    {addonBusy ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Starting…
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5" />
                        Start white-label — {whiteLabelPriceLabel()}
                      </>
                    )}
                  </button>
                </div>
              )}

              <Field
                label="Brand name"
                caption="Replaces “SmartSpa” on every patient-facing surface (claim pages, booking, emails)."
                value={draft.brandDisplayName ?? ""}
                onChange={(v) => set("brandDisplayName", v || null)}
                placeholder="Karen’s Skin Studio"
                maxLength={60}
                disabled={loading || saving}
              />

              {/* Accent color */}
              <div>
                <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
                  Accent color
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={draft.accentColor ?? REFILL_BRAND.visual.accent}
                    onChange={(e) => set("accentColor", e.target.value)}
                    disabled={loading || saving}
                    className="h-9 w-12 rounded-md border border-rule bg-white p-0.5 cursor-pointer disabled:opacity-60"
                    aria-label="Accent color picker"
                  />
                  <input
                    type="text"
                    value={draft.accentColor ?? ""}
                    onChange={(e) => set("accentColor", e.target.value || null)}
                    placeholder={REFILL_BRAND.visual.accent}
                    disabled={loading || saving}
                    className="w-32 rounded-md border border-rule bg-white px-3 py-2 text-[14px] font-mono text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 disabled:opacity-60"
                  />
                  {draft.accentColor && (
                    <button
                      type="button"
                      onClick={() => set("accentColor", null)}
                      className="text-[12px] text-ink-soft hover:text-ink"
                    >
                      Reset
                    </button>
                  )}
                </div>
                <p className="text-[12px] text-ink-soft mt-1.5">
                  Used for buttons + highlights. Blank = SmartSpa green.
                </p>
              </div>

              <Field
                label="Logo URL"
                caption="A public link to your logo image (PNG/SVG). Blank = a letter badge from your brand name."
                value={draft.logoUrl ?? ""}
                onChange={(v) => set("logoUrl", v || null)}
                placeholder="https://yourspa.com/logo.png"
                type="url"
                disabled={loading || saving}
              />

              {/* Remove powered-by */}
              <Toggle
                label="Remove “powered by SmartSpa”"
                caption="Hide the SmartSpa footer credit on patient pages."
                checked={draft.removePoweredBy}
                onChange={(v) => set("removePoweredBy", v)}
                disabled={loading || saving}
              />

              {/* Master switch */}
              <Toggle
                label="Make my brand live"
                caption={
                  entitled
                    ? "Turn the white-label on for all patients."
                    : "Saved now; takes effect the moment you upgrade."
                }
                checked={draft.brandingActive}
                onChange={(v) => set("brandingActive", v)}
                disabled={loading || saving}
              />
            </section>

            {/* Save bar */}
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={!canSave}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition",
                  canSave
                    ? "bg-emerald text-paper hover:opacity-95"
                    : "bg-rule text-ink-faint cursor-not-allowed",
                )}
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving&hellip;
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    Save
                  </>
                )}
              </button>
              {dirty && !saving && (
                <button
                  type="button"
                  onClick={() => setDraft(server)}
                  className="text-[13px] text-ink-soft hover:text-ink transition"
                >
                  Revert
                </button>
              )}
              {loading && (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading&hellip;
                </span>
              )}
            </div>
          </form>

          {/* ── Live preview ───────────────────────────────────────── */}
          <div className="lg:sticky lg:top-6 self-start">
            <div className="flex items-center gap-1.5 mb-2 text-[11px] uppercase tracking-wider font-semibold text-ink-faint">
              <Palette className="h-3.5 w-3.5" />
              Live preview — what patients see
            </div>
            <ClaimPreview brand={preview} />
            <p className="text-[11px] text-ink-soft mt-2 leading-relaxed">
              A sample &ldquo;slot just opened&rdquo; claim page rendered with
              your brand{entitled ? "" : " (this is what goes live when you upgrade)"}.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Mini rescue-claim card preview, styled by the resolved brand. */
function ClaimPreview({
  brand,
}: {
  brand: ReturnType<typeof mergeBrand>;
}) {
  return (
    <div className="rounded-2xl border border-[#e2dfd6] bg-white p-6 shadow-sm">
      <div className="flex items-center justify-center mb-3">
        {brand.logoUrl ? (
          <img
            src={brand.logoUrl}
            alt={brand.name}
            className="h-10 max-w-[160px] object-contain"
          />
        ) : (
          <div
            className="h-10 w-10 rounded-full flex items-center justify-center text-white font-bold text-lg"
            style={{ backgroundColor: brand.accent }}
          >
            {brand.logoMark}
          </div>
        )}
      </div>
      <h3 className="text-[17px] font-semibold text-center text-[#1c2024] mb-1">
        Jamie, an opening just came up
      </h3>
      <p className="text-[12px] text-[#5a6068] text-center mb-4">
        {brand.name} just had a cancellation. Tap below to grab it before anyone
        else does.
      </p>
      <div className="rounded-lg bg-[#f4f1ea] border border-[#e2dfd6] p-3 mb-4 space-y-1 text-[12px]">
        <div className="flex justify-between">
          <span className="text-[#5a6068]">When</span>
          <span className="font-medium text-[#1c2024]">Fri, 2:30 PM</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#5a6068]">Treatment</span>
          <span className="font-medium text-[#1c2024]">Tox</span>
        </div>
      </div>
      <button
        type="button"
        className="w-full rounded-md px-4 py-2.5 text-[14px] font-semibold text-white"
        style={{ backgroundColor: brand.accent }}
      >
        Grab this slot
      </button>
      {!brand.removePoweredBy && (
        <p className="text-[10px] text-[#a3a8ae] text-center mt-3">
          powered by SmartSpa
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  caption,
  value,
  onChange,
  placeholder,
  type = "text",
  maxLength,
  disabled,
}: {
  label: string;
  caption: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  maxLength?: number;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 disabled:opacity-60"
      />
      <p className="text-[12px] text-ink-soft mt-1.5 leading-relaxed">{caption}</p>
    </div>
  );
}

function Toggle({
  label,
  caption,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  caption: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-ink">{label}</p>
        <p className="text-[12px] text-ink-soft mt-0.5 leading-relaxed">
          {caption}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50",
          checked ? "bg-emerald" : "bg-rule",
        )}
      >
        <span
          className={cn(
            "inline-block h-5 w-5 transform rounded-full bg-white shadow transition",
            checked ? "translate-x-5" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}
