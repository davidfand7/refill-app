/**
 * Shell detection — Refill-only stub (Step 3.5 placeholder, deeper
 * simplification in Step 3.12).
 *
 * In openagenticv4 this returned 'refill' | 'karen' | 'liz' | 'platform'
 * based on hostname. In refill-app there is only one shell, so the hook
 * always returns 'refill'. Kept as a hook (not a constant) so callers that
 * destructure useShell()'s return value keep working without per-call edits.
 */

export type AgentiportShell = "refill";

export const SHELL_HEADER = "x-agentiport-shell"; // unused post-cleave; kept for type-compat

export function useShell(): AgentiportShell {
  return "refill";
}
