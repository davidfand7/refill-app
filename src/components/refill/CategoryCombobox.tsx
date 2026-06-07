/**
 * CategoryCombobox — type-to-create + pick-existing service category (v1.68.2).
 *
 * Categories are free text per tenant. This is a REAL combobox: a text input
 * plus a popover that ALWAYS lists every built-in and tenant-custom category,
 * filtering as you type, with a "Create '<typed>'" row when the text doesn't
 * match an existing one.
 *
 * Why not <datalist>? Chrome filters native datalist suggestions by the text
 * already in the field — a new service defaults to "Other", so the dropdown
 * collapsed to just "Other" and hid every other option (v1.67.0 bug). A custom
 * popover shows the full list regardless of the pre-filled value.
 *
 * The value contract is unchanged: the field DISPLAYS labels (built-ins show
 * "Tox", custom shows verbatim) and emits the STORED value via normalizeCategory
 * — so typing "tox" folds onto the canonical slug. Shared by both the Catalog
 * and Booking surfaces so they stay mirrored.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Plus } from "lucide-react";
import { categoryLabel, normalizeCategory, type CategoryOption } from "@/lib/service-categories";

export function CategoryCombobox({
  value,
  onChange,
  options,
  className,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: CategoryOption[];
  className?: string;
  placeholder?: string;
}) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // What's shown in the input. Closed → the bound value's label; open → the
  // live query the user is typing.
  const [text, setText] = useState(() => categoryLabel(value));
  const [active, setActive] = useState(0);

  // Re-sync the visible label when the bound value changes from outside (drag to
  // recategorize, Save reload, a category rename) and we're not mid-edit.
  useEffect(() => {
    if (!open) setText(categoryLabel(value));
  }, [value, open]);

  // The query only filters once the user has typed something other than the
  // current label — so opening the field always reveals the full list.
  const query = text.trim();
  const isLabelOfValue = query.toLowerCase() === categoryLabel(value).trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!query || isLabelOfValue) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query, isLabelOfValue]);

  // Offer "Create" when the typed text is non-empty and doesn't fold onto an
  // existing option (by stored value).
  const norm = normalizeCategory(text);
  const canCreate =
    !!norm && !options.some((o) => o.value === norm) && !isLabelOfValue;
  const rowCount = filtered.length + (canCreate ? 1 : 0);

  // Keep the highlighted row in range as the list changes.
  useEffect(() => {
    setActive((a) => (rowCount === 0 ? 0 : Math.min(a, rowCount - 1)));
  }, [rowCount]);

  // Close (and commit free text) when clicking outside.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        commitFreeText();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  });

  function openMenu() {
    setText(categoryLabel(value));
    setActive(0);
    setOpen(true);
    // Select-all so the first keystroke replaces the pre-filled label.
    requestAnimationFrame(() => inputRef.current?.select());
  }

  function pick(v: string) {
    if (v && v !== value) onChange(v);
    setText(categoryLabel(v || value));
    setOpen(false);
  }

  function commitFreeText() {
    const n = normalizeCategory(text);
    if (n && n !== value) onChange(n);
    setText(categoryLabel(n || value));
  }

  function choose(index: number) {
    if (canCreate && index === filtered.length) {
      pick(norm);
    } else if (filtered[index]) {
      pick(filtered[index].value);
    } else {
      commitFreeText();
      setOpen(false);
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        autoComplete="off"
        value={text}
        placeholder={placeholder ?? "Category"}
        onFocus={openMenu}
        onClick={() => {
          if (!open) openMenu();
        }}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          if (!open) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) openMenu();
            else setActive((a) => Math.min(a + 1, Math.max(rowCount - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (open) choose(active);
            else openMenu();
          } else if (e.key === "Escape") {
            if (open) {
              e.preventDefault();
              setText(categoryLabel(value));
              setOpen(false);
            }
          } else if (e.key === "Tab") {
            commitFreeText();
            setOpen(false);
          }
        }}
        className={cn(className, "pr-7")}
      />
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-faint" />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 z-30 mt-1 w-max min-w-full max-w-[16rem] max-h-60 overflow-auto rounded-md border border-rule bg-white py-1 shadow-lg"
        >
          {filtered.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o.value);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex items-center justify-between gap-2 px-3 py-1.5 text-[13px] cursor-pointer",
                i === active ? "bg-emerald/10 text-ink" : "text-ink-soft",
              )}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value && <span className="text-emerald text-[11px]">✓</span>}
            </li>
          ))}
          {canCreate && (
            <li
              role="option"
              aria-selected={active === filtered.length}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(norm);
              }}
              onMouseEnter={() => setActive(filtered.length)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-[13px] cursor-pointer border-t border-rule/60",
                active === filtered.length ? "bg-emerald/10" : "",
              )}
            >
              <Plus className="h-3.5 w-3.5 text-emerald shrink-0" />
              <span className="text-ink">
                Create “<span className="font-medium">{categoryLabel(norm)}</span>”
              </span>
            </li>
          )}
          {!canCreate && (
            <li
              onMouseDown={(e) => {
                e.preventDefault();
                inputRef.current?.select();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-ink-faint border-t border-rule/60 cursor-text"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span>Type a name to create a new category</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
