/**
 * /app/refill/settings/spa-profile — Editor for the three knowledge_nodes
 * spa-profile scalars (spa-name, owner-display-name, from-number).
 *
 * Pre-v1.26.22 these scalars were set via direct SQL paste only — no
 * surface in-app for a spa owner (or admin viewing-as) to update them.
 * v1.26.19 collapsed the three readers onto a single emma-spa-profile.ts
 * module, which made this editor a one-import-target ship.
 *
 * Editor shape: three always-visible inputs + a single Save button that
 * fires only the keys that changed. Per-field save buttons would have
 * been clearer-but-noisier; single Save matches the mental model that
 * these are co-located tenant config, not three independent settings.
 *
 * Impersonation: useTenantMembership.viewAsUserId is threaded through
 * both read and write fns. Admin viewing-as Karen edits Karen's bucket;
 * Karen herself edits her own.
 *
 * Caveat: `spa-name` here is the SMS/email composer's customer-facing
 * name (read by resolveSpaName in emma-spa-profile.ts) — NOT the
 * `public.tenants.name` column that drives MyTenant.name (which is
 * what the admin viewing-as banner reads). Same intent, different
 * storage; unifying the two is a v1.27 candidate. For now, this
 * editor only writes the SMS-composer half.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Phone, Store, User as UserIcon } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { SettingsTabStrip } from "@/components/refill/SettingsTabStrip";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getSpaProfileBundleFn,
  setSpaProfileLookupKeyFn,
} from "@/server/spa-profile.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/settings/spa-profile")({
  component: SpaProfilePage,
});

type Bundle = {
  spaName: string | null;
  ownerDisplayName: string | null;
  fromNumber: string | null;
};

const EMPTY_BUNDLE: Bundle = {
  spaName: null,
  ownerDisplayName: null,
  fromNumber: null,
};

function SpaProfilePage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [serverBundle, setServerBundle] = useState<Bundle>(EMPTY_BUNDLE);
  const [draft, setDraft] = useState<Bundle>(EMPTY_BUNDLE);

  useEffect(() => {
    if (membership.status !== "tenant") return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const result = await getSpaProfileBundleFn({
          data: { accessToken: token, viewAsUserId },
        });
        if (cancelled) return;
        setServerBundle(result);
        setDraft(result);
      } catch (err) {
        if (!cancelled) {
          toast.error(
            err instanceof Error ? err.message : "Couldn't load spa profile.",
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

  const changedKeys = useMemo(() => {
    const keys: Array<keyof Bundle> = [];
    if ((draft.spaName ?? "") !== (serverBundle.spaName ?? "")) keys.push("spaName");
    if ((draft.ownerDisplayName ?? "") !== (serverBundle.ownerDisplayName ?? ""))
      keys.push("ownerDisplayName");
    if ((draft.fromNumber ?? "") !== (serverBundle.fromNumber ?? ""))
      keys.push("fromNumber");
    return keys;
  }, [draft, serverBundle]);

  const canSave = !saving && !loading && changedKeys.length > 0;

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      for (const key of changedKeys) {
        const lookupKey =
          key === "spaName"
            ? "spa-name"
            : key === "ownerDisplayName"
              ? "owner-display-name"
              : "from-number";
        await setSpaProfileLookupKeyFn({
          data: {
            accessToken: token,
            lookupKey,
            value: draft[key],
            viewAsUserId,
          },
        });
      }
      setServerBundle(draft);
      toast.success(
        changedKeys.length === 1
          ? "Saved 1 change."
          : `Saved ${changedKeys.length} changes.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  function onRevert() {
    setDraft(serverBundle);
  }

  return (
    <div>
      <PageHeader
        title="Spa profile"
        description="Customer-facing name + owner name + outbound SMS number. These power the Refill engine's SMS and email composers (claim links, pre-show reminders, blasts)."
      />
      <SettingsTabStrip active="spa-profile" />

      <div className="px-6 lg:px-10 py-6 max-w-2xl space-y-6">
        <form onSubmit={onSave} className="space-y-5">
          <ProfileField
            icon={<Store className="h-4 w-4 text-emerald" />}
            label="Spa name"
            placeholder="Karen's Skin Studio"
            value={draft.spaName ?? ""}
            onChange={(v) => setDraft((d) => ({ ...d, spaName: v || null }))}
            caption="Used in SMS + email bodies (&ldquo;Karen&rsquo;s Skin Studio has an opening&rdquo;). When blank, copy falls back to &ldquo;your spa&rdquo;."
            disabled={loading || saving}
          />

          <ProfileField
            icon={<UserIcon className="h-4 w-4 text-emerald" />}
            label="Owner display name"
            placeholder="Karen"
            value={draft.ownerDisplayName ?? ""}
            onChange={(v) =>
              setDraft((d) => ({ ...d, ownerDisplayName: v || null }))
            }
            caption="Solo-practitioner override (v1.26.12). When your Acuity provider name equals the spa name, copy renders &ldquo;with &lt;Owner&gt;&rdquo; instead of suppressing the with-clause. Blank = default behavior (suppress)."
            disabled={loading || saving}
          />

          <ProfileField
            icon={<Phone className="h-4 w-4 text-emerald" />}
            label="Outbound SMS from-number"
            placeholder="+12085551234"
            value={draft.fromNumber ?? ""}
            onChange={(v) => setDraft((d) => ({ ...d, fromNumber: v || null }))}
            caption="E.164 format. Blank = engine runs in proxy-email-only mode (no SMS sent). When set, SMS reminders + rescue offers + blasts send from this number."
            disabled={loading || saving}
            type="tel"
            autoComplete="tel"
          />

          <div className="flex items-center gap-3 pt-2">
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
                  Save{changedKeys.length > 0 ? ` (${changedKeys.length})` : ""}
                </>
              )}
            </button>
            {changedKeys.length > 0 && !saving && (
              <button
                type="button"
                onClick={onRevert}
                className="text-[13px] text-ink-soft hover:text-ink transition"
              >
                Revert
              </button>
            )}
            {loading && (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading current values&hellip;
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function ProfileField({
  icon,
  label,
  placeholder,
  value,
  onChange,
  caption,
  disabled,
  type = "text",
  autoComplete,
}: {
  icon: React.ReactNode;
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  caption: React.ReactNode;
  disabled?: boolean;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <section className="rounded-xl border border-rule bg-white px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-emerald-soft p-2 shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
            {label}
          </label>
          <input
            type={type}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete={autoComplete}
            className={cn(
              "w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30",
              disabled && "opacity-60 cursor-not-allowed",
            )}
          />
          <p className="text-[12px] text-ink-soft mt-1.5 leading-relaxed">
            {caption}
          </p>
        </div>
      </div>
    </section>
  );
}
