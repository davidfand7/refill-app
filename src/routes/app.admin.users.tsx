/**
 * /app/admin/users — P4 admin user/role management.
 *
 * Surface for the unified admin platform's user-management piece (D9 +
 * P4 in the locked plan). Lists every auth.users row with its roles + tenant
 * attribution + rep display name. Admin can create users, send password
 * resets, grant/revoke roles, and delete users. Every mutation writes to
 * admin_audit_log.
 *
 * Auth: useIsAdmin gate. Non-admins are redirected to /app on mount.
 * Server-side every fn re-verifies admin role; the client gate is just
 * to avoid wasting a round-trip.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Check,
  Key,
  Loader2,
  Plus,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import {
  createUser,
  deleteUser,
  grantRole,
  listUsers,
  revokeRole,
  sendPasswordReset,
  type AdminUserRow,
} from "@/server/admin-users";

export const Route = createFileRoute("/app/admin/users")({
  component: AdminUsersPage,
});

const ROLES: Array<{
  key: "admin" | "spa_owner" | "rep" | "sub_rep" | "developer";
  label: string;
}> = [
  { key: "admin", label: "admin" },
  { key: "spa_owner", label: "spa_owner" },
  { key: "rep", label: "rep" },
  { key: "sub_rep", label: "sub_rep" },
  { key: "developer", label: "developer" },
];

function AdminUsersPage() {
  const { session, loading: authLoading } = useAuth();
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();

  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      void navigate({ to: "/login" });
      return;
    }
  }, [authLoading, session, navigate]);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const { users: u } = await listUsers({ data: { accessToken: token } });
      setUsers(u);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load users.");
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin, load]);

  async function toggleRole(
    user: AdminUserRow,
    role: typeof ROLES[number]["key"],
  ) {
    setBusyUserId(user.userId);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Signed out — refresh and try again.");
      const has = user.roles.includes(role);
      if (has) {
        await revokeRole({ data: { accessToken: token, targetUserId: user.userId, role } });
        toast.success(`Revoked ${role} from ${user.email}`);
      } else {
        await grantRole({ data: { accessToken: token, targetUserId: user.userId, role } });
        toast.success(`Granted ${role} to ${user.email}`);
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update role.");
    } finally {
      setBusyUserId(null);
    }
  }

  async function onSendReset(user: AdminUserRow) {
    setBusyUserId(user.userId);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Signed out.");
      await sendPasswordReset({
        data: { accessToken: token, targetUserId: user.userId },
      });
      toast.success(`Reset email sent to ${user.email}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send reset.");
    } finally {
      setBusyUserId(null);
    }
  }

  async function onDelete(user: AdminUserRow) {
    const confirm = window.confirm(
      `Delete ${user.email} permanently? This cascades to user_roles + sessions and cannot be undone.`,
    );
    if (!confirm) return;
    setBusyUserId(user.userId);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Signed out.");
      await deleteUser({
        data: { accessToken: token, targetUserId: user.userId },
      });
      toast.success(`Deleted ${user.email}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete.");
    } finally {
      setBusyUserId(null);
    }
  }

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
        title="Users & roles"
        description="Manage every user, their roles, and their access. All mutations write to admin_audit_log."
        breadcrumbs={[
          { label: "Admin", to: "/app/admin" },
          { label: "Users" },
        ]}
      />

      <div className="px-6 lg:px-10 py-8 max-w-6xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-ink-soft">
            {users === null
              ? "Loading…"
              : `${users.length} user${users.length === 1 ? "" : "s"}`}
          </div>
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-xs font-medium"
            style={{ background: "#056048", color: "#fbfaf7" }}
          >
            <Plus className="h-3.5 w-3.5" />
            Create user
          </button>
        </div>

        {loadError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {users && (
          <div
            className="overflow-hidden rounded-xl border bg-card"
            style={{ borderColor: "#e6e2d6" }}
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-[11px] uppercase tracking-wider text-ink-soft">
                <tr>
                  <th className="text-left px-4 py-2.5">Email</th>
                  <th className="text-left px-4 py-2.5">Attribution</th>
                  <th className="text-left px-4 py-2.5">Roles</th>
                  <th className="text-right px-4 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: "#e6e2d6" }}>
                {users.map((u) => (
                  <tr key={u.userId} className="text-foreground">
                    <td className="px-4 py-3">
                      <div className="font-medium truncate max-w-[28ch]" title={u.email}>
                        {u.email}
                      </div>
                      <div className="text-[11px] text-ink-soft mt-0.5">
                        {u.emailConfirmedAt ? "confirmed" : "unconfirmed"}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-soft">
                      {u.tenantName && <div>tenant: {u.tenantName}</div>}
                      {u.repDisplayName && <div>rep: {u.repDisplayName}</div>}
                      {!u.tenantName && !u.repDisplayName && <span>—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {ROLES.map((r) => {
                          const has = u.roles.includes(r.key);
                          const isBusy = busyUserId === u.userId;
                          return (
                            <button
                              key={r.key}
                              onClick={() => toggleRole(u, r.key)}
                              disabled={isBusy}
                              className="inline-flex h-6 items-center rounded-full px-2 text-[11px] font-medium transition disabled:opacity-50"
                              style={{
                                background: has ? "#e8f1ed" : "transparent",
                                color: has ? "#056048" : "#8a9098",
                                border: `1px solid ${has ? "#056048" : "#e6e2d6"}`,
                              }}
                              title={
                                has ? `Revoke ${r.label}` : `Grant ${r.label}`
                              }
                            >
                              {has && <Check className="h-3 w-3 mr-1" />}
                              {r.label}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => onSendReset(u)}
                          disabled={busyUserId === u.userId}
                          title="Send password reset email"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-muted disabled:opacity-50"
                        >
                          <Key className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => onDelete(u)}
                          disabled={busyUserId === u.userId}
                          title="Delete user"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {createOpen && (
        <CreateUserModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [initialRole, setInitialRole] = useState<
    "admin" | "spa_owner" | "rep" | "sub_rep" | "developer" | "member" | ""
  >("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Signed out.");
      await createUser({
        data: {
          accessToken: token,
          email: email.trim(),
          password: password.trim() || undefined,
          initialRole: initialRole || undefined,
        },
      });
      toast.success(`Created ${email}`);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: "#e6e2d6" }}
        >
          <div>
            <h2 className="font-semibold text-base flex items-center gap-2">
              <UserPlus className="h-4 w-4" />
              Create user
            </h2>
            <p className="text-xs mt-0.5 text-ink-soft">
              Provide a password to skip email confirmation; otherwise an
              invite will be emailed.
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-soft hover:opacity-70"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <form onSubmit={onSubmit} className="px-5 py-4 space-y-3">
          <label className="block">
            <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 text-ink-soft">
              Email
            </div>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border bg-white px-3 py-2 text-sm outline-none focus:ring-2"
              style={{ borderColor: "#e6e2d6" }}
              autoFocus
            />
          </label>
          <label className="block">
            <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 text-ink-soft">
              Password (optional)
            </div>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="leave blank to send invite email"
              className="w-full rounded-md border bg-white px-3 py-2 text-sm outline-none focus:ring-2"
              style={{ borderColor: "#e6e2d6" }}
            />
          </label>
          <label className="block">
            <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 text-ink-soft">
              Initial role (optional)
            </div>
            <select
              value={initialRole}
              onChange={(e) =>
                setInitialRole(e.target.value as typeof initialRole)
              }
              className="w-full rounded-md border bg-white px-3 py-2 text-sm outline-none focus:ring-2"
              style={{ borderColor: "#e6e2d6" }}
            >
              <option value="">— none —</option>
              {ROLES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
              <option value="member">member</option>
            </select>
          </label>
          {error && (
            <div className="rounded-md px-3 py-2 text-xs bg-destructive/10 text-destructive">
              {error}
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="inline-flex h-9 items-center rounded-md border px-3 text-xs font-medium"
              style={{ borderColor: "#e6e2d6", color: "#5a6068" }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-xs font-medium"
              style={{ background: "#056048", color: "#fbfaf7" }}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
