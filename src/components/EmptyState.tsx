import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Reusable empty-state placeholder used across the app.
 *
 * Renders a soft-tinted icon medallion above a headline, supporting copy,
 * and an optional call-to-action. Pure presentation — no business logic
 * lives here so any surface can drop it in for "no data" / "nothing yet"
 * moments without bespoke styling.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  size = "md",
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const pad =
    size === "sm" ? "py-8" : size === "lg" ? "py-20" : "py-14";
  const medallion =
    size === "sm" ? "h-12 w-12" : size === "lg" ? "h-20 w-20" : "h-16 w-16";
  const iconSize =
    size === "sm" ? "h-5 w-5" : size === "lg" ? "h-9 w-9" : "h-7 w-7";

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center px-6",
        pad,
        className,
      )}
    >
      <div
        className={cn(
          "relative mb-4 inline-flex items-center justify-center rounded-full bg-muted/60 ring-1 ring-border/60",
          medallion,
        )}
      >
        {/* soft halo */}
        <span className="absolute inset-0 rounded-full bg-emerald/5 animate-pulse" aria-hidden />
        <Icon className={cn("relative text-ink-soft", iconSize)} aria-hidden />
      </div>
      <div className="text-base font-semibold tracking-tight">{title}</div>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-ink-soft leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
