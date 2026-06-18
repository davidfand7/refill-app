import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { cookieStorage, subscribeCookieStorageChanges } from "@/lib/cookie-storage";
import {
  recordSupabaseFailure,
  recordSupabaseSuccess,
} from "@/lib/circuit-breaker";

function createSupabaseClient() {
  // Vite replaces import.meta.env at build time for client bundles;
  // process.env is the path for server-side fns running in the Worker.
  const SUPABASE_URL =
    import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY =
    import.meta.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "Missing Supabase env vars. Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in .env.local",
    );
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // Cookie storage scoped to .getrefill.app so sessions survive across
      // apex ↔ app subdomain. localStorage would silo the session to one
      // origin. See src/lib/cookie-storage.ts.
      storage: typeof window !== "undefined" ? cookieStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
    },
    global: {
      // Feed the connection-health circuit breaker from real query traffic
      // (src/lib/circuit-breaker.ts). Only a network-level error, a 5xx, or a
      // 429 counts as a failure — any real HTTP response (including a 4xx like
      // an expired token, an empty single() 406, or a 409 conflict) proves the
      // backend is reachable and is recorded as a success. This avoids a false
      // "degraded" banner when the connection is actually fine.
      fetch: async (input, init) => {
        try {
          const res = await fetch(input, init);
          if (res.status >= 500 || res.status === 429) {
            recordSupabaseFailure();
          } else {
            recordSupabaseSuccess();
          }
          return res;
        } catch (err) {
          recordSupabaseFailure();
          throw err;
        }
      },
    },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

/**
 * Lazy-initialized Supabase client. Use:
 *   import { supabase } from "@/integrations/supabase/client";
 */
export const supabase = new Proxy(
  {} as ReturnType<typeof createSupabaseClient>,
  {
    get(_, prop, receiver) {
      if (!_supabase) _supabase = createSupabaseClient();
      return Reflect.get(_supabase, prop, receiver);
    },
  },
);

// Cross-tab session sync: when another tab writes a fresh auth token to
// cookie storage, force this tab's supabase-js to re-read storage so its
// in-memory session is current. Without this bridge, a backgrounded tab
// can keep using a stale access_token until its own refresh fires +
// 401s → spurious SIGNED_OUT.
if (typeof window !== "undefined") {
  subscribeCookieStorageChanges((event) => {
    if (!event.key.includes("auth-token")) return;
    if (!_supabase) return;
    void _supabase.auth.getSession();
  });
}
