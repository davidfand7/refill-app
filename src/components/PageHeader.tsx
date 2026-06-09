/**
 * PageHeader — Refill house-style page header (v1.4.1).
 *
 * Re-skinned 2026-05-26 from the legacy platform-y chrome (sticky bar,
 * backdrop blur, all-caps eyebrow, breadcrumbs, version pill) into the
 * warm brand-forward pattern that matches /scan, /onboard, /login, and
 * RefillHome — Georgia serif h1, soft ink-soft lede, no breadcrumbs,
 * no eyebrow, no in-body v-pill.
 *
 * The version pill + changelog Popover moved into RefillShellChrome's
 * top-right strip so there's a single v-pill per session rather than
 * one duplicated on every page.
 *
 * Back-compat: the `eyebrow` and `breadcrumbs` props are accepted but
 * silently ignored — chip nav already wayfinds the 4 main areas, and
 * the eyebrow was redundant with both the chrome wordmark and the
 * active chip. Kept the prop shape so callers don't need touching.
 */

import { type ReactNode } from "react";

interface PageHeaderProps {
  /** @deprecated chip nav wayfinds; eyebrow ignored as of v1.4.1 */
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  /** @deprecated chip nav wayfinds; breadcrumbs ignored as of v1.4.1 */
  breadcrumbs?: { label: string; to?: string }[];
  /** Match the wide (1280px) content tier on data-dense pages (Schedule,
   *  Patients, Reports…) so the header aligns with the content below it. */
  wide?: boolean;
}

export function PageHeader({ title, description, actions, wide }: PageHeaderProps) {
  return (
    <div className={`px-6 lg:px-10 pt-2 pb-4 w-full mx-auto ${wide ? "max-w-[1280px]" : "max-w-[960px]"}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-[16rem] flex-1">
          <h1
            className="text-[28px] sm:text-[32px] leading-[1.15] font-semibold tracking-tight"
            style={{
              fontFamily: "Georgia, 'Times New Roman', serif",
              color: "#1c2024",
            }}
          >
            {title}
          </h1>
          {description && (
            <p
              className="mt-2.5 text-[14px] leading-[1.55] max-w-2xl"
              style={{ color: "#5a6068" }}
            >
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="shrink-0 flex flex-wrap items-center gap-2 mt-1">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
