/**
 * Single source of truth for "is the current user an admin?".
 *
 * Admin checks were previously inlined ad-hoc on /app/templates. Promoting
 * this to a hook lets new admin gates (e.g. the agent → template fork flow)
 * share one cached query keyed on user id, so navigating between admin pages
 * doesn't refire the check on every mount.
 *
 * Returns `false` (never `null`) when no user / not yet loaded so callers can
 * gate UI without juggling tri-state booleans.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

// Module-level cache so cross-component navigations are free. Keyed by uid.
const cache = new Map<string, boolean>();

export function useIsAdmin(): boolean {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean>(
    user ? (cache.get(user.id) ?? false) : false,
  );

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    const cached = cache.get(user.id);
    if (cached !== undefined) {
      setIsAdmin(cached);
      return;
    }
    let cancelled = false;
    supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle()
      .then(({ data }) => {
        const result = !!data;
        cache.set(user.id, result);
        if (!cancelled) setIsAdmin(result);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  return isAdmin;
}
