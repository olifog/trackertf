import type * as React from "react";

/**
 * Shared filter-bar primitives, extracted from the (previously copy-pasted)
 * copies in the usage/combos/performance/leaderboards/servers/matches routes.
 * Only the two route-independent pieces live here — `Segment`/`StopSlider`/
 * `SwitchFilter` stay local to each route because they bind to that route's
 * typed `Route.useNavigate()` / search-param shape.
 */

/**
 * A horizontal group of `Segment` pills. `overflow-x-auto` (scrollbar hidden)
 * lets wide groups — the 10-pill class picker, the leaderboards board picker —
 * scroll within their card on narrow screens instead of dragging the whole page
 * into a horizontal scroll.
 */
export function Segmented({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex max-w-full divide-x divide-border overflow-x-auto rounded-md border [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {children}
    </div>
  );
}

/**
 * A labelled control row. Stacks the label above its controls on mobile; on
 * `sm+` the label becomes a fixed-width right-aligned gutter beside them.
 */
export function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-3">
      <span className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase sm:w-16 sm:shrink-0 sm:text-right">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">{children}</div>
    </div>
  );
}

/**
 * Small client-side text-filter input for long lists (per-map tables etc.).
 * Same visual language as the route filter cards' search inputs; purely local
 * state — it never touches the URL.
 */
export function ListFilterInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`h-8 w-56 rounded-md border bg-secondary/40 px-2 font-mono text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring ${className ?? ""}`}
    />
  );
}
