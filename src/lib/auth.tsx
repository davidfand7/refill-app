import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { clearAdminViewAsUserIdNoReload } from "@/lib/admin-view-as";
import { clearDispatchFlag } from "@/lib/post-login-redirect";

// v1.22.2 (P2 of unified admin platform) — useAuth no longer exposes
// primaryRole. The previous primary_role read (from user_preferences) was
// the shell-selection signal pre-cleave but had zero live consumers after
// the v1.22.2 cutover: app.tsx and login.tsx now read shell from
// useEffectiveRoles() / getEffectiveRoles() against the unified
// public.user_roles. The user_preferences.primary_role column itself
// stays for one release as fallback (per D3 lock); drops in v1.24.

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

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

  const signOut = async () => {
    // Clear the post-login redirect gate so the next sign-in dispatches
    // fresh — otherwise a re-login in the same tab would skip the role-based
    // bounce and dump the user on /app instead of their subdomain home.
    clearDispatchFlag();
    // v1.24.3: also clear admin impersonation state. Otherwise the next
    // sign-in (this user OR anyone else on this device) would start
    // already mid-impersonation, which is the obvious wrong default.
    clearAdminViewAsUserIdNoReload();
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
