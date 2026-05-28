/**
 * v417.2 — Open public persona-mint server fn.
 *
 * Backs the public /personas page. Takes a persona key (admin / kelly /
 * maria / karen), resolves it to a hardcoded *.test TLD email server-side,
 * and mints a magic link via service-role auth.admin.generateLink. Returns
 * the action_link URL — the client window.location.assigns to it and the
 * v410.2 cross-host bridge takes over from there.
 *
 * No auth gate by design (Grasshopper's v417.2 directive after the
 * v417.1.x admin-login Rube Goldberg burned a night). Safety rails:
 *
 *   1. Persona key is a discriminated union; the email lives server-side,
 *      not in the client payload. An attacker can't ask for a magic link
 *      for arbitrary@email.com — only the four hardcoded *.test personas.
 *   2. All four personas are *.test TLD demo accounts with no real-money
 *      data. Worst-case abuse is signing in as a demo user that has no
 *      capability beyond what's already publicly visible at /scan + /story.
 *   3. The mint is rate-limited at the Supabase admin API layer (separate
 *      from the user-facing signInWithPassword bucket that v417.1.x kept
 *      tripping). No coordination with that bucket.
 *
 * Why magic-link not signInWithPassword: hops the user through the
 * v410.2 cross-host bridge, which lands them on app.getrefill.app
 * pre-authenticated. signInWithPassword on the personas page would put
 * us back in the rate-limit-prone path. Magic link via service-role
 * generateLink is the rate-limit-free path we've been hardening since
 * v410.2.
 *
 * Related: [[feedback-google-oauth-not-hooked-up]] (email/password is the
 * only working admin login — magic links go through generateLink not
 * signInWithOtp) · [[feedback-supabase-magic-link-crosshost-limit]]
 * (Supabase always strips redirect_to to Site URL — bridge handles the
 * landing).
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";

// Persona roster — discriminated key the client passes, email resolved
// server-side. Keep this list aligned with src/server/v417-personas.ts
// PERSONAS so the admin dropdown + public /personas page share semantics.
//
// v1.23.0 P3: admin renamed from admin@refill-demo.test → admin@refill.platform
// per the supabase/migrations/20260620000000_v123_admin_rename.sql migration.
// The rename keeps the same user_id (addf1110-0000-0000-0000-000000000001),
// so user_roles + admin_audit_log references stay valid.
const PERSONA_EMAILS = {
  admin: "admin@refill.platform",
  kelly: "kelly@refill-demo.test",
  maria: "maria@refill-demo.test",
  karen: "karen@rejuv-demo.test",
} as const;

export type PersonaKey = keyof typeof PERSONA_EMAILS;

function admin() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const mintInput = z.object({
  personaKey: z.enum(["admin", "kelly", "maria", "karen"]),
});

export const mintPersonaMagicLink = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => mintInput.parse(raw))
  .handler(async ({ data }): Promise<{ actionLink: string; email: string }> => {
    const email = PERSONA_EMAILS[data.personaKey];
    const sb = admin();
    const { data: link, error } = await sb.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (error) {
      throw new Error(`Couldn't mint magic link for ${email}: ${error.message}`);
    }
    const actionLink = link.properties?.action_link;
    if (!actionLink) {
      throw new Error(`Supabase returned no action_link for ${email}`);
    }
    return { actionLink, email };
  });
