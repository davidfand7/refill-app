/**
 * Toast convention helpers (sonner).
 *
 * Project-wide rules:
 *
 *   toast.success(...)  → action completed (write succeeded, copied, saved)
 *   toast.error(...)    → action failed (network error, permission denied)
 *   toast.warning(...)  → action partially succeeded or has a caveat
 *                        (e.g. "3 normalized, 1 failed")
 *   toast.message(...)  → neutral status / contextual hint
 *                        (e.g. "Filter cleared", "Reverted goal — review")
 *   toast.loading(...)  → in-flight async work (always paired with .success/.error
 *                        on the same `id`)
 *
 * Do NOT use toast.info — collapse those into toast.message for consistency.
 *
 * Title vs description:
 *   - title (first arg): short imperative or status, ≤ ~50 chars
 *   - description (option): the *why* / additional context, full sentence
 *
 * For errors, prefer `failureToast(action, error)` below which produces
 * `{ title: "Could not <action>", description: error.message }` instead of
 * concatenating with a colon.
 */
import { toast } from "sonner";

export function failureToast(action: string, err: unknown, opts?: { id?: string }) {
  const description = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
  return toast.error(`Could not ${action}`, {
    description,
    id: opts?.id,
  });
}

/**
 * Wraps an async action with loading → success/error toasts on a single id,
 * so the toast updates in place instead of stacking.
 */
export function progressToast<T>(
  promise: Promise<T>,
  copy: { loading: string; success: string | ((value: T) => string); error?: string },
  id?: string,
) {
  return toast.promise(promise, {
    loading: copy.loading,
    success: copy.success,
    error: (err) => copy.error ?? (err instanceof Error ? err.message : "Action failed"),
    id,
  });
}

export { toast };
