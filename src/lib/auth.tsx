import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import {
  getMyPrimaryRole,
  type PrimaryRole,
} from "@/server/user-prefs.functions";
import { clearDispatchFlag } from "@/lib/post-login-redirect";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  /**
   * Stage 1 of vertical breakout (Option C subdomain shell). Drives sidebar
   * + (eventually) shell selection. null means "no role stamped yet" → full
   * platform UX, same as 'developer'. Auto-stamped server-side on first
   * spa claim or first Liz message; manually settable via setMyPrimaryRole.
   */
  primaryRole: PrimaryRole | null;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [primaryRole, setPrimaryRole] = useState<PrimaryRole | null>(null);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
    });
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // v314: re-sync session on tab focus / visibility return. A backgrounded
  // Chrome tab can have its JS event loop throttled so aggressively that
  // supabase-js's autoRefresh timer misses its window — when the user
  // comes back, the in-memory access_token is expired but no refresh has
  // fired yet, and the next API call returns 401 → spurious SIGNED_OUT.
  // Force-checking the session on focus closes that gap (supabase-js will
  // run refresh if expires_at is past, no-op otherwise).
  useEffect(() => {
    function resync() {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void supabase.auth.getSession();
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", resync);
      document.addEventListener("visibilitychange", resync);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", resync);
        document.removeEventListener("visibilitychange", resync);
      }
    };
  }, []);

  // Fetch primary_role whenever the session lands or changes. Errors fall
  // back to null = full platform — never block render on a pref read.
  useEffect(() => {
    const accessToken = session?.access_token;
    if (!accessToken) {
      setPrimaryRole(null);
      return;
    }
    let cancelled = false;
    getMyPrimaryRole({ data: { accessToken } })
      .then((r) => {
        if (!cancelled) setPrimaryRole(r.primaryRole);
      })
      .catch(() => {
        if (!cancelled) setPrimaryRole(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  const signOut = async () => {
    // Clear the post-login redirect gate so the next sign-in dispatches
    // fresh — otherwise a re-login in the same tab would skip the role-based
    // bounce and dump the user on /app instead of their subdomain home.
    clearDispatchFlag();
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, primaryRole, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
