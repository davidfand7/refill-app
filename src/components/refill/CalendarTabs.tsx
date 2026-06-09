/**
 * Shared Calendar sub-nav (Calendar Solution — v2.1.0 IA reorg).
 *
 * One tab strip for the merged scheduling surface: the day/week/month
 * Schedule, the Appointments table (CSV import + status), and the Solution's
 * own settings — Online booking (slot rules/hours/providers) and Connections
 * (PMS connectors). Co-locating the settings is what makes Calendar a
 * self-contained, removable Solution (per project_solution_architecture_ia).
 */

import { Link } from "@tanstack/react-router";
import { CalendarDays, ListChecks, Globe, Plug, Tag } from "lucide-react";

export type CalendarTab = "schedule" | "appointments" | "booking" | "connections" | "offers";

const TABS: Array<{
  key: CalendarTab;
  to: string;
  label: string;
  Icon: typeof CalendarDays;
}> = [
  { key: "schedule", to: "/app/refill/calendar/schedule", label: "Schedule", Icon: CalendarDays },
  { key: "appointments", to: "/app/refill/calendar/appointments", label: "Appointments", Icon: ListChecks },
  { key: "booking", to: "/app/refill/calendar/booking", label: "Online booking", Icon: Globe },
  { key: "offers", to: "/app/refill/calendar/offers", label: "Cross-sell", Icon: Tag },
  { key: "connections", to: "/app/refill/calendar/connections", label: "Connections", Icon: Plug },
];

export function CalendarTabs({ active }: { active: CalendarTab }) {
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
