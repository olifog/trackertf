# Mobile-responsiveness remediation plan

Read-only audit of `apps/web` at **375px** and **390px** (iPhone SE / 12–15).
No code was changed. Severities: **P0** breaks layout (whole-page horizontal
scroll / unreadable), **P1** usable but bad, **P2** polish.

## Approach

Mobile-first, Tailwind responsive prefixes (`sm`=640, `md`=768, `lg`=1024).
The app is dark-only and already uses responsive grids well
(`grid-cols-2 sm:grid-cols-4`, `sm:grid-cols-2 lg:grid-cols-3`, inventory
`auto-fill minmax`) — **grids are not the problem**. Data tables already
self-contain their overflow (`ui/table.tsx` wraps every table in
`overflow-x-auto` with `whitespace-nowrap` cells), so tables cause a *nested*
scroll, never a page-wide one.

The page-wide horizontal scroll at 375px comes from exactly two families of
elements that are **non-wrapping and wider than the viewport**:

1. The header nav (`__root.tsx`) — one flex row of logo + 7 links + search +
   github + auth, `gap-5`, no wrap/scroll.
2. The `Segmented` pill groups — an `inline-flex` with `divide-x` (no wrap) that
   is atomic. The **class picker** (10 pills: Any + 9 classes ≈ 360px) and the
   **leaderboards Board picker** (5–8 text pills) blow past 375px and drag the
   page with them.

Highest-leverage move: the filter-bar building blocks (`Segmented`, `Segment`,
`FilterRow`, `StopSlider`) are **copy-pasted verbatim** into six routes
(`usage`, `combos`, `performance`, `leaderboards`, `matches`, `servers`).
Extracting them to a shared `components/ui/filter-bar.tsx` fixes every filter bar
in one place. Do that first; the per-page findings below then mostly evaporate.

## Findings (most severe first)

| Sev | Location | Problem | Fix |
|-----|----------|---------|-----|
| **P0** | `__root.tsx:89-115` | Nav is a single `flex items-center gap-5` row (logo + 7 `NavLink`s + palette + github + auth). At 375px it's ~2× viewport wide, no wrap/scroll ⇒ page-wide horizontal scroll. | See "Nav shell" below. Minimum: split into a top bar (logo + search + auth) and a horizontally-scrollable link strip; ideally a `md:hidden` Sheet drawer. |
| **P0** | `usage.tsx:399-419`, `combos.tsx:293-313`, `performance.tsx:301-321`, `leaderboards.tsx:216-250` | Class picker (`Segmented` of 10 pills) and leaderboards Board picker are `inline-flex` `divide-x` — **cannot wrap**, ~360px+ ⇒ overflow the card and the page. | Wrap the pill group in a scroll strip: `Segmented` → add `max-w-full overflow-x-auto` and keep `flex-nowrap`. Add `[-ms-overflow-style:none] [scrollbar-width:none]` + `[&::-webkit-scrollbar]:hidden` for a clean edge. Fix once in the shared `Segmented`. |
| **P1** | `player.$steamid.tsx:110-170` | Class-stats table has **9 columns** (Class, Hours, Share, Kills, Kills/hr, Pts/min, Dmg/min, Assists, Caps). Scrolls far; Class column of the nested scroll region is tiny. | Hide low-priority cols on mobile: add `hidden md:table-cell` to Share, Assists, Caps (both `TableHead` and `TableCell`). Consider `hidden sm:table-cell` on Dmg/min too. |
| **P1** | `usage.tsx:503-514` (`table-fixed`), `combos.tsx:386-407`, `performance.tsx:350-357` | `table-fixed` + many fixed `w-*` numeric columns ⇒ the flexible **Item/Combo** column is squeezed to ~40px on a 375px scroll viewport, name barely legible. | Drop `table-fixed` on mobile (`className="md:table-fixed"`) so the name column keeps natural width, or give the name column a `min-w-[9rem]`. For usage, hide the **Classes** (`:509`) and **Slot** (`:510`) columns under `sm` with `hidden sm:table-cell`. |
| **P1** | `performance.tsx:249-257` | Header is `flex items-baseline justify-between gap-4`: tall H1 on the left, a `max-w-md text-right` explanatory paragraph jammed beside it. Squeezes badly < 640px. | `flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between`; drop `text-right` on mobile (`sm:text-right`). |
| **P1** | shared `FilterRow` (`usage.tsx:198`, +5 more) | `flex items-center gap-3` with a fixed `w-16`/`w-20` right-aligned label eats ~76px of a 375px row before content; combined with `w-64`/`w-72` `StopSlider` it's tight and the slider can clip < 360px. | In shared `FilterRow`: `flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-3`; make the label `sm:w-16 sm:text-right` (full-width label line on mobile). Make `StopSlider` width responsive: `w-full max-w-72` instead of fixed `w-64`/`w-72`. |
| **P2** | `__root.tsx:117` | `main` uses `px-6` (24px) each side on mobile — wastes width the tables need. | `px-4 sm:px-6`. Also `header` `px-6` → `px-4 sm:px-6`. |
| **P2** | Interactive pills everywhere (`Segment` `h-8`, NavLinks text-only, `:74` Sign out) | Touch targets 32px / text-only, under the ~44px guideline. | `Segment` → `h-9 sm:h-8`. Give nav links/sign-out more padding on mobile. |
| **P2** | `servers.tsx:342-372` RushHour `XAxis interval={1}` | Forces every-other of 24 hourly ticks regardless of width ⇒ overlapping labels on mobile (~295px). | Use `minTickGap={24}` and drop the hard `interval`, or `interval="preserveStartEnd"`; let recharts thin ticks by width. |
| **P2** | `usage.tsx:388`, `combos.tsx:272`, `servers.tsx:391`, `health.tsx:71` | `flex items-baseline justify-between` H1 + right-side meta (`n = … · updated …`). Crowds at 375px. | `flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1`. |
| **P2** | Vertical bar charts: `servers.tsx:284` (`YAxis width={140}`), `matches.tsx:349` (`120`), `health.tsx:112` (`68`) | On a ~295px card the 140px label gutter leaves ~150px for bars — cramped. | Reduce to `width={96}` (and `tick={{fontSize:10}}`) at mobile, or accept — lowest priority. |
| **P2** | `command-palette.tsx:108` `CommandDialog` | shadcn `CommandDialog` is centered `max-w-lg`; verify it isn't clipped / that the trigger button (`ml-auto`, `:103`) survives the nav rework. | Confirm dialog is `w-[calc(100%-2rem)] max-w-lg` on mobile; re-place the trigger during the nav fix. |
| **P2** (defensive) | `styles.css` `body` | No `overflow-x` guard, so any stray overflow scrolls the whole page. | Optionally add `overflow-x-hidden` to `body` **after** fixing P0s (as a safety net, not a substitute — it can clip legitimately-wide content). |

## Nav shell recommendation (`__root.tsx`)

Concrete approach — **hamburger Sheet on mobile, current row on `md+`** (best
UX, ~40 lines), or the quick win below if time-boxed.

Structure:
```
header: px-4 sm:px-6
  nav: mx-auto flex max-w-7xl items-center gap-4
    [logo]                              (always)
    <div class="hidden md:flex items-center gap-5">   ← the 7 NavLinks
    <CommandPalette /> (ml-auto)        (always; keep as icon-only < sm)
    [github]                            (hidden sm:inline)
    <AuthNav />                         (always; avatar only on mobile)
    <button class="md:hidden">☰</button> → opens a shadcn <Sheet side="left">
                                            containing the 7 NavLinks stacked
```
The Sheet reuses `NavLink`; each link `onClick` closes the sheet (mirror the
`CommandPalette` close pattern). Auth avatar + search stay in the bar so the
common actions need no drawer.

**Quick win (if not doing the Sheet):** keep one row but make the links scroll —
`nav` stays flex; wrap only the 7 links in
`<div class="flex min-w-0 flex-1 gap-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">`,
keep logo before it and search/github/auth after it (remove `ml-auto`, use the
`flex-1` scroll strip to push them right). Links scroll under the fixed logo and
actions; no page-wide scroll.

## Shared-primitive vs per-page

**Fix once (shared):**
- `__root.tsx` — nav (P0) and `px-4 sm:px-6` (P2). One file.
- **Extract `components/ui/filter-bar.tsx`** from the six duplicated copies:
  - `Segmented` → add `max-w-full overflow-x-auto` + hidden-scrollbar ⇒ fixes
    the class/Board P0 on all pages at once.
  - `FilterRow` → stack label on mobile (P1).
  - `StopSlider` → `w-full max-w-72` (P1).
  - `Segment` → `h-9 sm:h-8` (P2 touch target).
  Then replace the local copies in `usage/combos/performance/leaderboards/matches/servers`
  with imports. (Note: `combos.tsx`/`performance.tsx` are being reworked
  concurrently — land the extraction *after* that work merges to avoid a
  conflict, and have those pages import the shared version.)
- `ui/table.tsx` — already handles overflow; optionally `px-1.5 sm:px-2` on
  `TableHead`/`TableCell` to buy a little width. Low priority.

**Per-page (can't be shared):** column-hiding decisions —
`player` class-stats 9-col (P1), `usage` Classes/Slot (P1), `leaderboards`
Percentile, `servers` Official columns — plus `performance` header stacking (P1)
and `servers` RushHour ticks (P2). Each is a targeted `hidden sm:table-cell` /
flex-direction edit in that route.
