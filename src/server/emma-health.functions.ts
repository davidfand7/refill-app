/**
 * Emma(OS) engine health vitals (v380).
 *
 * Read-only signals for the "is the engine alive" page at /app/refill/health.
 * Three rows: rescue dispatches, rescue claims, recovery events. Each row
 * is { lastAt, last24h, last7d }. Cheap insurance for the pilot week — if
 * the page goes silent for a day on a spa that's flipping appointments,
 * something upstream is broken.
 *
 * No mutations, no LLM, just aggregations on three Emma tables. Spa-scoped
 * via verifyAuth so each owner sees only their own pipeline.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";

export type VitalsRow = {
  lastAt: string | null;
  last24h: number;
  last7d: number;
};

export type EngineHealthVitals = {
  rescueAttempts: VitalsRow;
  rescueClaims: VitalsRow;
  recoveryEvents: VitalsRow;
  asOf: string;
};

const input = z.object({ accessToken: z.string().min(1) });

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const getEngineHealthVitals = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => input.parse(raw))
  .handler(async ({ data }): Promise<EngineHealthVitals> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const now = new Date();
    const day1 = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const day7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      attemptsLatest,
      attempts24,
      attempts7,
      claimsLatest,
      claims24,
      claims7,
      recoveryLatest,
      recovery24,
      recovery7,
    ] = await Promise.all([
      sb
        .from("rescue_attempts")
        .select("triggered_at")
        .eq("user_id", userId)
        .order("triggered_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      sb
        .from("rescue_attempts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("triggered_at", day1),
      sb
        .from("rescue_attempts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("triggered_at", day7),
      sb
        .from("rescue_offers")
        .select("claimed_at")
        .eq("user_id", userId)
        .not("claimed_at", "is", null)
        .order("claimed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      sb
        .from("rescue_offers")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .not("claimed_at", "is", null)
        .gte("claimed_at", day1),
      sb
        .from("rescue_offers")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .not("claimed_at", "is", null)
        .gte("claimed_at", day7),
      sb
        .from("recovery_events")
        .select("created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      sb
        .from("recovery_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", day1),
      sb
        .from("recovery_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", day7),
    ]);

    return {
      rescueAttempts: {
        lastAt: attemptsLatest.data?.triggered_at ?? null,
        last24h: attempts24.count ?? 0,
        last7d: attempts7.count ?? 0,
      },
      rescueClaims: {
        lastAt: claimsLatest.data?.claimed_at ?? null,
        last24h: claims24.count ?? 0,
        last7d: claims7.count ?? 0,
      },
      recoveryEvents: {
        lastAt: recoveryLatest.data?.created_at ?? null,
        last24h: recovery24.count ?? 0,
        last7d: recovery7.count ?? 0,
      },
      asOf: now.toISOString(),
    };
  });
