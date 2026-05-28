/**
 * /app/admin/audit — P5 audit log viewer.
 *
 * Chronological list of every admin action recorded in
 * public.admin_audit_log. Filters: action / actor / target. Pagination
 * is by limit (default 200, max 500); cursor-paging can land later if
 * volume calls for it.
 */
import { createFileRoute } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "@/components/PageHeader";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { supabase } from "@/integrations/supabase/client";
import {
  listAuditEvents,
  type AuditLogEntry,
} from "@/server/admin-audit";

export const Route = createFileRoute("/app/admin/audit")({
  component: AdminAuditPage,
});

const KNOWN_ACTIONS = [
  "p1.role.backfill",
  "admin.rename",
  "user.create",
  "user.password_reset",
  "user.delete",
  "role.grant",
  "role.revoke",
  "impersonate.start",
  "impersonate.stop",
  "flag.toggle",
  "flag.delete",
];

function AdminAuditPage() {
  const isAdmin = useIsAdmin();
  const [events, setEvents] = useState<AuditLogEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const { events: e } = await listAuditEvents({
        data: {
          accessToken: token,
          actionFilter: actionFilter || undefined,
        },
      });
      setEvents(e);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    }
  }, [actionFilter]);

  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin, load]);

  if (!isAdmin) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-sm text-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Admin"
        title="Audit log"
        description="Every privileged admin action — role grants, user creates, password resets, flag toggles, persona switches (if logged), and more."
        breadcrumbs={[
          { label: "Admin", to: "/app/admin" },
          { label: "Audit log" },
        ]}
      />

      <div className="px-6 lg:px-10 py-8 max-w-6xl mx-auto space-y-4">
        <div className="flex items-center gap-2">
          <label className="text-[11px] uppercase tracking-wider text-ink-soft">
            Filter
          </label>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="rounded-md border bg-white px-3 py-1.5 text-xs outline-none focus:ring-2"
            style={{ borderColor: "#e6e2d6" }}
          >
            <option value="">All actions</option>
            {KNOWN_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <div className="text-xs text-ink-soft ml-auto">
            {events === null ? "Loading…" : `${events.length} events`}
          </div>
        </div>

        {loadError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {events && events.length === 0 && (
          <div
            className="rounded-xl border bg-card p-8 text-center text-sm text-ink-soft"
            style={{ borderColor: "#e6e2d6" }}
          >
            No audit events match.
          </div>
        )}

        {events && events.length > 0 && (
          <div
            className="overflow-hidden rounded-xl border bg-card"
            style={{ borderColor: "#e6e2d6" }}
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-[11px] uppercase tracking-wider text-ink-soft">
                <tr>
                  <th className="text-left px-4 py-2.5">When</th>
                  <th className="text-left px-4 py-2.5">Actor</th>
                  <th className="text-left px-4 py-2.5">Action</th>
                  <th className="text-left px-4 py-2.5">Target</th>
                  <th className="text-left px-4 py-2.5">Payload</th>
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: "#e6e2d6" }}>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-3 text-xs text-ink-soft font-mono whitespace-nowrap">
                      {new Date(e.actedAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {e.actorEmail ?? (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="inline-flex h-6 items-center rounded-full px-2 text-[11px] font-mono font-medium"
                        style={{ background: "#e8f1ed", color: "#056048" }}
                      >
                        {e.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {e.targetEmail ?? (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-ink-soft max-w-[36ch] truncate">
                      {Object.keys(e.payload).length === 0
                        ? "—"
                        : JSON.stringify(e.payload)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
