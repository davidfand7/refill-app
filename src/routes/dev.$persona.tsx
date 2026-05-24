/**
 * /dev/<persona> — zero-friction direct sign-in URLs for testing.
 *
 * Cleave fix 2026-05-24: replaces the magic-link persona switcher that
 * kept tripping race conditions between supabase-js auto-parse, the
 * URL-fragment handoff, and the post-login redirect chain.
 *
 * Mechanic: client-side signInWithPassword with the hardcoded test
 * password (RefillTest2026! — set via pgcrypto in the v417.1.1
 * migration on *.test TLD demo accounts only, NEVER reuse on a real
 * user). On success, hard-navigate to the persona's home path so the
 * session cookie is in place for the next route's auth gate.
 *
 * URLs:
 *   /dev/admin → admin@refill-demo.test  → /app/admin/personas
 *   /dev/kelly → kelly@refill-demo.test  → /app/rep
 *   /dev/maria → maria@refill-demo.test  → /app/rep
 *   /dev/karen → karen@rejuv-demo.test   → /app/refill
 *
 * Drop these URLs in a bookmark folder. Click → signed in → home.
 * No UI, no magic-link round-trip, no auto-parse race.
 */

import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/dev/$persona")({
  component: DevPersonaPage,
});

const PERSONAS = {
  admin: { email: "admin@refill-demo.test", home: "/app/admin/personas" },
  kelly: { email: "kelly@refill-demo.test", home: "/app/rep" },
  maria: { email: "maria@refill-demo.test", home: "/app/rep" },
  karen: { email: "karen@rejuv-demo.test", home: "/app/refill" },
} as const;

type PersonaKey = keyof typeof PERSONAS;

const TEST_PASSWORD = "RefillTest2026!";

function DevPersonaPage() {
  const { persona } = useParams({ from: "/dev/$persona" });
  const navigate = useNavigate();
  const [status, setStatus] = useState<"working" | "error">("working");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const key = persona as PersonaKey;
    const config = PERSONAS[key];
    if (!config) {
      setStatus("error");
      setErrorMsg(`Unknown persona: ${persona}. Valid: ${Object.keys(PERSONAS).join(", ")}`);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const { error } = await supabase.auth.signInWithPassword({
          email: config.email,
          password: TEST_PASSWORD,
        });
        if (cancelled) return;
        if (error) {
          setStatus("error");
          setErrorMsg(error.message);
          return;
        }
        // SPA navigate (NOT window.location.assign) — keeps AuthProvider's
        // session state in memory across the route change. Hard-navigate
        // throws it away and races re-hydration → AppLayout sees !user
        // momentarily → bounces to /login.
        void navigate({ to: config.home });
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [persona, navigate]);

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: "#fbfaf7", color: "#1c2024" }}
    >
      <div className="max-w-md text-center px-6">
        {status === "working" ? (
          <>
            <div
              className="text-[20px] font-semibold mb-2"
              style={{
                fontFamily: "Georgia, 'Times New Roman', serif",
                color: "#056048",
              }}
            >
              Signing in as {persona}…
            </div>
            <div className="text-[13px]" style={{ color: "#5a6068" }}>
              {PERSONAS[persona as PersonaKey]?.email ?? "(unknown persona)"}
            </div>
          </>
        ) : (
          <>
            <div
              className="text-[20px] font-semibold mb-2"
              style={{ color: "#b94842" }}
            >
              Couldn't sign in
            </div>
            <div
              className="text-[13px] font-mono px-4 py-3 rounded-md"
              style={{ background: "#fdecec", color: "#8a1616" }}
            >
              {errorMsg}
            </div>
            <div className="mt-4 text-[12px]" style={{ color: "#8a9098" }}>
              Valid personas: <code>/dev/admin</code> · <code>/dev/kelly</code>{" "}
              · <code>/dev/maria</code> · <code>/dev/karen</code>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
