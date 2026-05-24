/**
 * RepShell — the Refill-rep workspace shell (Phase 3.1.5, v401).
 *
 * Persona-aware shell selected from app.tsx when the signed-in user
 * has an active rep_accounts row (via useRepProfile). Renders the
 * Refill-branded workspace chrome — no Agentiport sidebar, no
 * "Workspace" header, no OnboardingWizard overlay (the wizard skips
 * itself for reps in Phase 3.1.7).
 *
 * Closes 3 of the 6 demo blockers from the 2026-05-22 Kelly Caffee
 * dry-run: Pinch #2 (legacy Agentiport sidebar exposed to rep) +
 * Pinch #6 (workspace identity reading "Agentiport") + Pinch #1
 * (onboarding wizard overlays rep landing — wizard skip ships in 3.1.7
 * alongside this shell).
 *
 * Callers are responsible for checking useRepProfile().status === 'rep'
 * before mounting RepShell. If the hook isn't in the 'rep' state when
 * this component renders, we return null (defensive — should never
 * happen given the app.tsx branch).
 */
import { RefillRepShellChrome } from "@/components/refill/RefillRepShellChrome";
import { useRepProfile } from "@/lib/use-rep-profile";

export function RepShell({ children }: { children: React.ReactNode }) {
  const repProfile = useRepProfile();
  if (repProfile.status !== "rep") return null;
  return (
    <div className="min-h-screen" style={{ background: "#fbfaf7" }}>
      <RefillRepShellChrome rep={repProfile.rep} />
      <main className="flex-1 min-w-0 pb-16 md:pb-0">{children}</main>
    </div>
  );
}
