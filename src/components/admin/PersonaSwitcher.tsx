/**
 * PersonaSwitcher — v1.23.0 (P3 of unified admin platform).
 *
 * Cross-shell impersonation dropdown for admins. Renders ONLY when the
 * caller (session user) is admin. Writes the chosen target user_id to
 * localStorage (refill-admin-view-as-user-id) and reloads the page so
 * every cache (useEffectiveRoles, useTenantMembership) re-resolves with
 * the new impersonation context.
 *
 * Visual: native select in the chrome's upper-right strip, grouped by
 * role (My roles / Spa owners / Reps). Compact h-8 to fit alongside the
 * theme toggle / username / sign-out cluster.
 *
 * Server fetch: listImpersonableUsers in role-helpers.ts returns the
 * global list (admin-gated, service-role read). The fetch happens once
 * per session — the list is small (we don't expect 1000s of spa-owners
 * before P4 ships pagination).
 *
 * Why native select over a Popover-based custom dropdown: matches the
 * v1.20.6 inline-tenant-select aesthetic, keyboard nav + accessibility
 * free, zero extra deps, reloads on change so optimistic UI isn't worth
 * building. If a custom dropdown becomes the right UX later, the upgrade
 * is purely cosmetic.
 *
 * Per the plan in ~/.claude/plans/frolicking-stargazing-church.md
 * (D4 lock): localStorage + existing viewAsUserId pattern; no new DB
 * table, no JWT claim work.
 */
import { useEffect, useMemo, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import {
  getAdminViewAsUserId,
  pickRedirectForPersonaSwitch,
  setAdminViewAsUserId,
} from "@/lib/admin-view-as";
import { DEMO_PERSONA_EMAILS } from "@/lib/personas";
import { useEffectiveRoles } from "@/hooks/useEffectiveRoles";
import {
  listImpersonableUsers,
  type ImpersonableUser,
  type Shell,
} from "@/server/role-helpers";

// v1.24.4: singular labels — the demo flow shows exactly one persona
// per role (Admin / Spa Owner / Rep), not a list.
const SHELL_LABEL: Record<Shell, string> = {
  admin: "Admin",
  "spa-owner": "Spa Owner",
  rep: "Rep",
  developer: "Developer",
};

const SHELL_ORDER: Shell[] = ["admin", "spa-owner", "rep", "developer"];

export function PersonaSwitcher() {
  // useEffectiveRoles() without viewAsUserId returns the CALLER's roles
  // (not the impersonated user's). This is what gates rendering — admin
  // status is a property of the session user, not the impersonation
  // target.
  const callerRoles = useEffectiveRoles();
  const isAdmin =
    callerRoles.status === "resolved" && callerRoles.roles.isAdmin;
  const callerUserId =
    callerRoles.status === "resolved" ? callerRoles.roles.callerUserId : null;

  const [users, setUsers] = useState<ImpersonableUser[] | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const { users: fetched } = await listImpersonableUsers({
          data: { accessToken: token },
        });
        if (!cancelled) setUsers(fetched);
      } catch {
        /* non-admin or transient — switcher just won't render this paint */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  // v1.24.4: filter to the three canonical demo personas (caller +
  // Karen Demo + Kelly Demo). The /app/admin/users page handles full
  // user management; PersonaSwitcher is for the demo flow.
  const filtered = useMemo(() => {
    if (!users) return null;
    return users.filter(
      (u) => u.isCaller || DEMO_PERSONA_EMAILS.has(u.email),
    );
  }, [users]);

  // Group users by shell. The caller's own entry always lands in the
  // "Admin" group regardless of their other roles — pinning revert
  // to a stable spot.
  const grouped = useMemo(() => {
    if (!filtered) return null;
    const m = new Map<Shell, ImpersonableUser[]>();
    for (const u of filtered) {
      const groupShell = u.isCaller ? "admin" : u.shell;
      let bucket = m.get(groupShell);
      if (!bucket) {
        bucket = [];
        m.set(groupShell, bucket);
      }
      bucket.push(u);
    }
    return m;
  }, [filtered]);

  if (!isAdmin || !users || !callerUserId || !grouped) return null;

  const currentViewAsUserId = getAdminViewAsUserId();
  const selectedValue = currentViewAsUserId ?? callerUserId;

  function onChange(value: string) {
    if (!callerUserId) return;
    if (value === callerUserId) {
      // v1.34.2.1: smart-route on revert too. If admin is on a
      // spa-owner URL (/app/refill, /app/billing) or rep URL (/app/rep)
      // when reverting to admin, redirect to /app so auto-dispatch
      // lands them in the admin shell home. Pre-fix: revert stayed in
      // place; admin then saw the "Defaulted to first tenant" fall-
      // through (RefillShell) or the "Your account isn't set up as a
      // rep yet" empty state (RepShell). Reverting while ALREADY on an
      // /app/admin/* URL still stays — pickRedirectForPersonaSwitch
      // returns undefined when urlKind === target.
      const redirectTo =
        typeof window !== "undefined"
          ? pickRedirectForPersonaSwitch(window.location.pathname, "admin")
          : undefined;
      setAdminViewAsUserId(null, redirectTo);
      return;
    }
    // v1.24.3: generalized smart-routing. If the current URL's shell-
    // kind (admin / spa-owner / rep) differs from the target persona's
    // shell, redirect to /app so auto-dispatch routes them home.
    // Cross-same-shell switches (cross-spa-owner / cross-rep) reload
    // in place so admin can compare the same surface across personas.
    const targetUser = filtered?.find((u) => u.userId === value);
    const redirectTo =
      typeof window !== "undefined"
        ? pickRedirectForPersonaSwitch(
            window.location.pathname,
            targetUser?.shell ?? null,
          )
        : undefined;
    setAdminViewAsUserId(value, redirectTo);
  }

  return (
    <div className="hidden sm:flex items-center">
      <select
        value={selectedValue}
        onChange={(e) => onChange(e.target.value)}
        aria-label="View as"
        title="View the app as another user"
        className="inline-flex h-8 max-w-[180px] items-center rounded-md border bg-transparent px-2 text-xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{
          color: currentViewAsUserId ? "#8a6d0c" : "#5a6068",
          borderColor: currentViewAsUserId
            ? "rgba(138, 109, 12, 0.4)"
            : "#e6e2d6",
          background: currentViewAsUserId ? "#fdf6dc" : "transparent",
        }}
      >
        {SHELL_ORDER.flatMap((shell) => {
          const bucket = grouped.get(shell);
          if (!bucket || bucket.length === 0) return [];
          return [
            <optgroup key={shell} label={SHELL_LABEL[shell]}>
              {bucket.map((u) => {
                const label = u.isCaller
                  ? `${u.displayName} (Admin)`
                  : u.displayName;
                return (
                  <option key={u.userId} value={u.userId}>
                    {label}
                  </option>
                );
              })}
            </optgroup>,
          ];
        })}
      </select>
    </div>
  );
}
