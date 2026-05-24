/**
 * demo-mode.ts — client-side state for the "View as demo" / Showcase mode.
 *
 * The rep flips a toggle to view a curated demo tenant's data (68 accounts +
 * varied sample-order activity) instead of their own. Server-side enforces
 * the data scope via `viewAs: "demo"` on read server fns — the client just
 * tracks whether to send that flag.
 *
 * Persistence: localStorage. The flag survives refresh but resets on
 * logout (cleared by AuthProvider). Default OFF — the rep always opens to
 * their own data first.
 *
 * See [[project-admin-showcase-view-pattern]] for the architectural rationale.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createElement } from "react";

const STORAGE_KEY = "agentiport.demoMode";

type DemoModeContextValue = {
  isDemo: boolean;
  enableDemo: () => void;
  disableDemo: () => void;
  toggleDemo: () => void;
};

const DemoModeContext = createContext<DemoModeContextValue | null>(null);

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const [isDemo, setIsDemo] = useState(false);

  // Hydrate from localStorage on mount (client-only — SSR returns the
  // initial `false` and the post-hydration paint may briefly mismatch;
  // acceptable given how subtle the banner is and how rarely demo mode is
  // the initial state for a fresh tab).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "1") setIsDemo(true);
    } catch {
      /* localStorage can throw in private windows / sandbox — fine to ignore */
    }
  }, []);

  const persist = useCallback((next: boolean) => {
    setIsDemo(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* same as above */
    }
  }, []);

  const enableDemo = useCallback(() => persist(true), [persist]);
  const disableDemo = useCallback(() => persist(false), [persist]);
  const toggleDemo = useCallback(() => persist(!isDemo), [isDemo, persist]);

  return createElement(
    DemoModeContext.Provider,
    { value: { isDemo, enableDemo, disableDemo, toggleDemo } },
    children,
  );
}

export function useDemoMode(): DemoModeContextValue {
  const ctx = useContext(DemoModeContext);
  if (!ctx) {
    // Default-safe: if the provider isn't mounted (e.g. on the public order
    // landing page outside the /app shell), demo mode is just always off.
    return {
      isDemo: false,
      enableDemo: () => undefined,
      disableDemo: () => undefined,
      toggleDemo: () => undefined,
    };
  }
  return ctx;
}

/**
 * Convenience: returns the `viewAs` parameter value to pass to server fns,
 * based on current demo-mode state. Use as:
 *
 *   const viewAs = useViewAs();
 *   await listLizAccounts({ data: { accessToken, viewAs } });
 */
export function useViewAs(): "demo" | undefined {
  const { isDemo } = useDemoMode();
  return isDemo ? "demo" : undefined;
}
