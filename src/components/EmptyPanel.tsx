import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

/**
 * Canonical "nothing here yet" hero for a surface's main content area.
 *
 * Every empty/zero state across the app should read the same way:
 *   icon  ·  one-line title (the "what")  ·  a why-sentence  ·  ONE next-step CTA.
 *
 * Pass the next step via `cta` — either a route (`to`) rendered as a Link, or an
 * in-page action (`onClick`) rendered as a button. The CTA styling is baked here
 * so every surface's call-to-action looks identical; callers only choose the
 * label, icon, and destination.
 *
 * For inline "couldn't load" / error medallions inside an already-populated
 * layout, use <EmptyState> instead — this is for the full empty surface.
 */
type EmptyPanelCta = { label: string; icon?: LucideIcon } & (
  | { to: string }
  | { onClick: () => void; disabled?: boolean }
);

export function EmptyPanel({
  icon: Icon,
  title,
  description,
  cta,
  className,
  bare = false,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  cta?: EmptyPanelCta;
  className?: string;
  /** Drop the bordered card chrome — use when nested inside an existing card/section. */
  bare?: boolean;
}) {
  const ctaClass =
    "inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-4 py-2 text-sm font-medium hover:opacity-90 transition disabled:opacity-50";

  return (
    <div
      className={cn(
        bare
          ? "px-6 py-10 text-center"
          : "rounded-2xl border border-border bg-card p-10 text-center",
        className,
      )}
    >
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted/40">
        <Icon className="h-6 w-6 text-ink-soft" aria-hidden />
      </div>
      <h2 className="mb-1 text-lg font-semibold text-foreground">{title}</h2>
      <p className="mx-auto max-w-md text-sm text-ink-soft leading-relaxed">
        {description}
      </p>
      {cta && (
        <div className="mt-5 flex justify-center">
          {"to" in cta ? (
            <Link to={cta.to} className={ctaClass}>
              {cta.icon && <cta.icon className="h-3.5 w-3.5" aria-hidden />}
              {cta.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={cta.onClick}
              disabled={cta.disabled}
              className={ctaClass}
            >
              {cta.icon && <cta.icon className="h-3.5 w-3.5" aria-hidden />}
              {cta.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
