/**
 * /personas — Public persona switcher (v417.2).
 *
 * Open page (no auth gate) that lets Grasshopper sign in as any of the
 * four demo personas via a service-role-minted magic link. The whole
 * point: kill the v417.1.x login Rube Goldberg by routing around both
 * the user-endpoint signInWithPassword rate limit AND the manual
 * email/password flow. Click a persona → server mints magic link →
 * window.location.assigns → cross-host bridge lands the persona on
 * their dashboard.
 *
 * Aesthetic mirrors getrefill.app/login (v416.A.2): paper background,
 * emerald accent, Georgia serif headlines, single centered composition.
 * Stays Refill-pure even though the page itself is a stealth admin tool.
 *
 * No auth gate by design — the mint server fn locks the persona list
 * server-side, so the open page can only mint links for the four *.test
 * TLD demo accounts. See src/server/v417-persona-mint.ts for the
 * safety-rail reasoning.
 *
 * Related: [[project_refill_trojan_horse_thesis]] (why the page lives
 * on the Refill apex, not Agentiport) · [[feedback-emma-never-user-facing]]
 * (persona descriptions avoid Emma references on a user-facing page —
 * Karen lands on the "Refill spa-owner dashboard").
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

import {
  mintPersonaMagicLink,
  type PersonaKey,
} from "@/server/v417-persona-mint";

export const Route = createFileRoute("/personas")({
  component: PersonasPage,
});

type PersonaCard = {
  key: PersonaKey;
  displayName: string;
  roleLabel: string;
  email: string;
  description: string;
  lands: string;
};

const PERSONAS: PersonaCard[] = [
  {
    key: "admin",
    displayName: "Refill Admin",
    roleLabel: "Admin",
    email: "admin@refill-demo.test",
    description:
      "Dedicated admin testing identity. Lands on the persona switcher with full admin tooling.",
    lands: "/app/admin/personas",
  },
  {
    key: "kelly",
    displayName: "Kelly Caffee",
    roleLabel: "Top rep",
    email: "kelly@refill-demo.test",
    description:
      "Anchor rep for the 5/29 demo. Five Tier-1 sub-reps under her. Lands on RepHome.",
    lands: "/app/rep",
  },
  {
    key: "maria",
    displayName: "Maria Chen",
    roleLabel: "Sub-rep",
    email: "maria@refill-demo.test",
    description:
      "Tier-1 sub-rep under Kelly. Use to test the downstream-rep view.",
    lands: "/app/rep",
  },
  {
    key: "karen",
    displayName: "Karen Anderson",
    roleLabel: "Spa owner",
    email: "karen@rejuv-demo.test",
    description:
      "Owner of Rejuv Skin Spa. Full Refill spa-owner dashboard with real recovery data.",
    lands: "/app/refill",
  },
];

function PersonasPage() {
  const [pendingKey, setPendingKey] = useState<PersonaKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async (key: PersonaKey) => {
    if (pendingKey) return;
    setError(null);
    setPendingKey(key);
    try {
      const { actionLink } = await mintPersonaMagicLink({
        data: { personaKey: key },
      });
      window.location.assign(actionLink);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't mint a sign-in link.",
      );
      setPendingKey(null);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "#fbfaf7", color: "#1c2024" }}
    >
      <header className="px-5 sm:px-8 py-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-3 group">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-lg transition group-hover:opacity-90"
              style={{ background: "#056048", color: "#fbfaf7" }}
              aria-hidden
            >
              <span
                className="text-[20px] font-semibold leading-none"
                style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
              >
                R
              </span>
            </div>
            <span
              className="text-[15px] font-semibold tracking-tight"
              style={{
                color: "#056048",
                fontFamily: "Georgia, 'Times New Roman', serif",
              }}
            >
              Refill
            </span>
          </Link>
          <Link
            to="/login"
            className="text-[13px] transition hover:opacity-80"
            style={{ color: "#5a6068" }}
          >
            Regular sign in →
          </Link>
        </div>
      </header>

      <main className="flex-1 px-5 sm:px-8 py-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-8">
            <h1
              className="text-[28px] sm:text-[34px] leading-[1.15] font-semibold tracking-tight mb-2"
              style={{
                fontFamily: "Georgia, 'Times New Roman', serif",
                color: "#1c2024",
              }}
            >
              Step inside a persona.
            </h1>
            <p
              className="text-[15px] leading-[1.55] max-w-xl mx-auto"
              style={{ color: "#5a6068" }}
            >
              Pick a demo identity and we'll sign you in. Each persona lands
              on their own dashboard with the right data already in place.
            </p>
          </div>

          {error && (
            <div
              className="mb-6 max-w-xl mx-auto rounded-md px-4 py-3 text-[13px]"
              style={{ background: "#fdecec", color: "#8a1616" }}
            >
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {PERSONAS.map((p) => (
              <PersonaButton
                key={p.key}
                persona={p}
                loading={pendingKey === p.key}
                disabled={pendingKey !== null && pendingKey !== p.key}
                onSignIn={() => void handleSignIn(p.key)}
              />
            ))}
          </div>

          <p
            className="mt-8 text-[12px] text-center max-w-xl mx-auto leading-[1.6]"
            style={{ color: "#8a9098" }}
          >
            Demo accounts only (<code>*.test</code> emails — no real-world
            data). Clicking signs you in via a one-shot magic link minted on
            the server.
          </p>
        </div>
      </main>

      <footer className="px-5 sm:px-8 py-8">
        <div
          className="max-w-5xl mx-auto text-center text-[12px]"
          style={{ color: "#8a9098" }}
        >
          Built for med-spas.
        </div>
      </footer>
    </div>
  );
}

function PersonaButton({
  persona,
  loading,
  disabled,
  onSignIn,
}: {
  persona: PersonaCard;
  loading: boolean;
  disabled: boolean;
  onSignIn: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSignIn}
      disabled={loading || disabled}
      className="text-left rounded-xl border bg-white p-5 sm:p-6 transition hover:shadow-md disabled:opacity-50 disabled:hover:shadow-none"
      style={{ borderColor: "#e6e2d6" }}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div
          className="text-[17px] font-semibold leading-tight"
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            color: "#1c2024",
          }}
        >
          {persona.displayName}
        </div>
        <span
          className="shrink-0 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full"
          style={{ background: "#e8f1ed", color: "#056048" }}
        >
          {persona.roleLabel}
        </span>
      </div>
      <div
        className="text-[12px] font-mono mb-3"
        style={{ color: "#8a9098" }}
      >
        {persona.email}
      </div>
      <p
        className="text-[13px] leading-[1.55] mb-4"
        style={{ color: "#5a6068" }}
      >
        {persona.description}
      </p>
      <div className="flex items-center justify-between">
        <span
          className="text-[11px]"
          style={{ color: "#8a9098" }}
        >
          Lands at <code>{persona.lands}</code>
        </span>
        <span
          className="inline-flex items-center gap-1.5 text-[13px] font-semibold"
          style={{ color: "#056048" }}
        >
          {loading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Signing in…
            </>
          ) : (
            <>
              Sign in
              <ArrowRight className="h-3.5 w-3.5" />
            </>
          )}
        </span>
      </div>
    </button>
  );
}
