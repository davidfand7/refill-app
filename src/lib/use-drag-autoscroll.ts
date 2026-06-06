/**
 * useDragAutoScroll — scroll the window while an HTML5 drag is near the top or
 * bottom edge (native DnD doesn't auto-scroll, so dragging an item to a far
 * target is otherwise impossible). Extracted from app.refill.settings.booking.tsx
 * in the v1.67.x consolidation sprint so the calendar can reuse it too.
 *
 * Call `start()` on dragStart and `stop()` on dragEnd.
 */

import { useEffect, useRef } from "react";

export function useDragAutoScroll() {
  const st = useRef<{ vy: number; raf: number; on: boolean; off?: () => void }>({
    vy: 0,
    raf: 0,
    on: false,
  });

  function start() {
    const s = st.current;
    if (s.on) return;
    s.on = true;
    const onOver = (e: DragEvent) => {
      const EDGE = 100;
      const h = window.innerHeight;
      const y = e.clientY;
      s.vy = y < EDGE ? -Math.ceil((EDGE - y) / 4) : y > h - EDGE ? Math.ceil((y - (h - EDGE)) / 4) : 0;
    };
    window.addEventListener("dragover", onOver);
    s.off = () => window.removeEventListener("dragover", onOver);
    const tick = () => {
      if (!s.on) return;
      if (s.vy) window.scrollBy(0, s.vy);
      s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
  }

  function stop() {
    const s = st.current;
    s.on = false;
    s.vy = 0;
    if (s.raf) cancelAnimationFrame(s.raf);
    s.off?.();
  }

  // Safety net: tear down listeners/RAF if the component unmounts mid-drag.
  useEffect(() => stop, []);

  return { start, stop };
}
