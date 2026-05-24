import { type ReactNode } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { Link } from "@tanstack/react-router";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CHANGELOG, currentVersion } from "@/lib/changelog";

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumbs?: { label: string; to?: string }[];
}

// CHANGELOG moved to @/lib/changelog (single source of truth).

export function PageHeader({ eyebrow, title, description, actions, breadcrumbs }: PageHeaderProps) {
  return (
    <div className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-30">
      <div className="px-6 lg:px-10 py-5">
        {breadcrumbs && (
          <nav className="flex items-center gap-1 text-xs text-ink-soft mb-2">
            {breadcrumbs.map((b, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3" />}
                {b.to ? (
                  <Link to={b.to} className="hover:text-foreground">
                    {b.label}
                  </Link>
                ) : (
                  <span>{b.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <div className="flex items-start justify-between gap-6">
          <div>
            {eyebrow && (
              <div className="text-[11px] font-medium tracking-wider text-primary uppercase mb-1.5">
                {eyebrow}
              </div>
            )}
            <h1 className="text-2xl lg:text-[28px] font-semibold tracking-tight text-foreground flex items-center gap-2.5">
              {title}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="What's new"
                    title="What's new"
                    className="text-[11px] font-semibold rounded-full bg-amber text-background dark:text-foreground px-2.5 py-0.5 tracking-wide hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition"
                  >
                    {currentVersion()}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80 p-0">
                  <div className="border-b border-border px-4 py-3 flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    <div className="text-sm font-semibold">What's new</div>
                  </div>
                  <div className="max-h-80 overflow-y-auto divide-y divide-border">
                    {CHANGELOG.map((entry) => (
                      <div key={entry.version} className="px-4 py-3">
                        <div className="flex items-baseline justify-between gap-2 mb-1.5">
                          <div className="text-xs font-semibold text-foreground">
                            {entry.version}
                          </div>
                          <div className="text-[10px] uppercase tracking-wide text-ink-soft">
                            {entry.date}
                          </div>
                        </div>
                        <ul className="space-y-1">
                          {entry.items.map((item, i) => (
                            <li
                              key={i}
                              className="text-xs leading-relaxed text-ink-soft pl-3 relative before:content-['•'] before:absolute before:left-0 before:text-primary"
                            >
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </h1>
            {description && (
              <p className="mt-1.5 text-sm text-ink-soft max-w-2xl">{description}</p>
            )}
          </div>
          {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
        </div>
      </div>
    </div>
  );
}
