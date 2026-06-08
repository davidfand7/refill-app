/**
 * Per-section collapse state for the booking-settings page. Each card header is
 * a turn-down; open/closed is remembered per section across reloads.
 *
 * Default is COLLAPSED so entering the page is a clean, scannable list (the
 * master "Online booking" card opts into defaultOpen=true). An app-wide
 * "expand/collapse all" broadcasts via a window event so the independent hook
 * instances (one per section component) stay in sync without shared context.
 */

import { useEffect, useState } from "react";

const EVT = "refill:booking:set-all-sections";

/** Expand or collapse every section at once (fires the broadcast all hooks hear). */
export function setAllBookingSections(open: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVT, { detail: { open } }));
}

export function useSectionCollapse(key: string, defaultOpen = false) {
  const storeKey = `refill.booking.section.${key}`;
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return defaultOpen;
    const v = window.localStorage.getItem(storeKey);
    return v === null ? defaultOpen : v === "1";
  });
  const persist = (n: boolean) => {
    try {
      window.localStorage.setItem(storeKey, n ? "1" : "0");
    } catch {
      /* private mode / storage disabled — in-memory only */
    }
  };
  const toggle = () =>
    setOpen((o) => {
      const n = !o;
      persist(n);
      return n;
    });
  useEffect(() => {
    function onSetAll(e: Event) {
      const next = (e as CustomEvent<{ open: boolean }>).detail?.open;
      if (typeof next !== "boolean") return;
      setOpen(next);
      persist(next);
    }
    window.addEventListener(EVT, onSetAll);
    return () => window.removeEventListener(EVT, onSetAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey]);
  return { open, toggle };
}
