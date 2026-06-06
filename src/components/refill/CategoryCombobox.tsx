/**
 * CategoryCombobox — type-to-create + pick-existing service category (v1.67.0).
 *
 * Categories are free text per tenant. This is a native <input> + <datalist>:
 * the dropdown suggests the built-ins plus any categories the tenant already
 * uses, and typing a new name creates it on the fly. The field DISPLAYS labels
 * (built-ins show "Tox", custom shows verbatim) and emits the stored value on
 * blur via normalizeCategory — so typing "tox" folds onto the canonical slug.
 *
 * Shared by both the Catalog and Booking surfaces so they stay mirrored.
 */

import { useEffect, useId, useState } from "react";
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
  const [text, setText] = useState(() => categoryLabel(value));

  // Re-sync the visible label if the bound value changes from outside (e.g.
  // a drag-to-recategorize, a Save reload, or a category rename).
  useEffect(() => {
    setText(categoryLabel(value));
  }, [value]);

  function commit() {
    const norm = normalizeCategory(text);
    if (norm && norm !== value) onChange(norm);
    // Snap the field to the canonical label (or revert if they blanked it).
    setText(categoryLabel(norm || value));
  }

  return (
    <>
      <input
        type="text"
        list={listId}
        value={text}
        placeholder={placeholder ?? "Category"}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className={className}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.value} value={o.label} />
        ))}
      </datalist>
    </>
  );
}
