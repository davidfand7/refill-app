import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Bell, X, Clock, AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

type Priority = "urgent" | "warning" | "info";

interface Notification {
  id: string;
  priority: Priority;
  icon: React.ReactNode;
  title: string;
  body: string;
  link?: string;
  ts: Date;
}

const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, warning: 1, info: 2 };

export function NotificationCenter({
  placement = "bottom",
}: { placement?: "bottom" | "top" } = {}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    if (!user) return;
    const out: Notification[] = [];
    const now = Date.now();

    // Expiring approvals (urgent if < 30 min, warning if < 2 h)
    const { data: pending } = await supabase
      .from("approvals")
      .select("id, title, expires_at, risk_level")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .order("expires_at", { ascending: true })
      .limit(10);

    for (const ap of pending ?? []) {
      const ms = ap.expires_at ? new Date(ap.expires_at).getTime() - now : Infinity;
      const minLeft = ms / 60000;
      if (minLeft < 30) {
        out.push({
          id: `ap-${ap.id}`,
          priority: "urgent",
          icon: <Clock className="h-3.5 w-3.5 text-clay" />,
          title: "Approval expiring soon",
          body: `"${ap.title}" expires in ${Math.max(1, Math.round(minLeft))} min`,
          link: `/app/approvals?selected=${ap.id}`,
          ts: new Date(),
        });
      } else if (minLeft < 120) {
        out.push({
          id: `ap-${ap.id}`,
          priority: "warning",
          icon: <ShieldAlert className="h-3.5 w-3.5 text-amber" />,
          title: "Approval needs review",
          body: `"${ap.title}" expires in ${Math.round(minLeft / 60 * 10) / 10}h`,
          link: `/app/approvals?selected=${ap.id}`,
          ts: new Date(),
        });
      } else {
        out.push({
          id: `ap-${ap.id}`,
          priority: "info",
          icon: <ShieldAlert className="h-3.5 w-3.5 text-ink-soft" />,
          title: "Pending approval",
          body: `"${ap.title}"`,
          link: `/app/approvals?selected=${ap.id}`,
          ts: new Date(),
        });
      }
    }

    // Agents with low readiness
    const { data: agents } = await supabase
      .from("agents")
      .select("id, name, readiness_score, status")
      .eq("user_id", user.id)
      .lt("readiness_score", 50)
      .gt("readiness_score", 0)
      .neq("status", "draft")
      .limit(5);

    for (const ag of agents ?? []) {
      out.push({
        id: `ag-${ag.id}`,
        priority: "warning",
        icon: <AlertTriangle className="h-3.5 w-3.5 text-amber" />,
        title: "Low readiness score",
        body: `${ag.name} is at ${ag.readiness_score}/100 — review failing tests`,
        link: `/app/agents/${ag.id}?tab=Tests`,
        ts: new Date(),
      });
    }

    // Recent important activity (last 24h)
    const yesterday = new Date(now - 86400000).toISOString();
    const { data: events } = await supabase
      .from("activity_events")
      .select("id, type, title, created_at, agent_id")
      .eq("user_id", user.id)
      .gte("created_at", yesterday)
      .in("type", ["deploy.success", "deploy.failed", "test.completed"])
      .order("created_at", { ascending: false })
      .limit(5);

    for (const ev of events ?? []) {
      const isFail = ev.type.includes("failed");
      out.push({
        id: `ev-${ev.id}`,
        priority: isFail ? "warning" : "info",
        icon: isFail
          ? <AlertTriangle className="h-3.5 w-3.5 text-amber" />
          : <CheckCircle2 className="h-3.5 w-3.5 text-sage" />,
        title: ev.title,
        body: formatDistanceToNow(new Date(ev.created_at), { addSuffix: true }),
        link: ev.agent_id ? `/app/agents/${ev.agent_id}` : undefined,
        ts: new Date(ev.created_at),
      });
    }

    // Sort by priority then recency
    out.sort((a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      b.ts.getTime() - a.ts.getTime(),
    );

    setItems(out);
  };

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 30000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const visible = items.filter((i) => !dismissed.has(i.id));
  const urgentCount = visible.filter((i) => i.priority === "urgent").length;
  const unreadCount = visible.length;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
          open ? "bg-sidebar-accent text-foreground" : "text-ink-soft hover:bg-sidebar-accent/60 hover:text-foreground",
        )}
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount})` : ""}`}
        aria-expanded={open}
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className={cn(
            "absolute -top-0.5 -right-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[9px] font-bold",
            urgentCount > 0 ? "bg-clay text-white" : "bg-amber text-white",
          )}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className={cn(
            "absolute w-80 rounded-2xl border border-border bg-card shadow-xl z-50",
            // Anchor based on placement: sidebar mounts have placement="bottom"
            // (popover floats UP from a footer-anchored bell). Mobile mounts
            // and other top-anchored bells use placement="top" (popover floats
            // DOWN from a top-bar bell, right-aligned to stay on screen).
            placement === "bottom"
              ? "bottom-full left-0 mb-2"
              : "top-full right-0 mt-2",
          )}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-sm font-medium">Notifications</span>
            {visible.length > 0 && (
              <button
                onClick={() => setDismissed(new Set(items.map((i) => i.id)))}
                className="text-[11px] text-ink-soft hover:text-foreground"
              >
                Clear all
              </button>
            )}
          </div>

          {visible.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <CheckCircle2 className="h-8 w-8 text-sage mx-auto mb-2" />
              <p className="text-sm text-ink-soft">All caught up!</p>
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto divide-y divide-border">
              {visible.map((n) => {
                const inner = (
                  <div className="flex items-start gap-2.5 px-4 py-3 hover:bg-muted/40 transition-colors">
                    <span className="mt-0.5 shrink-0">{n.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{n.title}</p>
                      <p className="text-[11px] text-ink-soft leading-snug mt-0.5">{n.body}</p>
                    </div>
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDismissed((prev) => new Set([...prev, n.id])); }}
                      className="shrink-0 text-ink-soft hover:text-foreground mt-0.5"
                      aria-label="Dismiss notification"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
                return (
                  <li key={n.id}>
                    {n.link ? (
                      <Link to={n.link as any} onClick={() => setOpen(false)}>
                        {inner}
                      </Link>
                    ) : inner}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="border-t border-border px-4 py-2.5">
            <Link
              to="/app/refill"
              onClick={() => setOpen(false)}
              className="block text-center text-[11px] font-medium text-emerald hover:underline"
            >
              View all activity →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
