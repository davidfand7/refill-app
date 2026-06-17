/**
 * PublicBrandHeader — the white-label brand mark shown at the top of the public
 * patient pages (rescue claim, waitlist opt-in, booking). v2.70.0.
 *
 * Renders the spa's logo image when set, else a letter-mark badge + name. The
 * KEY job over the old inline version: an onError fallback. A logo URL that
 * 404s / expires used to leave a broken-image gap mid-flow (scout finding);
 * now a failed load falls back to the letter-mark + name so the brand never
 * vanishes. (Email can't run onError, so that path keeps its alt-text fallback.)
 *
 * Shared so the three pages can't drift; per-page palette differences are props
 * (nameClassName, wrapperClassName).
 */

import { useState } from "react";

export type PublicBrandHeaderBrand = {
  name: string;
  accent: string;
  logoUrl: string | null;
  logoMark: string;
};

export function PublicBrandHeader({
  brand,
  nameClassName = "text-[#1c2024]",
  wrapperClassName = "mb-4",
}: {
  brand: PublicBrandHeaderBrand;
  /** Tailwind class for the brand-name text (per-page palette). */
  nameClassName?: string;
  /** Tailwind class for the centering wrapper (per-page spacing). */
  wrapperClassName?: string;
}) {
  // Tracks whether the logo image loaded. A 404/expired URL flips this false
  // and we fall through to the letter-mark — never a broken-image gap.
  const [logoOk, setLogoOk] = useState(true);
  const showLogo = !!brand.logoUrl && logoOk;

  return (
    <div className={`flex items-center justify-center ${wrapperClassName}`}>
      {showLogo ? (
        <img
          src={brand.logoUrl!}
          alt={brand.name}
          onError={() => setLogoOk(false)}
          className="h-9 max-w-[200px] object-contain"
        />
      ) : (
        <div className="inline-flex items-center gap-2">
          <span
            className="h-7 w-7 rounded-full flex items-center justify-center text-white font-bold text-sm"
            style={{ backgroundColor: brand.accent }}
          >
            {brand.logoMark}
          </span>
          <span className={`text-[15px] font-semibold ${nameClassName}`}>
            {brand.name}
          </span>
        </div>
      )}
    </div>
  );
}
