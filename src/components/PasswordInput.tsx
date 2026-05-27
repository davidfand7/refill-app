/**
 * PasswordInput — drop-in replacement for `<input type="password">` that
 * adds an eye/eye-off toggle on the right edge.
 *
 * Same prop surface as a native `<input>`, so it slots into existing
 * forms (login, claim-your-business, settings/account) without touching
 * their styling. The component owns its visibility state; everything
 * else (value, onChange, disabled, className, autoFocus, …) is forwarded.
 *
 * Ported to refill-app 2026-05-27 (v1.21 — /claim-your-business port).
 * Original established 2026-05-12 (v310 — login UX polish).
 */

import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export const PasswordInput = forwardRef<HTMLInputElement, Props>(
  function PasswordInput({ className, ...rest }, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative">
        <input
          ref={ref}
          type={visible ? "text" : "password"}
          // pr-10 leaves room for the toggle button on the right edge so the
          // input text never overlaps the icon. The rest of className is the
          // caller's existing styling (border, focus ring, padding, etc.) and
          // wins on anything but right-padding.
          className={cn(className, "pr-10")}
          {...rest}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          title={visible ? "Hide password" : "Show password"}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded text-ink-soft hover:text-foreground hover:bg-sidebar-accent/40 transition-colors"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    );
  },
);
