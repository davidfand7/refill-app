/**
 * ChipDrawer — slide-in panel on Liz chat with starter prompts + user-saved
 * custom chips. Two roles in one widget:
 *
 *   1. Testing rig — Grasshopper clicks chips to retest prompts as he iterates
 *      on the prompt + seed data (no more retyping).
 *   2. Empty-state onboarding — new reps see "what to ask" before they know
 *      the surface.
 *
 * Features:
 *   - Slide-in from a button in the chat header OR ⌘K / ⌃K.
 *   - Click any chip → calls `onPick(prompt)` which (in the parent) inserts
 *     the prompt into the input and focuses send.
 *   - "Save current draft as chip" → persists to localStorage.
 *   - **Favorites** — click the star on any chip to pin it. Favorites appear
 *     in their own "Favorites" section at the top of the drawer + keep their
 *     filled star in their original category.
 *   - **Drag-to-reorder** — drag any chip within its section to reorder.
 *     dnd-kit PointerSensor uses distance=8 activation so clicks still work.
 *   - Search filter applies across all sections.
 *   - Used chips this session dim to ~50% opacity.
 *
 * Per-device-only storage is fine for v1; DB sync is a v2 ship.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  X,
  Library,
  Trash2,
  Pin as PinIcon,
  Search,
  Sparkles,
  Star,
  GripVertical,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STARTER_CHIPS,
  CHIP_CATEGORY_LABELS,
  loadCustomChips,
  appendCustomChip,
  deleteCustomChip,
  loadFavorites,
  toggleFavorite,
  applyOrder,
  setSectionOrder,
  type StarterChip,
  type CustomChip,
  type ChipCategory,
} from "@/lib/liz-starter-chips";

type DisplayChip = {
  id: string;
  label: string;
  prompt: string;
  custom: boolean;
};

type Group = {
  key: string;
  title: string;
  chips: DisplayChip[];
};

function buildAllChipsMap(
  starters: StarterChip[],
  customs: CustomChip[],
): Map<string, DisplayChip> {
  const m = new Map<string, DisplayChip>();
  for (const s of starters) m.set(s.id, { id: s.id, label: s.label, prompt: s.prompt, custom: false });
  for (const c of customs) m.set(c.id, { id: c.id, label: c.label, prompt: c.prompt, custom: true });
  return m;
}

function buildGroups(
  starters: StarterChip[],
  customs: CustomChip[],
  favorites: Set<string>,
  filter: string,
): Group[] {
  const f = filter.trim().toLowerCase();
  const matches = (c: DisplayChip) =>
    !f || c.label.toLowerCase().includes(f) || c.prompt.toLowerCase().includes(f);
  const allChipsMap = buildAllChipsMap(starters, customs);

  const groups: Group[] = [];

  // Favorites pinned at the top, in stored order.
  if (favorites.size > 0) {
    const defaultFavIds = [
      ...starters.filter((s) => favorites.has(s.id)).map((s) => s.id),
      ...customs.filter((c) => favorites.has(c.id)).map((c) => c.id),
    ];
    const orderedFavIds = applyOrder("favorites", defaultFavIds);
    const favChips = orderedFavIds
      .map((id) => allChipsMap.get(id))
      .filter((c): c is DisplayChip => Boolean(c))
      .filter(matches);
    if (favChips.length > 0) {
      groups.push({ key: "favorites", title: "Favorites", chips: favChips });
    }
  }

  // Custom library second (above category sections).
  if (customs.length > 0) {
    const defaultCustomIds = customs.map((c) => c.id);
    const orderedCustomIds = applyOrder("custom", defaultCustomIds);
    const customChips = orderedCustomIds
      .map((id) => allChipsMap.get(id))
      .filter((c): c is DisplayChip => Boolean(c))
      .filter(matches);
    if (customChips.length > 0) {
      groups.push({ key: "custom", title: "My library", chips: customChips });
    }
  }

  // Canonical categories in fixed order.
  const cats = Object.keys(CHIP_CATEGORY_LABELS) as ChipCategory[];
  for (const cat of cats) {
    const defaultCatIds = starters.filter((c) => c.category === cat).map((c) => c.id);
    if (defaultCatIds.length === 0) continue;
    const orderedCatIds = applyOrder(cat, defaultCatIds);
    const chips = orderedCatIds
      .map((id) => allChipsMap.get(id))
      .filter((c): c is DisplayChip => Boolean(c))
      .filter(matches);
    if (chips.length > 0) {
      groups.push({ key: cat, title: CHIP_CATEGORY_LABELS[cat], chips });
    }
  }

  return groups;
}

export function ChipDrawer({
  open,
  onClose,
  currentDraft,
  onPick,
  usedIds,
}: {
  open: boolean;
  onClose: () => void;
  currentDraft: string;
  onPick: (prompt: string) => void;
  usedIds: Set<string>;
}) {
  const [customs, setCustoms] = useState<CustomChip[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  // Bump on save/reorder/favorite/delete to force buildGroups to re-read
  // localStorage (favorites + order maps live there).
  const [stateRev, setStateRev] = useState(0);

  // Re-load on open + listen for cross-tab storage events.
  useEffect(() => {
    if (open) {
      setCustoms(loadCustomChips());
      setFavorites(loadFavorites());
      setFilter("");
      setStateRev((r) => r + 1);
    }
  }, [open]);

  // ESC to close from inside the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const groups = useMemo(
    () => buildGroups(STARTER_CHIPS, customs, favorites, filter),
    // stateRev is intentionally in the deps so applyOrder re-reads when order changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customs, favorites, filter, stateRev],
  );

  const handleSaveDraft = useCallback(() => {
    const text = currentDraft.trim();
    if (!text) return;
    appendCustomChip(text);
    setCustoms(loadCustomChips());
    setStateRev((r) => r + 1);
  }, [currentDraft]);

  const handleDeleteCustom = useCallback((id: string) => {
    deleteCustomChip(id);
    setCustoms(loadCustomChips());
    // Drop from favorites if it was there (toggleFavorite returns the new
    // set after toggling; only call it if currently favorited so we remove).
    if (loadFavorites().has(id)) {
      toggleFavorite(id);
    }
    setFavorites(loadFavorites());
    setStateRev((r) => r + 1);
  }, []);

  const handleToggleFavorite = useCallback((id: string) => {
    const next = toggleFavorite(id);
    setFavorites(new Set(next));
    setStateRev((r) => r + 1);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragEnd = useCallback(
    (sectionKey: string, sectionChipIds: string[]) =>
      (e: DragEndEvent) => {
        const { active, over } = e;
        if (!over || active.id === over.id) return;
        const oldIndex = sectionChipIds.indexOf(active.id as string);
        const newIndex = sectionChipIds.indexOf(over.id as string);
        if (oldIndex < 0 || newIndex < 0) return;
        const next = arrayMove(sectionChipIds, oldIndex, newIndex);
        setSectionOrder(sectionKey, next);
        setStateRev((r) => r + 1);
      },
    [],
  );

  return (
    <>
      {/* Scrim */}
      <div
        className={cn(
          "fixed inset-0 z-30 bg-black/15 backdrop-blur-[1px] transition-opacity duration-200",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <aside
        className={cn(
          "fixed top-0 right-0 z-40 h-full w-full max-w-md bg-card border-l border-border shadow-xl flex flex-col transition-transform duration-250",
          open ? "translate-x-0" : "translate-x-full",
        )}
        aria-hidden={!open}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Library className="h-4 w-4 text-primary flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground truncate">
                Prompt library
              </div>
              <div className="text-[10px] uppercase tracking-wider text-ink-soft">
                Click to insert · drag to reorder · ⌘K to toggle
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-ink-soft hover:text-foreground hover:bg-sidebar-accent/50"
            aria-label="Close prompt library"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-border flex-shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-soft pointer-events-none" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search prompts…"
              className="w-full text-xs rounded-md border border-border bg-background pl-8 pr-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            />
          </div>
        </div>

        {/* Save-current-draft affordance */}
        {currentDraft.trim().length > 0 && (
          <div className="px-4 py-2 border-b border-border bg-primary/5 flex items-center gap-2 flex-shrink-0">
            <PinIcon className="h-3.5 w-3.5 text-primary flex-shrink-0" />
            <div className="flex-1 min-w-0 text-xs text-ink-soft truncate">
              Save “{currentDraft.trim().slice(0, 50)}{currentDraft.trim().length > 50 ? "…" : ""}” to my library?
            </div>
            <button
              type="button"
              onClick={handleSaveDraft}
              className="text-[10px] uppercase tracking-wider font-bold rounded-md bg-primary text-white px-2 py-1 hover:opacity-90 flex-shrink-0"
            >
              Save
            </button>
          </div>
        )}

        {/* Scrollable chip list */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {groups.length === 0 ? (
            <div className="text-center text-xs text-ink-soft py-8 px-4">
              <Sparkles className="h-6 w-6 mx-auto mb-2 opacity-50" />
              No prompts match “{filter}”.
            </div>
          ) : (
            groups.map((g) => {
              const chipIds = g.chips.map((c) => c.id);
              return (
                <section key={g.key} className="py-2">
                  <h3 className="text-[10px] uppercase tracking-wider font-bold text-ink-soft px-1 mb-1.5 flex items-center gap-1.5">
                    {g.key === "favorites" && <Star className="h-3 w-3 fill-amber-400 text-amber-400" />}
                    {g.title}
                    <span className="text-[9px] font-normal text-ink-soft/70 normal-case tracking-normal">({g.chips.length})</span>
                  </h3>
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd(g.key, chipIds)}
                  >
                    <SortableContext items={chipIds} strategy={horizontalListSortingStrategy}>
                      <div className="flex flex-wrap gap-1.5">
                        {g.chips.map((c) => (
                          <SortableChip
                            key={c.id}
                            chip={c}
                            isFavorite={favorites.has(c.id)}
                            isUsed={usedIds.has(c.id)}
                            onPick={onPick}
                            onToggleFavorite={handleToggleFavorite}
                            onDeleteCustom={handleDeleteCustom}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                </section>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-border bg-sidebar-accent/30 flex-shrink-0">
          <div className="text-[10px] text-ink-soft leading-tight">
            Click a chip to drop it in the input. Drag the grip to reorder within a section. Star a chip to pin it to Favorites. Type a new prompt → Save chip appears here.
          </div>
        </div>
      </aside>
    </>
  );
}

function SortableChip({
  chip,
  isFavorite,
  isUsed,
  onPick,
  onToggleFavorite,
  onDeleteCustom,
}: {
  chip: DisplayChip;
  isFavorite: boolean;
  isUsed: boolean;
  onPick: (prompt: string) => void;
  onToggleFavorite: (id: string) => void;
  onDeleteCustom: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: chip.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className="group/chip relative inline-flex items-stretch">
      {/* Grip handle — drag target. Activation distance=8 lets clicks pass through. */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Drag ${chip.label} to reorder`}
        className={cn(
          "flex items-center justify-center pl-1.5 pr-1 rounded-l-full border-l border-y border-border bg-card text-ink-soft hover:text-foreground hover:bg-primary/5 cursor-grab active:cursor-grabbing touch-none",
          isFavorite && "border-amber-400/40",
          chip.custom && !isFavorite && "border-primary/30",
        )}
      >
        <GripVertical className="h-3 w-3" />
      </button>

      {/* Main click target — the chip body */}
      <button
        type="button"
        onClick={() => onPick(chip.prompt)}
        title={chip.prompt}
        className={cn(
          "text-xs border-y border-border bg-card hover:bg-primary/5 px-2.5 py-1 text-left transition",
          isUsed && "opacity-50",
          isFavorite && "border-amber-400/40 bg-amber-400/5",
          chip.custom && !isFavorite && "border-primary/30 bg-primary/5",
        )}
      >
        {chip.label}
      </button>

      {/* Star toggle */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite(chip.id);
        }}
        aria-label={isFavorite ? `Unfavorite ${chip.label}` : `Favorite ${chip.label}`}
        aria-pressed={isFavorite}
        className={cn(
          "flex items-center justify-center pl-1 pr-1.5 rounded-r-full border-r border-y border-border bg-card transition",
          isFavorite
            ? "text-amber-500 border-amber-400/40 bg-amber-400/5"
            : "text-ink-soft/70 hover:text-amber-500 opacity-0 group-hover/chip:opacity-100 focus-visible:opacity-100",
          chip.custom && !isFavorite && "border-primary/30",
        )}
      >
        <Star className={cn("h-3 w-3", isFavorite && "fill-amber-400")} />
      </button>

      {/* Custom-chip delete (hover only) */}
      {chip.custom && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteCustom(chip.id);
          }}
          aria-label={`Delete custom chip ${chip.label}`}
          className="opacity-0 group-hover/chip:opacity-100 transition-opacity absolute -right-1.5 -top-1.5 p-0.5 rounded-full bg-rose-500 text-white hover:bg-rose-600"
        >
          <Trash2 className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}
