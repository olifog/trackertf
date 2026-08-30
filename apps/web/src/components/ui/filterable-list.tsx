import * as React from "react";

import { ListFilterInput } from "#/components/ui/filter-bar";
import { NOT_ENOUGH_DATA } from "#/lib/copy";
import { cn } from "#/lib/utils";

/**
 * The "filterable scrollable list" pattern, extracted from the hand-wired
 * copies in the matches/servers routes: an optional client-side text filter
 * (`ListFilterInput` + "x of y <noun>" count), a height-capped scroll
 * container, and a unified empty state that distinguishes "no data" from
 * "nothing matches the filter".
 *
 * It is render-shape agnostic — the child function receives the filtered
 * items plus ready-made class strings, so the same wrapper serves `<Table>`
 * sections (pass `scrollClass` to the table's `containerClassName` and
 * `stickyHeaderClass` to its `<TableHeader>`) and card grids / chip lists
 * (spread `scrollClass` onto your own wrapper div). Filter state is purely
 * local; it never touches the URL.
 */

export interface FilterableListContext<T> {
  /** items surviving the current filter query (all items when no filter) */
  visible: T[];
  /** max-height + overflow-y scroll container classes (rounded border incl.) */
  scrollClass: string;
  /** classes making a `<TableHeader>` stick to the top of the scroll container */
  stickyHeaderClass: string;
  /**
   * Empty-state copy, or `null` when there are rows to show. Distinguishes
   * empty source data (`emptyMessage`) from an unmatched filter query — render
   * it in whatever shape fits (a colSpan table row, a `<p>`, …).
   */
  emptyText: string | null;
}

export function FilterableList<T>({
  items,
  filterBy,
  noun = "rows",
  placeholder,
  minFilterItems = 0,
  maxHeightClassName = "max-h-[28rem]",
  emptyMessage = NOT_ENOUGH_DATA,
  className,
  children,
}: {
  /** full (already sorted/ranked) list; filtering never reorders it */
  items: T[];
  /** what the text filter matches on; omit for a scroll-cap-only list */
  filterBy?: (item: T) => string | string[];
  /** plural noun for the "x of y <noun>" count and default empty text */
  noun?: string;
  /** filter input placeholder — defaults to `filter <noun>…` */
  placeholder?: string;
  /** hide the filter toolbar until the list is at least this long */
  minFilterItems?: number;
  /** literal Tailwind max-height class (must appear in source for JIT) */
  maxHeightClassName?: string;
  /** empty-state copy when `items` itself is empty */
  emptyMessage?: string;
  className?: string;
  children: (ctx: FilterableListContext<T>) => React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");
  const needle = query.trim().toLowerCase();

  const visible = React.useMemo(() => {
    if (!filterBy || !needle) return items;
    return items.filter((item) => {
      const hay = filterBy(item);
      return typeof hay === "string"
        ? hay.toLowerCase().includes(needle)
        : hay.some((h) => h.toLowerCase().includes(needle));
    });
  }, [items, filterBy, needle]);

  const emptyText =
    visible.length > 0
      ? null
      : items.length === 0
        ? emptyMessage
        : `No ${noun} match "${query.trim()}".`;

  const showToolbar = filterBy !== undefined && items.length > Math.max(0, minFilterItems);

  return (
    <div className={cn("space-y-3", className)}>
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <ListFilterInput
            value={query}
            onChange={setQuery}
            placeholder={placeholder ?? `filter ${noun}…`}
          />
          <span className="font-mono text-[11px] text-muted-foreground">
            {visible.length.toLocaleString()} of {items.length.toLocaleString()} {noun}
          </span>
        </div>
      )}
      {children({
        visible,
        scrollClass: cn(maxHeightClassName, "overflow-y-auto rounded-md border"),
        stickyHeaderClass: "sticky top-0 z-10 bg-background",
        emptyText,
      })}
    </div>
  );
}
