/**
 * Per-section collapse state for the booking-settings page (v1.89.0). Each card
 * header acts as a turn-down; open/closed is remembered per section across
 * reloads so an owner who works mostly in one section keeps the others tucked
 * away. Defaults to open so nothing is hidden by surprise on first visit.
 */

import { useState } from "react";

export function useSectionCollapse(key: string, defaultOpen = true) {
  const storeKey = `refill.booking.section.${key}`;
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return defaultOpen;
    const v = window.localStorage.getItem(storeKey);
    return v === null ? defaultOpen : v === "1";
  });
  const toggle = () =>
    setOpen((o) => {
      const n = !o;
      try {
        window.localStorage.setItem(storeKey, n ? "1" : "0");
      } catch {
        /* private mode / storage disabled — fall back to in-memory only */
      }
      return n;
    });
  return { open, toggle };
}
