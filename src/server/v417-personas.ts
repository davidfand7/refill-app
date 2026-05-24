/**
 * v417.1 — Admin persona switcher server fns.
 *
 * Grasshopper-only tools backing the /app/admin/personas route. Two
 * surfaces:
 *
 *   bootstrapV417Personas — sets a shared known password on each
 *     persona (kelly@refill-demo.test, maria@refill-demo.test,
 *     karen@rejuv-demo.test). Idempotent — re-running is a no-op
 *     (just resets passwords to the same value). One-time-ish click
 *     after the v417.1 migration applies.
 *
 *   listV417Personas — returns the persona roster with role + dashboard
 *     target so the admin UI can render cards without hardcoding the
 *     list client-side.
 *
 * The shared test password lives in code below (V417_TEST_PASSWORD).
 * Acceptable per [[project_trial_first_no_money_asks]] precedent + the
 * fact that these are *.test TLD personas with no real-money data.
 * NEVER reuse this password on a production-shape account.
 *
 * Auth: both fns gate via verifyAuth + user_roles admin check (same
 * pattern as src/server/v416-admin.ts equivalents).
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";

// Shared known password for v417.1 test personas. *.test TLD accounts
// only; don't reuse on real users.
export const V417_TEST_PASSWORD = "RefillTest2026!";

// The persona list. Admin UI reads this server-side so the dashboard
// targets stay in sync with the post-login-redirect logic.
const PERSONAS = [
  {
    email: "admin@refill-demo.test",
    displayName: "Refill Admin",
    role: "admin" as const,
    description: "Dedicated admin testing identity. Sign in here with email + password (no Google OAuth needed). Lands on the persona switcher.",
    dashboard: "/app/admin/personas",
  },
  {
    email: "kelly@refill-demo.test",
    displayName: "Kelly Caffee",
    role: "rep" as const,
    description: "Top rep — Kelly's the 5/29 demo anchor. 5 Tier-1 sub-reps under her.",
    dashboard: "/app/rep",
  },
  {
    email: "maria@refill-demo.test",
    displayName: "Maria Chen",
    role: "rep" as const,
    description: "Tier-1 sub-rep under Kelly. Use to test the downstream-rep view.",
    dashboard: "/app/rep",
  },
  {
    email: "karen@rejuv-demo.test",
    displayName: "Karen Anderson",
    role: "spa-owner" as const,
    description: "Owner of Rejuv Skin Spa. Full RefillHome with real recovery data.",
    dashboard: "/app/refill",
  },
] as const;

export type V417Persona = (typeof PERSONAS)[number];

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

async function requireAdmin(accessToken: string): Promise<string> {
  const userId = await verifyAuth(accessToken);
  const sb = admin();
  const { data, error } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(`Couldn't verify admin role: ${error.message}`);
  if (!data) throw new Error("Admin role required.");
  return userId;
}

// ─── listV417Personas ───────────────────────────────────────────────────────

const listInput = z.object({ accessToken: z.string().min(1) });

export const listV417Personas = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listInput.parse(raw))
  .handler(async ({ data }): Promise<{ personas: V417Persona[] }> => {
    await requireAdmin(data.accessToken);
    return { personas: [...PERSONAS] };
  });

// ─── bootstrapV417Personas ──────────────────────────────────────────────────

const bootstrapInput = z.object({ accessToken: z.string().min(1) });

export type BootstrapPersonaResult = {
  email: string;
  status: "ok" | "not-found" | "error";
  message?: string;
};

export const bootstrapV417Personas = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => bootstrapInput.parse(raw))
  .handler(
    async ({ data }): Promise<{ results: BootstrapPersonaResult[]; password: string }> => {
      await requireAdmin(data.accessToken);
      const sb = admin();

      // Page through auth.users to find each persona's id. listUsers
      // caps at 200/page; we only need 3 specific emails so the linear
      // scan is fine.
      const targetEmails = new Set(PERSONAS.map((p) => p.email));
      const found = new Map<string, string>();
      let page = 1;
      while (page <= 50 && found.size < targetEmails.size) {
        const { data: list, error } = await sb.auth.admin.listUsers({
          page,
          perPage: 200,
        });
        if (error) throw new Error(`User lookup failed: ${error.message}`);
        for (const u of list.users) {
          const e = u.email?.toLowerCase();
          if (e && targetEmails.has(e as (typeof PERSONAS)[number]["email"])) {
            found.set(e, u.id);
          }
        }
        if (list.users.length < 200) break;
        page += 1;
      }

      const results: BootstrapPersonaResult[] = [];
      for (const persona of PERSONAS) {
        const userId = found.get(persona.email);
        if (!userId) {
          results.push({
            email: persona.email,
            status: "not-found",
            message: "User row missing. Did the seed migration run?",
          });
          continue;
        }
        const { error } = await sb.auth.admin.updateUserById(userId, {
          password: V417_TEST_PASSWORD,
          email_confirm: true,
        });
        if (error) {
          results.push({
            email: persona.email,
            status: "error",
            message: error.message,
          });
        } else {
          results.push({ email: persona.email, status: "ok" });
        }
      }

      return { results, password: V417_TEST_PASSWORD };
    },
  );
