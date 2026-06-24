/**
 * Refill Rep Platform — rep-side server fns (Phase 2C).
 *
 * Three surfaces:
 *   - getMyRepAccount     — read self rep_accounts row (null if not registered)
 *   - ensureMyRepAccount  — idempotent self-registration (display_name default
 *                            pulled from auth metadata; Grasshopper can edit later)
 *   - mintMyReferralLink  — issues a signed referral token + the public URL
 *                            for the rep's current logged-in identity
 *
 * Tokens are minted server-side and only by the rep themselves (verifyAuth
 * gates everything). The validation surface lives in claimSlug
 * (refill-tenants.ts) — the inverse of this file.
 */

import { admin, type SbClient } from "./admin-client";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { DIRECT_COMMISSION_RATE } from "@/lib/rep-economics";
import { selectAllRows } from "@/lib/supabase-paginate";
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";
import { mintReferralToken } from "@/server/referral-tokens";


const authInput = z.object({
  accessToken: z.string().min(1),
});

// v1.24.5: shared input for read fns that honor admin impersonation.
// Mirrors readWithViewAsInput in refill-billing.ts.
const authWithViewAsInput = authInput.extend({
  viewAsUserId: z.string().uuid().optional(),
});

export type RepAccountRow = {
  repUserId: string;
  displayName: string;
  businessName: string | null;
  status: "active" | "paused" | "terminated";
  originType: "indy_rep" | "corporate_rep" | "spa_owner" | "other";
  territory: Json;
  joinedAt: string;
  // v399.2: derived from metadata->>'demo' on the rep_accounts row. The UI
  // uses this to render the DemoBanner above the rep-nav, making it visually
  // obvious that the active session is the seeded demo persona (per
  // architecture-doc spec: "Marked clearly as DEMO data").
  isDemo: boolean;
};

function mapRepRow(row: {
  rep_user_id: string;
  display_name: string;
  business_name: string | null;
  status: string;
  origin_type: string;
  territory: Json;
  joined_at: string;
  metadata?: Json | null;
}): RepAccountRow {
  return {
    repUserId: row.rep_user_id,
    displayName: row.display_name,
    businessName: row.business_name,
    status: row.status as RepAccountRow["status"],
    originType: row.origin_type as RepAccountRow["originType"],
    territory: row.territory ?? {},
    joinedAt: row.joined_at,
    isDemo: isDemoMetadata(row.metadata),
  };
}

function isDemoMetadata(meta: Json | null | undefined): boolean {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  const v = (meta as Record<string, Json>).demo;
  return v === true || v === "true";
}

// ─── getMyRepAccount ─────────────────────────────────────────────────────

// v1.24.0: viewAsUserId opt-in so admin impersonating a rep gets the
// impersonated rep's profile (not the caller's null). resolveEffectiveUserId
// re-verifies admin role server-side before honoring the override.
const getMyRepAccountInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export const getMyRepAccount = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => getMyRepAccountInput.parse(raw))
  .handler(
    async ({ data }): Promise<{ rep: RepAccountRow | null }> => {
      const { effectiveUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const sb = admin();
      const { data: row, error } = await sb
        .from("rep_accounts")
        .select(
          "rep_user_id, display_name, business_name, status, origin_type, territory, joined_at, metadata",
        )
        .eq("rep_user_id", effectiveUserId)
        .maybeSingle();
      if (error) {
        throw new Error(`Couldn't load your rep account: ${error.message}`);
      }
      return { rep: row ? mapRepRow(row) : null };
    },
  );

// ─── ensureMyRepAccount ──────────────────────────────────────────────────

const ensureInput = authWithViewAsInput.extend({
  displayName: z.string().trim().min(1).max(200).optional(),
  businessName: z.string().trim().max(200).optional(),
  originType: z
    .enum(["indy_rep", "corporate_rep", "spa_owner", "other"])
    .optional(),
});

export const ensureMyRepAccount = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => ensureInput.parse(raw))
  .handler(async ({ data }): Promise<{ rep: RepAccountRow }> => {
    // v1.26.1: admin viewing-as a rep ensures the IMPERSONATED user's
    // rep_account row, not the admin's own. Without this, opening the
    // rep page while impersonating creates a phantom rep_account for
    // the admin and the impersonated rep stays unprovisioned.
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const userId = effectiveUserId;
    const sb = admin();

    const { data: existing, error: readErr } = await sb
      .from("rep_accounts")
      .select(
        "rep_user_id, display_name, business_name, status, origin_type, territory, joined_at, metadata",
      )
      .eq("rep_user_id", userId)
      .maybeSingle();
    if (readErr) {
      throw new Error(`Couldn't read your rep account: ${readErr.message}`);
    }
    if (existing) {
      return { rep: mapRepRow(existing) };
    }

    // Fall-back display name: pull from auth.users metadata if not provided.
    let displayName = data.displayName?.trim();
    if (!displayName) {
      const { data: userResp } = await sb.auth.admin.getUserById(userId);
      const meta = userResp?.user?.user_metadata as
        | { display_name?: string; full_name?: string; name?: string }
        | undefined;
      displayName =
        meta?.display_name?.trim() ||
        meta?.full_name?.trim() ||
        meta?.name?.trim() ||
        userResp?.user?.email?.split("@")[0] ||
        "Rep";
    }

    const { data: inserted, error: insErr } = await sb
      .from("rep_accounts")
      .insert({
        rep_user_id: userId,
        display_name: displayName,
        business_name: data.businessName?.trim() || null,
        origin_type: data.originType ?? "indy_rep",
      })
      .select(
        "rep_user_id, display_name, business_name, status, origin_type, territory, joined_at, metadata",
      )
      .single();
    if (insErr) {
      throw new Error(`Couldn't create your rep account: ${insErr.message}`);
    }
    return { rep: mapRepRow(inserted) };
  });

// ─── mintMyReferralLink ──────────────────────────────────────────────────
// The rep can only mint a link for THEMSELVES. The token encodes their
// rep_user_id; the consumer (claimSlug) validates HMAC + presence in
// rep_accounts before attributing.
//
// Refill referral links ALWAYS point at the Refill marketing apex —
// the server is the single source of truth for the outbound artifact's
// domain. Client-supplied origins are not honored (they were a v399.x
// injection vector — when a rep was signed in on lizzie.agentiport.com,
// window.location.origin baked the wrong host into the link the prospect
// received, 404'ing because /onboard only exists on getrefill.app).

const mintInput = authWithViewAsInput;

export type ReferralLink = {
  token: string;
  url: string;          // Short URL — getrefill.app/r/<slug> (v406 Pinch #10)
  longUrl: string;      // Long URL — kept available for inbound-only paths
  shortSlug: string;
  repId: string;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
};

function buildLongReferralUrl(token: string): string {
  const base = (process.env.REFILL_PUBLIC_ORIGIN ?? "https://smartspa.app").replace(/\/+$/, "");
  return `${base}/onboard?ref=${encodeURIComponent(token)}`;
}

function buildShortReferralUrl(slug: string): string {
  const base = (process.env.REFILL_PUBLIC_ORIGIN ?? "https://smartspa.app").replace(/\/+$/, "");
  return `${base}/r/${slug}`;
}

// v406 Pinch #10: slug generation. Lowercase + kebab-case from display name;
// strip non-[a-z0-9-]; collapse multiple dashes; trim leading/trailing dash;
// truncate to 40 chars. If empty (display name was all unicode/symbols),
// fall back to "rep-<first 8 of repId>". Collision resolution is the
// caller's job — try the base slug, then append "-2", "-3", etc.
function slugifyDisplayName(displayName: string, repIdFallback: string): string {
  const base = displayName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  if (base) return base;
  return `rep-${repIdFallback.replace(/-/g, "").slice(0, 8)}`;
}

async function findAvailableSlug(
  sb: SbClient,
  baseSlug: string,
): Promise<string> {
  // Try baseSlug, then baseSlug-2, -3, ... up to -99. Past that we throw —
  // 99 distinct reps colliding on the same kebab-case name is operator
  // signal to widen the slug generator, not silently keep numbering.
  for (let n = 1; n <= 99; n++) {
    const candidate = n === 1 ? baseSlug : `${baseSlug}-${n}`;
    const { data, error } = await sb
      .from("rep_referral_links")
      .select("id")
      .eq("short_slug", candidate)
      .maybeSingle();
    if (error) {
      throw new Error(`Slug availability check failed: ${error.message}`);
    }
    if (!data) return candidate;
  }
  throw new Error(`Couldn't find an available slug under "${baseSlug}" after 99 tries.`);
}

export const mintMyReferralLink = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => mintInput.parse(raw))
  .handler(async ({ data }): Promise<ReferralLink> => {
    // v1.26.1: admin viewing-as a rep mints a link for the IMPERSONATED
    // rep. The token encodes their rep_user_id; without this, admin
    // would mint links pointing to themselves (and rep_accounts row
    // lookup would fail since admin has no rep_account).
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const userId = effectiveUserId;
    const sb = admin();

    const { data: rep, error } = await sb
      .from("rep_accounts")
      .select("rep_user_id, display_name, status")
      .eq("rep_user_id", userId)
      .maybeSingle();
    if (error) {
      throw new Error(`Couldn't verify your rep account: ${error.message}`);
    }
    if (!rep) {
      throw new Error(
        "You're not registered as a rep yet — visit /app/rep/referral-links to set up your rep profile.",
      );
    }
    if (rep.status !== "active") {
      throw new Error(`Your rep account status is "${rep.status}" — links can only be minted from active accounts.`);
    }

    // v406: idempotent mint. One row per rep_user_id. If the rep already has
    // a referral link record we return it as-is (same slug, same token, same
    // share URL across paint cycles). The seed row for Kelly (slug
    // 'kelly-caffee') carries token='SEED_REPLACE_ON_FIRST_MINT'; the first
    // mint call overwrites it with a real HMAC-signed token so /r/kelly-caffee
    // resolves correctly from then on.
    const { data: existing, error: readErr } = await sb
      .from("rep_referral_links")
      .select("id, short_slug, token, use_count, last_used_at, created_at")
      .eq("rep_user_id", userId)
      .maybeSingle();
    if (readErr) {
      throw new Error(`Couldn't load your referral link: ${readErr.message}`);
    }

    if (existing) {
      // If the row is the seed placeholder, mint a real token + store it.
      let token = existing.token;
      if (token === "SEED_REPLACE_ON_FIRST_MINT") {
        token = mintReferralToken(userId);
        const { error: updErr } = await sb
          .from("rep_referral_links")
          .update({ token })
          .eq("id", existing.id);
        if (updErr) {
          throw new Error(`Couldn't activate your referral link: ${updErr.message}`);
        }
      }
      return {
        token,
        url: buildShortReferralUrl(existing.short_slug),
        longUrl: buildLongReferralUrl(token),
        shortSlug: existing.short_slug,
        repId: userId,
        useCount: existing.use_count,
        lastUsedAt: existing.last_used_at,
        createdAt: existing.created_at,
      };
    }

    // No existing row — generate a slug + mint a token + insert.
    const baseSlug = slugifyDisplayName(rep.display_name, userId);
    const finalSlug = await findAvailableSlug(sb, baseSlug);
    const token = mintReferralToken(userId);

    const { data: inserted, error: insErr } = await sb
      .from("rep_referral_links")
      .insert({
        rep_user_id: userId,
        short_slug: finalSlug,
        token,
      })
      .select("id, short_slug, token, use_count, last_used_at, created_at")
      .single();
    if (insErr || !inserted) {
      throw new Error(`Couldn't mint your referral link: ${insErr?.message ?? "unknown"}`);
    }

    return {
      token: inserted.token,
      url: buildShortReferralUrl(inserted.short_slug),
      longUrl: buildLongReferralUrl(inserted.token),
      shortSlug: inserted.short_slug,
      repId: userId,
      useCount: inserted.use_count,
      lastUsedAt: inserted.last_used_at,
      createdAt: inserted.created_at,
    };
  });

// ─── listMyReferralLinks ─────────────────────────────────────────────────
// v406 Pinch #7: history view for /app/rep/referral-links. Returns the
// rep's persisted link record(s). Under current single-link-per-rep
// semantics this returns 0 or 1 rows; the array shape leaves room for a
// future multi-campaign-link model without breaking callers.

export const listMyReferralLinks = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => authWithViewAsInput.parse(raw))
  .handler(
    async ({ data }): Promise<{ links: ReferralLink[] }> => {
      const { effectiveUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const sb = admin();
      const { data: rows, error } = await sb
        .from("rep_referral_links")
        .select("short_slug, token, use_count, last_used_at, created_at")
        .eq("rep_user_id", effectiveUserId)
        .order("created_at", { ascending: false });
      if (error) {
        throw new Error(`Couldn't load your referral links: ${error.message}`);
      }
      const links: ReferralLink[] = (rows ?? []).map((r) => ({
        token: r.token,
        url: buildShortReferralUrl(r.short_slug),
        longUrl: buildLongReferralUrl(r.token),
        shortSlug: r.short_slug,
        repId: effectiveUserId,
        useCount: r.use_count,
        lastUsedAt: r.last_used_at,
        createdAt: r.created_at,
      }));
      return { links };
    },
  );

// ─── resolveReferralSlug ─────────────────────────────────────────────────
// v406 Pinch #10: /r/<slug> resolution. Public (no auth) — anyone clicking
// the short URL needs to follow it. Looks up the slug, bumps use_count +
// last_used_at, returns the target /onboard?ref=<token> URL the route
// should redirect to. Returns null on unknown slug (route emits 404 from
// the client side).

const resolveInput = z.object({
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  // v408: optional engagement-event id from the recruit email's /r/<slug>?e=<id>.
  // Appended onto the redirect target as &e=<id> so the onboard page can
  // capture it into a cookie that survives the magic-link round-trip. The
  // cookie is then consumed by acceptRecruitInvite to stamp the conversion.
  eventId: z.string().uuid().optional(),
});

export const resolveReferralSlug = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => resolveInput.parse(raw))
  .handler(
    async ({ data }): Promise<{ targetUrl: string | null }> => {
      const sb = admin();
      const { data: row, error } = await sb
        .from("rep_referral_links")
        .select("id, token, rep_user_id, use_count")
        .eq("short_slug", data.slug)
        .maybeSingle();
      if (error) {
        throw new Error(`Couldn't resolve referral slug: ${error.message}`);
      }
      if (!row) return { targetUrl: null };

      // v406.1: lazy activation of the seed placeholder. The Kelly demo seed
      // (and any other seeded row) lands with token='SEED_REPLACE_ON_FIRST_MINT'.
      // Previously we returned null here, expecting the referral-links page to
      // call mintMyReferralLink first — but that page calls listMyReferralLinks
      // (read-only) on mount, not mint. So a fresh /r/<slug> click against the
      // seed row 404'd. Now we mint a real token in-place against the row's
      // rep_user_id, update the row, and proceed. Self-healing on first click.
      let token = row.token;
      if (token === "SEED_REPLACE_ON_FIRST_MINT") {
        token = mintReferralToken(row.rep_user_id);
        const { error: actErr } = await sb
          .from("rep_referral_links")
          .update({ token })
          .eq("id", row.id);
        if (actErr) {
          throw new Error(`Couldn't activate referral slug: ${actErr.message}`);
        }
      }

      // Audit the resolution. Bumps use_count + stamps last_used_at so the
      // history view on /app/rep/referral-links reflects real-time clicks.
      await sb
        .from("rep_referral_links")
        .update({
          use_count: row.use_count + 1,
          last_used_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      // v408: thread eventId into the redirect target so onboard.tsx can
      // capture it as a cookie. Built as &e=<id> since buildLongReferralUrl
      // already starts with ?ref=<token>.
      let targetUrl = buildLongReferralUrl(token);
      if (data.eventId) {
        targetUrl += `&e=${encodeURIComponent(data.eventId)}`;
      }
      return { targetUrl };
    },
  );


// ─── getRecruitInvitePreview ─────────────────────────────────────────────
// v408: side-effect-free lookup so the onboard recruit banner can render
// "[Recruiter] invited you as a sub-rep" without triggering the conversion.
// Public (no auth): the engagement_event id is the capability token. If it
// resolves and is a valid rep_recruit invite, return the recruiter's display
// name so the UI can render the banner. If invalid/expired/missing, return
// { valid: false }. The actual conversion still requires auth via
// acceptRecruitInvite below.

const recruitPreviewInput = z.object({
  eventId: z.string().uuid(),
});

export const getRecruitInvitePreview = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => recruitPreviewInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      valid: boolean;
      alreadyConverted: boolean;
      senderDisplayName: string | null;
    }> => {
      const sb = admin();
      const { data: event } = await sb
        .from("outreach_engagement_events")
        .select("sent_by, purpose, converted_rep_user_id")
        .eq("id", data.eventId)
        .maybeSingle();
      if (!event || event.purpose !== "rep_recruit" || !event.sent_by) {
        return { valid: false, alreadyConverted: false, senderDisplayName: null };
      }
      const { data: parent } = await sb
        .from("rep_accounts")
        .select("display_name, status")
        .eq("rep_user_id", event.sent_by)
        .maybeSingle();
      if (!parent || parent.status !== "active") {
        return { valid: false, alreadyConverted: false, senderDisplayName: null };
      }
      return {
        valid: true,
        alreadyConverted: !!event.converted_rep_user_id,
        senderDisplayName: parent.display_name,
      };
    },
  );

// ─── acceptRecruitInvite ─────────────────────────────────────────────────
// v408: rep-recruit conversion endpoint. Called from /onboard when the
// refill_recruit_event cookie is present and the recipient clicks "Become a
// sub-rep." The cookie carries the id of an outreach_engagement_events row
// with purpose='rep_recruit' fired by the recruiting rep.
//
// Three side effects, in order, idempotent on the engagement_event id:
//   1. Ensure rep_accounts row exists for the current user (creates if not).
//   2. Insert rep_affiliations row tying current user → recruiter as Tier-1
//      sub-rep (commission_split=0.0300, the standard direct rate).
//   3. Stamp converted_rep_user_id + converted_at on the engagement event.
//
// Idempotency: if the event is already stamped (converted_rep_user_id IS NOT
// NULL), we return { alreadyConverted: true } without inserting anything
// new. The cookie can fire this endpoint multiple times (page reloads, etc.)
// without creating duplicate affiliations.
//
// Tier-3 policy: per the 2026-05-22 architecture decision (Q2 of the v408
// fielder's choice), the cascade caps at Tier-2 for paid commissions —
// Tier-3 rows can exist in rep_affiliations but commission_cron pays 0%
// for them. That policy lives in the commission cron, not here. This fn
// only creates the direct Tier-1 row (the only one ever needed for a
// recruit acceptance, since recruit conversion is always one hop).

const acceptInviteInput = z.object({
  accessToken: z.string().min(1),
  eventId: z.string().uuid(),
});

export const acceptRecruitInvite = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => acceptInviteInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      converted: boolean;
      alreadyConverted: boolean;
      parentRepUserId: string;
      parentDisplayName: string;
    }> => {
      const userId = await verifyAuth(data.accessToken);
      const sb = admin();

      // 1. Load + validate the engagement event.
      const { data: event, error: eventErr } = await sb
        .from("outreach_engagement_events")
        .select("id, sent_by, purpose, converted_rep_user_id")
        .eq("id", data.eventId)
        .maybeSingle();
      if (eventErr) {
        throw new Error(`Couldn't load recruit invite: ${eventErr.message}`);
      }
      if (!event) {
        throw new Error("This recruit invite link is no longer valid.");
      }
      if (event.purpose !== "rep_recruit") {
        throw new Error("This invite isn't a rep recruit invite.");
      }
      if (!event.sent_by) {
        throw new Error("This recruit invite has no sender on file.");
      }
      if (event.sent_by === userId) {
        throw new Error("You can't accept your own recruit invite.");
      }

      // Idempotency: already converted? Return without touching anything.
      if (event.converted_rep_user_id) {
        const { data: parent } = await sb
          .from("rep_accounts")
          .select("display_name")
          .eq("rep_user_id", event.sent_by)
          .maybeSingle();
        return {
          converted: false,
          alreadyConverted: true,
          parentRepUserId: event.sent_by,
          parentDisplayName: parent?.display_name ?? "your recruiter",
        };
      }

      // 2. Validate the recruiting rep exists and is active.
      const { data: parent, error: parentErr } = await sb
        .from("rep_accounts")
        .select("rep_user_id, display_name, status")
        .eq("rep_user_id", event.sent_by)
        .maybeSingle();
      if (parentErr) {
        throw new Error(`Couldn't load recruiting rep: ${parentErr.message}`);
      }
      if (!parent) {
        throw new Error("The rep who invited you is no longer on the platform.");
      }
      if (parent.status !== "active") {
        throw new Error(`The rep who invited you has status "${parent.status}".`);
      }

      // 3. Ensure self has a rep_accounts row. Inline insert rather than
      //    calling ensureMyRepAccount (which would re-verify auth — we
      //    already have userId here).
      const { data: existingSelf } = await sb
        .from("rep_accounts")
        .select("rep_user_id")
        .eq("rep_user_id", userId)
        .maybeSingle();

      if (!existingSelf) {
        const { data: userResp } = await sb.auth.admin.getUserById(userId);
        const meta = userResp?.user?.user_metadata as
          | { display_name?: string; full_name?: string; name?: string }
          | undefined;
        const displayName =
          meta?.display_name?.trim() ||
          meta?.full_name?.trim() ||
          meta?.name?.trim() ||
          userResp?.user?.email?.split("@")[0] ||
          "Rep";

        const { error: createErr } = await sb
          .from("rep_accounts")
          .insert({
            rep_user_id: userId,
            display_name: displayName,
            origin_type: "indy_rep",
          });
        if (createErr) {
          throw new Error(`Couldn't set up your rep account: ${createErr.message}`);
        }
      }

      // 4. Affiliate as Tier-1 sub-rep under the recruiter. The unique key
      //    (rep_id, parent_rep_id, tier_level) makes this idempotent if the
      //    fn runs twice for some reason.
      const { error: affErr } = await sb
        .from("rep_affiliations")
        .insert({
          rep_id: userId,
          parent_rep_id: event.sent_by,
          tier_level: 1,
          commission_split: DIRECT_COMMISSION_RATE,
          active: true,
        });
      if (affErr && !affErr.message.includes("duplicate")) {
        throw new Error(`Couldn't link you to your recruiter: ${affErr.message}`);
      }

      // 5. Stamp the conversion on the engagement event.
      const nowIso = new Date().toISOString();
      const { error: stampErr } = await sb
        .from("outreach_engagement_events")
        .update({
          converted_rep_user_id: userId,
          converted_at: nowIso,
        })
        .eq("id", event.id);
      if (stampErr) {
        throw new Error(`Couldn't stamp conversion: ${stampErr.message}`);
      }

      return {
        converted: true,
        alreadyConverted: false,
        parentRepUserId: event.sent_by,
        parentDisplayName: parent.display_name,
      };
    },
  );

// ─── getMyNetwork ────────────────────────────────────────────────────────
// Returns the rep's downstream tree (Tier 1 + Tier 2 + Tier 3) from the SQL
// fn `get_rep_network` (migration 20260607). Empty array when the rep has no
// affiliations yet — Phase 2D ships the empty-state UI; Phase 2G seeds Kelly's
// sub-reps for the 5/29 demo.

export type NetworkMember = {
  repId: string;
  parentRepId: string | null;
  depth: number;
  displayName: string;
  businessName: string | null;
  status: "active" | "paused" | "terminated";
  joinedAt: string;
};

export const getMyNetwork = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => authWithViewAsInput.parse(raw))
  .handler(async ({ data }): Promise<{ members: NetworkMember[] }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const { data: rows, error } = await sb.rpc("get_rep_network", {
      root_rep_id: effectiveUserId,
      max_depth: 3,
    });
    if (error) {
      throw new Error(`Couldn't load your network: ${error.message}`);
    }
    const members: NetworkMember[] = (rows ?? []).map((row) => ({
      repId: row.rep_id,
      parentRepId: row.parent_rep_id,
      depth: row.depth,
      displayName: row.display_name,
      businessName: row.business_name,
      status: row.status as NetworkMember["status"],
      joinedAt: row.joined_at,
    }));
    return { members };
  });

// ─── getMyLedger ─────────────────────────────────────────────────────────
// Returns the rep's commission_ledger rows, newest period first, with
// per-status totals computed in JS (Postgres group-by would need a second
// query and the dataset is small — single rep, monthly periods).

export type LedgerRow = {
  id: string;
  periodMonth: string; // YYYY-MM-01
  tierLevel: 1 | 2 | 3;
  commissionSplit: number;
  sourceRevenueUsd: number;
  commissionUsd: number;
  status: "pending" | "paid" | "voided";
  paidAt: string | null;
  sourceTenantId: string | null;
  notes: string | null;
};

export type LedgerTotals = {
  pendingUsd: number;
  paidUsd: number;
  voidedUsd: number;
  lifetimeUsd: number; // pending + paid (excludes voided)
};

export const getMyLedger = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => authWithViewAsInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{ rows: LedgerRow[]; totals: LedgerTotals }> => {
      const { effectiveUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const sb = admin();

      // Paginate the full per-rep ledger — a long-tenured rep can exceed
      // PostgREST's 1000-row cap (monthly × tiers × many source tenants), and an
      // unpaginated read would silently under-report their lifetime earnings.
      const dbRows = await selectAllRows<{
        id: string;
        period_month: string;
        tier_level: number;
        commission_split: number | string;
        source_revenue_usd: number | string;
        commission_usd: number | string;
        status: string;
        paid_at: string | null;
        source_tenant_id: string | null;
        notes: string | null;
      }>(
        (from, to) =>
          sb
            .from("rep_commission_ledger")
            .select(
              "id, period_month, tier_level, commission_split, source_revenue_usd, commission_usd, status, paid_at, source_tenant_id, notes",
            )
            .eq("rep_id", effectiveUserId)
            .order("period_month", { ascending: false })
            .order("tier_level", { ascending: true })
            .range(from, to),
        { label: "rep_commission_ledger full history" },
      );

      const rows: LedgerRow[] = dbRows.map((r) => ({
        id: r.id,
        periodMonth: r.period_month,
        tierLevel: r.tier_level as LedgerRow["tierLevel"],
        commissionSplit: Number(r.commission_split),
        sourceRevenueUsd: Number(r.source_revenue_usd),
        commissionUsd: Number(r.commission_usd),
        status: r.status as LedgerRow["status"],
        paidAt: r.paid_at,
        sourceTenantId: r.source_tenant_id,
        notes: r.notes,
      }));

      const totals: LedgerTotals = {
        pendingUsd: 0,
        paidUsd: 0,
        voidedUsd: 0,
        lifetimeUsd: 0,
      };
      for (const r of rows) {
        if (r.status === "pending") totals.pendingUsd += r.commissionUsd;
        else if (r.status === "paid") totals.paidUsd += r.commissionUsd;
        else if (r.status === "voided") totals.voidedUsd += r.commissionUsd;
      }
      totals.lifetimeUsd = totals.pendingUsd + totals.paidUsd;

      return { rows, totals };
    },
  );

// ─── getMyLiveEarnings ───────────────────────────────────────────────────
// Aggregates recovery_events attributed directly to this rep (Tier-1
// path — referred_by_rep_id = my user id). Today / 7-day / 30-day buckets,
// plus the most recent N events for the live ticker.
//
// Cascade (Tier-2: my sub-rep's events crediting me 1%) flows through the
// commission ledger via the monthly cron — getMyLedger surfaces it. The
// live widget intentionally shows direct revenue for now; cascade adds a
// fan-out filter that Supabase realtime subscriptions can't easily express.

const liveLimit = 8;

export type LiveEarningsEvent = {
  id: string;
  createdAt: string;
  recoveryAgent: "rescue" | "post_recovery" | "preshow";
  attributedRevenueUsd: number | null;
  verifiedAt: string | null;
};

export type LiveEarningsTotals = {
  todayUsd: number;
  last7DaysUsd: number;
  last30DaysUsd: number;
  lifetimeUsd: number;
  eventCountLifetime: number;
};

export const getMyLiveEarnings = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => authWithViewAsInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      totals: LiveEarningsTotals;
      recent: LiveEarningsEvent[];
    }> => {
      const { effectiveUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const sb = admin();

      // Paginate the full per-rep recovery ledger — a high-volume rep can
      // exceed PostgREST's 1000-row cap, and an unpaginated read would silently
      // under-report their lifetime earnings (oldest events dropped). Ordered
      // created_at desc so the `recent` slice stays newest-first across pages.
      const rows = await selectAllRows<{
        id: string;
        created_at: string;
        recovery_agent: string;
        attributed_revenue_usd: number | string | null;
        verified_at: string | null;
      }>((from, to) =>
        sb
          .from("recovery_events")
          .select(
            "id, created_at, recovery_agent, attributed_revenue_usd, verified_at",
          )
          .eq("referred_by_rep_id", effectiveUserId)
          .order("created_at", { ascending: false })
          .range(from, to),
      );

      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const startOfTodayMs = new Date(new Date().toISOString().slice(0, 10)).getTime();

      const totals: LiveEarningsTotals = {
        todayUsd: 0,
        last7DaysUsd: 0,
        last30DaysUsd: 0,
        lifetimeUsd: 0,
        eventCountLifetime: 0,
      };

      const recent: LiveEarningsEvent[] = [];
      for (const r of rows ?? []) {
        const usd = r.attributed_revenue_usd == null ? 0 : Number(r.attributed_revenue_usd);
        const ts = new Date(r.created_at).getTime();
        totals.lifetimeUsd += usd;
        totals.eventCountLifetime += 1;
        if (ts >= startOfTodayMs) totals.todayUsd += usd;
        if (ts >= now - 7 * dayMs) totals.last7DaysUsd += usd;
        if (ts >= now - 30 * dayMs) totals.last30DaysUsd += usd;
        if (recent.length < liveLimit) {
          recent.push({
            id: r.id,
            createdAt: r.created_at,
            recoveryAgent: r.recovery_agent as LiveEarningsEvent["recoveryAgent"],
            attributedRevenueUsd: r.attributed_revenue_usd == null ? null : Number(r.attributed_revenue_usd),
            verifiedAt: r.verified_at,
          });
        }
      }

      return { totals, recent };
    },
  );
