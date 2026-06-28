/**
 * /app/refill/recognition/deal — Deal Desk (Buying · Phase 2, v2.201.0).
 *
 * The rep↔spa negotiation captured as the triangle Purchase ⇄ Samples ⇄ Promo
 * (project_buying_rewards_taxonomy). Enter from any corner; any corner optional.
 * The Promo corner deploys a sample-funded promo to patients via the existing
 * cohort allocation engine, dispatched through the zero-setup iMessage queue.
 *
 * Capture, not ledger. v1 = capture + deploy; "snap the rep's text" (vision) and
 * the promotional-pricing $ math (Phase 3) are deferred.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Handshake,
  ShoppingCart,
  Gift,
  Tag,
  Plus,
  Loader2,
  Send,
  CheckCircle2,
  SlidersHorizontal,
  Save,
  ChevronDown,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { BuyingTabs } from "@/components/refill/BuyingTabs";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { cn } from "@/lib/utils";
import {
  listDeals,
  createDeal,
  updateDeal,
  type Deal,
  type DealCorner,
} from "@/server/refill-deal.functions";
import { createAnonymousInventory } from "@/server/refill-recognition.functions";
import {
  runAllocation,
  listAllocationSuggestions,
  confirmAllocationSuggestion,
  dispatchAllocationBatch,
  getAllocationSettings,
  updateAllocationSettings,
  type AllocationSettings,
  type Cohort,
} from "@/server/refill-recognition-allocation.functions";

export const Route = createFileRoute("/app/refill/recognition/deal")({
  component: DealDeskPage,
});

const DOORS: Array<{
  corner: DealCorner;
  Icon: typeof ShoppingCart;
  bg: string;
  title: string;
  blurb: string;
}> = [
  {
    corner: "purchase",
    Icon: ShoppingCart,
    bg: "#e7f3ee",
    title: "I'm buying",
    blurb: "Committing to product — what comes with it?",
  },
  {
    corner: "samples",
    Icon: Gift,
    bg: "#fdf6dc",
    title: "I've got samples",
    blurb: "Rep's offering units — what do I do with them?",
  },
  {
    corner: "promo",
    Icon: Tag,
    bg: "#fbe9ec",
    title: "I'm planning a promo",
    blurb: "Running a special — what can I pull in?",
  },
];

function DealDeskPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState<DealCorner | null>(null);
  const [deployingId, setDeployingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      setAccessToken(token);
      const d = await listDeals({ data: { accessToken: token, viewAsUserId } });
      setDeals(d);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load deals.");
    }
  }, [viewAsUserId]);

  useEffect(() => {
    if (membership.status === "loading") return;
    void load();
  }, [membership.status, load]);

  async function startDeal(corner: DealCorner) {
    if (!accessToken) return;
    setCreating(corner);
    try {
      await createDeal({ data: { accessToken, viewAsUserId, enteredFrom: corner } });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start the deal.");
    } finally {
      setCreating(null);
    }
  }

  async function patchDeal(id: string, patch: Partial<Deal>) {
    if (!accessToken) return;
    try {
      await updateDeal({ data: { accessToken, viewAsUserId, id, ...patch } });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save.");
    }
  }

  // Deploy a deal's sample-funded promo: run the cohort allocation across
  // available sample units, confirm what it picks (the Deploy click IS the
  // confirmation), and dispatch through the zero-setup queue (test-mode
  // allowlist still protects real patients).
  async function deployPromo(deal: Deal) {
    if (!accessToken) return;
    setDeployingId(deal.id);
    try {
      const run = await runAllocation({ data: { accessToken, viewAsUserId } });
      if (run.generated === 0) {
        toast.message(
          run.noOpReason ??
            "Nothing to deploy yet — add available sample units (Samples tab) and make sure you have eligible patients.",
        );
        return;
      }
      const suggestions = await listAllocationSuggestions({
        data: { accessToken, viewAsUserId },
      });
      const pending = suggestions.filter((s) => s.status === "pending");
      for (const s of pending) {
        await confirmAllocationSuggestion({
          data: { accessToken, viewAsUserId, id: s.id },
        });
      }
      const ids = pending.map((s) => s.id);
      const res = await dispatchAllocationBatch({
        data: { accessToken, viewAsUserId, suggestionIds: ids },
      });
      await updateDeal({
        data: {
          accessToken,
          viewAsUserId,
          id: deal.id,
          status: "active",
          promo: {
            description: deal.promo?.description ?? "",
            offerId: deal.promo?.offerId ?? null,
            deployedSuggestionIds: ids,
          },
        },
      });
      toast.success(
        `Deployed — ${res.drafted} queued${res.skipped ? `, ${res.skipped} held` : ""}.${res.sendError ? ` ${res.sendError}` : ""}`,
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't deploy.");
    } finally {
      setDeployingId(null);
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <PageHeader
        title="Deal Desk"
        description="Every rep conversation is one triangle — Purchase, Samples, Promo. Start a deal from whichever corner you're standing in; capture it, don't account for it."
      />
      <BuyingTabs active="deal" />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-[960px] w-full mx-auto space-y-6">
        {/* Entry doors */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-2">
            Start a deal
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {DOORS.map((d) => (
              <button
                key={d.corner}
                type="button"
                onClick={() => void startDeal(d.corner)}
                disabled={creating !== null || !accessToken}
                className="rounded-2xl border border-rule bg-white p-4 text-left transition hover:border-emerald hover:shadow-sm disabled:opacity-60"
              >
                <div
                  className="h-9 w-9 rounded-xl flex items-center justify-center mb-2"
                  style={{ background: d.bg }}
                >
                  {creating === d.corner ? (
                    <Loader2 className="h-4 w-4 animate-spin text-ink-soft" />
                  ) : (
                    <d.Icon className="h-4 w-4 text-ink" />
                  )}
                </div>
                <div className="text-[14px] font-semibold text-ink">{d.title}</div>
                <div className="text-[12px] text-ink-soft mt-0.5">{d.blurb}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Deploy settings (rehomed from the old Allocation tab) */}
        <DeploySettings accessToken={accessToken} viewAsUserId={viewAsUserId} />

        {/* Deals list */}
        {loadError ? (
          <div className="rounded-2xl border border-rose/30 bg-rose-soft p-5 text-sm">
            <div className="font-semibold text-rose">Couldn't load</div>
            <p className="text-xs text-ink-soft mt-1">{loadError}</p>
          </div>
        ) : deals === null ? (
          <div className="flex items-center justify-center py-16 text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading…
          </div>
        ) : deals.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-rule bg-paper/30 p-10 text-center">
            <div className="h-12 w-12 mx-auto rounded-full bg-emerald-soft text-emerald-ink flex items-center justify-center mb-3">
              <Handshake className="h-6 w-6" />
            </div>
            <h2 className="text-base font-semibold text-ink mb-1">No deals yet</h2>
            <p className="text-sm text-ink-soft max-w-md mx-auto">
              When a rep dangles samples for a buy, or you're planning a promo,
              start a deal above and capture it from whichever corner you're in.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {deals
              .filter((d) => d.status !== "closed")
              .map((deal) => (
                <DealCard
                  key={deal.id}
                  deal={deal}
                  accessToken={accessToken}
                  viewAsUserId={viewAsUserId}
                  deploying={deployingId === deal.id}
                  onPatch={patchDeal}
                  onDeploy={() => void deployPromo(deal)}
                  onReload={load}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DealCard({
  deal,
  accessToken,
  viewAsUserId,
  deploying,
  onPatch,
  onDeploy,
  onReload,
}: {
  deal: Deal;
  accessToken: string | null;
  viewAsUserId: string | undefined;
  deploying: boolean;
  onPatch: (id: string, patch: Partial<Deal>) => void;
  onDeploy: () => void;
  onReload: () => Promise<void>;
}) {
  const [purchaseNote, setPurchaseNote] = useState(deal.purchase?.note ?? "");
  const [promoDesc, setPromoDesc] = useState(deal.promo?.description ?? "");
  const [rep, setRep] = useState(deal.repName ?? "");
  const [mfr, setMfr] = useState(deal.manufacturer ?? "");
  const [addingSample, setAddingSample] = useState(false);
  const [sampleBrand, setSampleBrand] = useState("");
  const [sampleUnits, setSampleUnits] = useState("1");
  const sampleCount = deal.samples?.inventoryIds.length ?? 0;

  async function addSample() {
    if (!accessToken || !sampleBrand.trim()) return;
    setAddingSample(true);
    try {
      const entry = await createAnonymousInventory({
        data: {
          accessToken,
          viewAsUserId,
          brand: sampleBrand.trim(),
          sku: sampleBrand.trim(),
          unitsTotal: Math.max(0, Number(sampleUnits) || 0),
          notes: `Sample from deal${deal.repName ? ` (${deal.repName})` : ""}`,
        },
      });
      const ids = [...(deal.samples?.inventoryIds ?? []), entry.nodeId];
      onPatch(deal.id, {
        samples: { inventoryIds: ids, note: deal.samples?.note ?? "" },
      });
      setSampleBrand("");
      setSampleUnits("1");
      await onReload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add sample.");
    } finally {
      setAddingSample(false);
    }
  }

  const STATUS_STYLE: Record<Deal["status"], { bg: string; fg: string }> = {
    draft: { bg: "#f1eee5", fg: "#5a6068" },
    active: { bg: "#e7f3ee", fg: "#056048" },
    closed: { bg: "#f1eee5", fg: "#8a9098" },
  };
  const st = STATUS_STYLE[deal.status];

  return (
    <div className="rounded-2xl border border-rule bg-white overflow-hidden">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-rule bg-rule-soft/50">
        <Handshake className="h-4 w-4 text-ink-soft" />
        <input
          value={mfr}
          onChange={(e) => setMfr(e.target.value)}
          onBlur={() => mfr !== (deal.manufacturer ?? "") && onPatch(deal.id, { manufacturer: mfr || null })}
          placeholder="Manufacturer"
          className="text-[13px] font-semibold text-ink bg-transparent border-b border-transparent focus:border-rule focus:outline-none w-32"
        />
        <span className="text-ink-faint">·</span>
        <input
          value={rep}
          onChange={(e) => setRep(e.target.value)}
          onBlur={() => rep !== (deal.repName ?? "") && onPatch(deal.id, { repName: rep || null })}
          placeholder="Rep name"
          className="text-[12px] text-ink-soft bg-transparent border-b border-transparent focus:border-rule focus:outline-none w-28"
        />
        <span
          className="ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize"
          style={{ background: st.bg, color: st.fg }}
        >
          {deal.status}
        </span>
        {deal.status !== "closed" && (
          <button
            type="button"
            onClick={() => onPatch(deal.id, { status: "closed" })}
            className="text-[11px] text-ink-faint hover:text-ink"
          >
            Close
          </button>
        )}
      </div>

      {/* three corners */}
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-rule">
        {/* Purchase */}
        <div className="p-4">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-2">
            <ShoppingCart className="h-3.5 w-3.5" /> Purchase
          </div>
          <textarea
            value={purchaseNote}
            onChange={(e) => setPurchaseNote(e.target.value)}
            onBlur={() =>
              purchaseNote !== (deal.purchase?.note ?? "") &&
              onPatch(deal.id, {
                purchase: { note: purchaseNote, products: deal.purchase?.products ?? [] },
              })
            }
            placeholder="What you're committing to — e.g. 200u Botox + 10 syringes filler this quarter"
            rows={3}
            className="w-full rounded-lg border border-rule px-2.5 py-2 text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-emerald resize-none"
          />
        </div>

        {/* Samples */}
        <div className="p-4">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-2">
            <Gift className="h-3.5 w-3.5" /> Samples
            {sampleCount > 0 && (
              <span className="text-emerald-ink">· {sampleCount} added</span>
            )}
          </div>
          {addingSample || sampleBrand ? (
            <div className="space-y-2">
              <input
                value={sampleBrand}
                onChange={(e) => setSampleBrand(e.target.value)}
                placeholder="Brand — e.g. Juvéderm Voluma"
                className="w-full rounded-lg border border-rule px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-emerald"
              />
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  value={sampleUnits}
                  onChange={(e) => setSampleUnits(e.target.value)}
                  className="w-20 rounded-lg border border-rule px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-emerald"
                />
                <button
                  type="button"
                  onClick={() => void addSample()}
                  disabled={addingSample || !sampleBrand.trim()}
                  className="inline-flex items-center gap-1 rounded-lg bg-ink px-2.5 py-1.5 text-[11px] font-semibold text-paper hover:opacity-90 disabled:opacity-50"
                >
                  {addingSample ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                  Add to pool
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingSample(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-rule px-2.5 py-1.5 text-[12px] font-medium text-ink-soft hover:border-ink-faint hover:text-ink"
            >
              <Plus className="h-3.5 w-3.5" /> Add the samples the rep gave
            </button>
          )}
          <p className="mt-2 text-[11px] text-ink-faint leading-snug">
            Lands in your Samples pool — the free-margin units you deploy to
            patients.
          </p>
        </div>

        {/* Promo */}
        <div className="p-4">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-2">
            <Tag className="h-3.5 w-3.5" /> Promo
          </div>
          <textarea
            value={promoDesc}
            onChange={(e) => setPromoDesc(e.target.value)}
            onBlur={() =>
              promoDesc !== (deal.promo?.description ?? "") &&
              onPatch(deal.id, {
                promo: {
                  description: promoDesc,
                  offerId: deal.promo?.offerId ?? null,
                  deployedSuggestionIds: deal.promo?.deployedSuggestionIds,
                },
              })
            }
            placeholder="The patient special these samples fund — e.g. first-time tox, $50 off"
            rows={3}
            className="w-full rounded-lg border border-rule px-2.5 py-2 text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-emerald resize-none"
          />
          {deal.promo?.deployedSuggestionIds &&
          deal.promo.deployedSuggestionIds.length > 0 ? (
            <div className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-ink">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Deployed to {deal.promo.deployedSuggestionIds.length}
            </div>
          ) : (
            <button
              type="button"
              onClick={onDeploy}
              disabled={deploying || !accessToken}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper hover:opacity-95 disabled:opacity-50"
            >
              {deploying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Deploy to patients
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const COHORT_LABELS: Record<Cohort, string> = {
  loyal_vintage: "Loyal Vintage",
  top_decile_current: "Top-Decile Current",
  at_risk: "At-Risk",
};

/**
 * Deploy settings — rehomed from the retired Allocation tab (v2.202.0). Controls
 * HOW a promo deploy picks + messages patients: the cohort split it allocates
 * across, the cooldown, manual-confirm, and the per-cohort iMessage templates.
 * Collapsed by default — advanced, set-and-forget.
 */
function DeploySettings({
  accessToken,
  viewAsUserId,
}: {
  accessToken: string | null;
  viewAsUserId: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loyal, setLoyal] = useState(40);
  const [topDecile, setTopDecile] = useState(40);
  const [atRisk, setAtRisk] = useState(20);
  const [cooldown, setCooldown] = useState(6);
  const [tpls, setTpls] = useState<AllocationSettings["templates"]>({
    loyal_vintage: "",
    top_decile_current: "",
    at_risk: "",
  });

  const expand = useCallback(async () => {
    setOpen((v) => !v);
    if (loaded || !accessToken) return;
    try {
      const s = await getAllocationSettings({
        data: { accessToken, viewAsUserId },
      });
      setLoyal(s.splitLoyalVintagePct);
      setTopDecile(s.splitTopDecileCurrentPct);
      setAtRisk(s.splitAtRiskPct);
      setCooldown(s.cooldownMonths);
      setTpls(s.templates);
      setLoaded(true);
    } catch {
      /* defaults stand if the read fails */
    }
  }, [loaded, accessToken, viewAsUserId]);

  const sum = loyal + topDecile + atRisk;

  async function save() {
    if (!accessToken) return;
    if (sum !== 100) {
      toast.error(`Cohort split must sum to 100 (currently ${sum}).`);
      return;
    }
    setSaving(true);
    try {
      await updateAllocationSettings({
        data: {
          accessToken,
          viewAsUserId,
          splitLoyalVintagePct: loyal,
          splitTopDecileCurrentPct: topDecile,
          splitAtRiskPct: atRisk,
          cooldownMonths: cooldown,
          templates: tpls,
        },
      });
      toast.success("Deploy settings saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-rule bg-white">
      <button
        type="button"
        onClick={() => void expand()}
        className="w-full flex items-center gap-2 px-5 py-3 text-left"
      >
        <SlidersHorizontal className="h-3.5 w-3.5 text-ink-soft" />
        <span className="text-[12px] font-semibold text-ink">Deploy settings</span>
        <span className="text-[11px] text-ink-faint">
          how a promo picks &amp; messages patients
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-4 w-4 text-ink-faint transition",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="border-t border-rule px-5 py-4 space-y-4">
          {/* cohort split */}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-2">
              Cohort split + cooldown{" "}
              <span className={sum === 100 ? "text-ink-faint" : "text-rose"}>
                (sum {sum}/100)
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <NumField label="Loyal Vintage %" value={loyal} onChange={setLoyal} />
              <NumField label="Top-Decile %" value={topDecile} onChange={setTopDecile} />
              <NumField label="At-Risk %" value={atRisk} onChange={setAtRisk} />
              <NumField label="Cooldown (mo)" value={cooldown} onChange={setCooldown} />
            </div>
          </div>
          {/* templates */}
          <div className="space-y-3">
            {(Object.keys(COHORT_LABELS) as Cohort[]).map((c) => (
              <div key={c}>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
                  {COHORT_LABELS[c]} template
                </label>
                <textarea
                  value={tpls[c]}
                  onChange={(e) =>
                    setTpls((prev) => ({ ...prev, [c]: e.target.value }))
                  }
                  rows={2}
                  className="w-full rounded border border-rule bg-white px-2 py-1.5 text-xs focus:outline-none focus:border-emerald"
                />
              </div>
            ))}
            <p className="text-[10px] text-ink-faint">
              Variables: <code>{"{{firstName}}"}</code> / <code>{"{{brand}}"}</code>{" "}
              / <code>{"{{units}}"}</code> / <code>{"{{spaName}}"}</code> /{" "}
              <code>{"{{manufacturer}}"}</code>.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper hover:opacity-95 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            Save deploy settings
          </button>
        </div>
      )}
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-1">
        {label}
      </span>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="w-full rounded border border-rule px-2 py-1.5 text-[12.5px] focus:outline-none focus:border-emerald"
      />
    </label>
  );
}
