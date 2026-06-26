/**
 * Shared sub-nav for the Refill Solution — no-show recovery (v2.1.0 IA reorg).
 *
 * "Refill" is now a Solution under the SmartSpa umbrella: it both PREVENTS
 * no-shows (Reminders, the old Preshow agent) and RECOVERS them (Renew, the
 * old Renew agent), with the recovery dashboard as the Overview. Dissolves
 * the old standalone "Agents" section into the Solution it configures.
 */

import { Link } from "@tanstack/react-router";
import { LayoutDashboard, BellRing, LifeBuoy, CalendarClock, Inbox } from "lucide-react";

export type RefillSolutionTab =
  | "overview"
  | "reminders"
  | "rescue"
  | "reschedule"
  | "inbox";

const TABS: Array<{
  key: RefillSolutionTab;
  to: string;
  label: string;
  Icon: typeof LayoutDashboard;
}> = [
  { key: "overview", to: "/app/refill/recovery", label: "Overview", Icon: LayoutDashboard },
  { key: "reminders", to: "/app/refill/recovery/preshow", label: "Reminders", Icon: BellRing },
  { key: "rescue", to: "/app/refill/recovery/rescue", label: "Renew", Icon: LifeBuoy },
  { key: "reschedule", to: "/app/refill/recovery/reschedule", label: "Reschedule", Icon: CalendarClock },
  { key: "inbox", to: "/app/refill/inbox", label: "Inbox", Icon: Inbox },
];

export function RefillSolutionTabs({ active }: { active: RefillSolutionTab }) {
  return (
    <div className="border-b border-rule bg-paper/50">
      <div className="max-w-[960px] mx-auto px-4 lg:px-10 flex items-center gap-1">
        {TABS.map(({ key, to, label, Icon }) => (
          <Link
            key={key}
            to={to}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px transition"
            style={{
              borderColor: active === key ? "#056048" : "transparent",
              color: active === key ? "#056048" : "#5a6068",
            }}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Link>
        ))}
      </div>
    </div>
  );
}
