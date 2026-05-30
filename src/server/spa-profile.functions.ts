/**
 * Spa-profile editor server fns (v1.26.22).
 *
 * Thin server-fn wrappers around the helpers in emma-spa-profile.ts so
 * the Settings UI (src/routes/app.refill.settings.spa-profile.tsx) can
 * read + write the three knowledge_nodes spa-profile scalars
 * (spa-name, owner-display-name, from-number) without exposing the
 * underlying table shape to the browser.
 *
 * Why this file exists vs. extending emma-spa-profile.ts directly:
 * emma-spa-profile.ts is a pure helper module (no createServerFn) so it
 * stays import-clean for the three Emma surfaces that already call it
 * (rescue, preshow, blast). Server-fn wrappers introduce a separate
 * import shape; co-locating them here keeps the helper module pure
 * while exposing browser-callable surfaces here.
 *
 * Impersonation: both fns honor viewAsUserId via resolveEffectiveUserId
 * — admin viewing-as Karen can edit Karen's spa-profile from the
 * Settings page, matching the v1.20-era spa-owner-fn impersonation
 * pattern. Non-admin callers passing viewAsUserId get a hard 403 at
 * the resolver layer.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import {
  getSpaProfileBundle,
  setSpaProfileLookupKey,
  type SpaProfileBundle,
} from "@/server/emma-spa-profile";

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

const getInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export const getSpaProfileBundleFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => getInput.parse(raw))
  .handler(async ({ data }): Promise<SpaProfileBundle> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    return getSpaProfileBundle(admin(), effectiveUserId);
  });

const setInput = z.object({
  accessToken: z.string().min(1),
  lookupKey: z.enum(["spa-name", "owner-display-name", "from-number"]),
  value: z.string().nullable(),
  viewAsUserId: z.string().uuid().optional(),
});

export const setSpaProfileLookupKeyFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => setInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    await setSpaProfileLookupKey(
      admin(),
      effectiveUserId,
      data.lookupKey,
      data.value,
    );
    return { ok: true };
  });
