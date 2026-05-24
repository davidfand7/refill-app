/**
 * Refill auth gate server fns (v386 / Phase 1.4).
 *
 * Two surfaces:
 *
 *   claimLeadByToken — first-hit silent-sign-in via the followup_report_token.
 *     The token was emailed to the lead's email address, which proves
 *     ownership. On first hit we ensure the auth.users row exists, ask
 *     Supabase admin for a magic-link action_link, mark token_consumed_at,
 *     bind user_id, and return the action_link for the browser to follow.
 *     The /auth/v1/verify endpoint sets the session cookies and redirects
 *     back to /onboard — so the user lands signed in with zero extra clicks.
 *
 *     Side effect: with SMTP configured on the project, generateLink ALSO
 *     emails a "confirm your sign-in" link. Users can ignore it (they're
 *     already signed in via the redirect). Auth Hooks v2 can suppress this
 *     in a follow-up if it generates noise.
 *
 *     On subsequent hits the token is treated as already consumed: if the
 *     current session's user_id matches the lead's user_id we pass through;
 *     otherwise we return needsEmailPrompt so the UI can collect an email
 *     and fire a real magic link via requestMagicLink.
 *
 *   requestMagicLink — return-visit + cold-entry flow. User types their
 *     email; we ensure the auth.users row exists and call signInWithOtp.
 *     They get an emailed magic link that lands them on /onboard signed in.
 *     Returns ok:true even on lookup failures so we don't leak whether an
 *     email is registered.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";

// Cleave fix 2026-05-24: cross-host-bridge module deleted (single apex,
// no Site URL strip to work around). refill_next user_metadata still gets
// written for soft post-onboarding routing, but no bridge consumes it.
// Type inlined since this file is now the only writer.
type RefillNextMetadata = {
  v: 1;
  path: "/onboard" | "/app/refill" | "/app/rep" | "/app/admin/personas";
  lead: string | null;
  ref: string | null;
  step: 1 | 2 | 3 | 4 | 5;
};

// ─── service-role admin client (module-private) ──────────────────────────

type SbClient = ReturnType<typeof createClient<Database>>;

function admin(): SbClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────

const REFILL_APP_DEFAULT = "https://app.getrefill.app";

function refillRedirect(leadId: string, refToken?: string): string {
  const base = process.env.REFILL_APP_URL ?? REFILL_APP_DEFAULT;
  const parts = [`lead=${encodeURIComponent(leadId)}`, "step=1"];
  if (refToken) parts.push(`ref=${encodeURIComponent(refToken)}`);
  return `${base}/onboard?${parts.join("&")}`;
}

function refillColdRedirect(refToken?: string): string {
  const base = process.env.REFILL_APP_URL ?? REFILL_APP_DEFAULT;
  const parts = ["step=1"];
  if (refToken) parts.push(`ref=${encodeURIComponent(refToken)}`);
  return `${base}/onboard?${parts.join("&")}`;
}

/**
 * v410.3 — build the `refill_next` user_metadata payload that tells
 * CrossHostBridgeTrigger this user is mid-onboarding (no tenant row
 * exists yet) and where to deliver them after the agentiport→refill
 * hop.
 *
 * DRIFT WARNING: this shape is the source of truth for `refill_next`.
 * The reader is `parseRefillNextMetadata` in src/lib/cross-host-bridge.ts;
 * the bridge route + trigger read it back via that parser. Any field
 * change here MUST update parser + types + the test suite at the same
 * time, or in-flight magic links go nowhere.
 *
 * Background: feedback_supabase_magic_link_crosshost_limit.md.
 */
function buildRefillNext(input: {
  leadId?: string | null;
  refToken?: string | null;
}): RefillNextMetadata {
  return {
    v: 1,
    path: "/onboard",
    lead: input.leadId ?? null,
    ref: input.refToken ?? null,
    step: 1,
  };
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "•••@•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const masked =
    local.length <= 2
      ? local[0] + "•"
      : local[0] +
        "•".repeat(Math.min(3, local.length - 2)) +
        local[local.length - 1];
  return `${masked}@${domain}`;
}

/**
 * Idempotent "make sure this email exists in auth.users." Returns the
 * auth.users.id. Used on both claim paths so generateLink / signInWithOtp
 * downstream don't 404 on cold emails.
 *
 * Implementation: try createUser; on already-registered error, paginate
 * listUsers to find them. Low-traffic enough that the linear scan is fine;
 * if onboarding ever 10x's we can add a dedicated email→user_id lookup.
 */
async function ensureUser(sb: SbClient, email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email: normalized,
    email_confirm: true,
  });
  if (created?.user?.id) return created.user.id;
  if (!createErr) {
    throw new Error("createUser returned no user and no error");
  }
  if (!/already|registered|exists/i.test(createErr.message)) {
    throw new Error(`User create failed: ${createErr.message}`);
  }
  // Paginate to find existing user.
  let page = 1;
  while (page <= 50) {
    const { data: list, error: listErr } = await sb.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (listErr) throw new Error(`User lookup failed: ${listErr.message}`);
    const found = list.users.find((u) => u.email?.toLowerCase() === normalized);
    if (found) return found.id;
    if (list.users.length < 200) break;
    page += 1;
  }
  throw new Error("User exists in auth but couldn't be located by email");
}

// ─── claimLeadByToken ────────────────────────────────────────────────────

const claimInput = z.object({
  token: z.string().min(8).max(128),
  accessToken: z.string().optional(),
});

export type ClaimResult =
  | { kind: "redirect"; actionLink: string; leadId: string }
  | { kind: "sessionMatch"; leadId: string }
  | { kind: "needsEmailPrompt"; maskedEmail: string; leadId: string }
  | { kind: "notFound" };

export const claimLeadByToken = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => claimInput.parse(raw))
  .handler(async ({ data }): Promise<ClaimResult> => {
    const sb = admin();
    const { data: lead, error } = await sb
      .from("csv_scanner_leads")
      .select("id, email, user_id, token_consumed_at")
      .eq("followup_report_token", data.token)
      .maybeSingle();
    if (error) {
      throw new Error(`Couldn't look up your link: ${error.message}`);
    }
    if (!lead || !lead.email) {
      return { kind: "notFound" };
    }

    // ── Path A: first hit — silent sign-in.
    if (!lead.token_consumed_at) {
      const userId = await ensureUser(sb, lead.email);

      // v410.3: stash the refill_next signal into user_metadata BEFORE
      // generating the magic link. Supabase strips `redirectTo` to the
      // project Site URL apex (agentiport.com) regardless of what we
      // pass; the bridge trigger reads this metadata back on the apex
      // landing and ferries the user to refill /onboard signed-in.
      // shallow-merges with existing user_metadata, so other keys are
      // preserved. Non-fatal — if the update fails the user still lands
      // on agentiport.com but won't be auto-bridged. Logged for ops.
      const { error: metaErr } = await sb.auth.admin.updateUserById(userId, {
        user_metadata: { refill_next: buildRefillNext({ leadId: lead.id }) },
      });
      if (metaErr) {
        console.warn(
          "[claimLeadByToken] refill_next stash failed (non-fatal):",
          metaErr.message,
        );
      }

      const { data: linkData, error: linkErr } =
        await sb.auth.admin.generateLink({
          type: "magiclink",
          email: lead.email,
          options: { redirectTo: refillRedirect(lead.id) },
        });
      if (linkErr || !linkData?.properties?.action_link) {
        throw new Error(
          `Couldn't create a sign-in link: ${linkErr?.message ?? "no link returned"}`,
        );
      }
      const { error: updateErr } = await sb
        .from("csv_scanner_leads")
        .update({
          user_id: userId,
          token_consumed_at: new Date().toISOString(),
        })
        .eq("id", lead.id);
      if (updateErr) {
        // The action_link is already valid; the user can sign in even if
        // this update fails. Surface loudly so we catch it in logs.
        console.warn(
          "[claimLeadByToken] claim update failed (non-fatal):",
          updateErr.message,
        );
      }
      return {
        kind: "redirect",
        actionLink: linkData.properties.action_link,
        leadId: lead.id,
      };
    }

    // ── Path B: token already consumed — check session.
    if (data.accessToken) {
      try {
        const userId = await verifyAuth(data.accessToken);
        if (lead.user_id && lead.user_id === userId) {
          return { kind: "sessionMatch", leadId: lead.id };
        }
      } catch {
        // fall through to email-prompt
      }
    }
    return {
      kind: "needsEmailPrompt",
      maskedEmail: maskEmail(lead.email),
      leadId: lead.id,
    };
  });

// ─── requestMagicLink ────────────────────────────────────────────────────

const magicInput = z.object({
  email: z.string().email().max(320),
  leadId: z.string().uuid().optional(),
  // Optional referral token. If supplied, threaded into emailRedirectTo so
  // the post-auth landing URL has ?ref=<token> — survives the browser-jar
  // switch when the user clicks the magic link from Gmail in a different
  // browser than the one where they originally visited the referral URL.
  refToken: z.string().min(1).max(500).optional(),
});

export const requestMagicLink = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => magicInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const sb = admin();
    const normalized = data.email.trim().toLowerCase();
    const emailRedirectTo = data.leadId
      ? refillRedirect(data.leadId, data.refToken)
      : refillColdRedirect(data.refToken);

    // Pre-create so the OTP send doesn't 422 on cold emails. Non-fatal —
    // signInWithOtp can still create when shouldCreateUser is true; this
    // is mostly belt-and-suspenders. v410.3: also gives us a user_id to
    // stash refill_next against before the OTP fires (signInWithOtp's
    // options.data path will set user_metadata at JWT-mint time, but the
    // updateUserById here is a belt for users that already exist).
    let preCreatedUserId: string | null = null;
    try {
      preCreatedUserId = await ensureUser(sb, normalized);
    } catch (err) {
      console.warn(
        "[requestMagicLink] ensureUser pre-create skipped:",
        err instanceof Error ? err.message : err,
      );
    }

    // v410.3: refill_next signal. Two writes for resilience:
    //   1. options.data on signInWithOtp — Supabase JS docs note this
    //      sets user_metadata at the time the OTP-minted JWT is issued.
    //      Works for brand-new users where the row didn't exist yet.
    //   2. updateUserById belt — for return-visit users where the row
    //      already exists, options.data may NOT overwrite existing
    //      metadata (depends on the Supabase release). The admin call
    //      shallow-merges, which is what we want.
    // Both writes converge on the same shape via buildRefillNext.
    const refillNextPayload = buildRefillNext({
      leadId: data.leadId,
      refToken: data.refToken,
    });

    if (preCreatedUserId) {
      const { error: metaErr } = await sb.auth.admin.updateUserById(
        preCreatedUserId,
        { user_metadata: { refill_next: refillNextPayload } },
      );
      if (metaErr) {
        console.warn(
          "[requestMagicLink] refill_next stash failed (non-fatal):",
          metaErr.message,
        );
      }
    }

    const { error } = await sb.auth.signInWithOtp({
      email: normalized,
      options: {
        emailRedirectTo,
        shouldCreateUser: true,
        data: { refill_next: refillNextPayload },
      },
    });
    if (error) {
      console.warn(
        "[requestMagicLink] signInWithOtp failed:",
        error.message,
      );
      throw new Error("Couldn't send the sign-in link — try again in a moment.");
    }

    return { ok: true };
  });

// ─── clearRefillNext (v410.3) ────────────────────────────────────────────

const clearInput = z.object({
  accessToken: z.string().min(1),
});

/**
 * v410.3 — best-effort cleanup of the `refill_next` user_metadata key
 * once the bridge has successfully delivered the user to /onboard on
 * app.getrefill.app. Without this, a user who completes onboarding +
 * comes back to agentiport.com in a few weeks would get re-bridged to
 * /onboard on every sign-in until they manually visited the wizard
 * again (the trigger would see the stale metadata and act on it before
 * checking tenant_memberships — except we already gate tenant-first, so
 * the stale case is benign for tenant users; this clear is mostly a
 * hygiene measure for the brief window between metadata-write and
 * tenant-creation).
 *
 * Auth model: caller passes the access_token they hold post-setSession.
 * verifyAuth confirms the JWT is valid + returns the user_id; the admin
 * client then clears the key. Service-role bypass is fine because
 * verifyAuth already established the caller IS this user.
 *
 * Fire-and-forget at the call site (bridge route). Returns ok:false on
 * failure so the caller can choose to log; UI never blocks on it.
 */
export const clearRefillNext = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => clearInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    let userId: string;
    try {
      userId = await verifyAuth(data.accessToken);
    } catch {
      return { ok: false };
    }
    try {
      const sb = admin();
      // Shallow-merge: setting refill_next to null removes it from the
      // round-tripped JWT after the user's next session refresh. The
      // parser also fails-closed on null/non-object so even if a stale
      // JWT lingers, the trigger ignores it.
      const { error } = await sb.auth.admin.updateUserById(userId, {
        user_metadata: { refill_next: null },
      });
      if (error) {
        console.warn("[clearRefillNext] update failed:", error.message);
        return { ok: false };
      }
      return { ok: true };
    } catch (err) {
      console.warn(
        "[clearRefillNext] unexpected:",
        err instanceof Error ? err.message : err,
      );
      return { ok: false };
    }
  });
