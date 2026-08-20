import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  ChartBarIcon,
  GaugeIcon,
  GlobeIcon,
  LayersIcon,
  RadioIcon,
  ServerIcon,
  SwordsIcon,
  TrophyIcon,
  UserIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#/components/ui/command";
import { avatarUrl, itemDisplayName } from "#/lib/tf2";
import { lookupPlayer } from "#/server/player";
import { type GlobalSearchResponse, globalSearch } from "#/server/search";

const PAGES = [
  { label: "Usage", to: "/usage", icon: ChartBarIcon },
  { label: "Combos", to: "/combos", icon: LayersIcon },
  { label: "Performance", to: "/performance", icon: GaugeIcon },
  { label: "Leaderboards", to: "/leaderboards", icon: TrophyIcon },
  { label: "Servers", to: "/servers", icon: ServerIcon },
  { label: "Matches", to: "/matches", icon: RadioIcon },
  { label: "Data", to: "/health", icon: GlobeIcon },
] as const;

/** steamid64 or steamcommunity profile URL → resolvable via lookupPlayer */
function looksLikeProfile(q: string): boolean {
  return /^\d{17}$/.test(q) || /steamcommunity\.com\/(?:id|profiles)\//i.test(q);
}

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResponse | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // debounced server search; profile URLs go through lookupPlayer instead
  useEffect(() => {
    const q = query.trim();
    const id = ++requestId.current;
    if (!q || q.length > 100 || q.includes("/")) {
      setResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await globalSearch({ data: { query: q } });
        if (requestId.current === id) setResults(res);
      } catch {
        if (requestId.current === id) setResults(null);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  function close() {
    setOpen(false);
    setQuery("");
    setResults(null);
  }

  async function goToProfile() {
    const { steamid } = await lookupPlayer({ data: { query: query.trim() } });
    if (steamid) {
      close();
      await navigate({ to: "/player/$steamid", params: { steamid } });
    }
  }

  const q = query.trim();
  const pages = PAGES.filter((p) => !q || p.label.toLowerCase().includes(q.toLowerCase()));
  const isProfile = looksLikeProfile(q);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto flex h-7 items-center gap-1.5 rounded-md border bg-secondary/40 px-2 font-mono text-xs text-muted-foreground/60 transition-colors hover:border-ring hover:text-muted-foreground"
      >
        <kbd className="rounded bg-secondary px-1 text-[10px]">⌘K</kbd>
        Search
      </button>
      <CommandDialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        title="Search"
        description="Search items, players and pages"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="items, players, steamid / profile url…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            {isProfile && (
              <CommandGroup heading="Steam profile">
                <CommandItem value="go-to-player" onSelect={goToProfile}>
                  <ArrowRightIcon className="opacity-60" />
                  <span className="truncate">
                    Go to player <span className="font-mono text-xs">{q}</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            {results !== null && results.items.length > 0 && (
              <CommandGroup heading="Items">
                {results.items.map((item) => (
                  <CommandItem
                    key={item.defindex}
                    value={`item-${item.defindex}`}
                    onSelect={() => {
                      close();
                      void navigate({
                        to: "/item/$defindex",
                        params: { defindex: item.defindex },
                      });
                    }}
                  >
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt="" className="size-5" loading="lazy" />
                    ) : (
                      <SwordsIcon className="opacity-50" />
                    )}
                    <span className="truncate">{itemDisplayName(item)}</span>
                    <span className="font-mono text-[11px] text-muted-foreground/50">
                      #{item.defindex}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {results !== null && results.players.length > 0 && (
              <CommandGroup heading="Players">
                {results.players.map((p) => {
                  const avatar = avatarUrl(p.avatarHash);
                  return (
                    <CommandItem
                      key={p.steamid}
                      value={`player-${p.steamid}`}
                      onSelect={() => {
                        close();
                        void navigate({
                          to: "/player/$steamid",
                          params: { steamid: p.steamid },
                        });
                      }}
                    >
                      {avatar ? (
                        <img src={avatar} alt="" className="size-5 rounded-sm" loading="lazy" />
                      ) : (
                        <UserIcon className="opacity-50" />
                      )}
                      <span className="truncate">{p.personaname ?? p.steamid}</span>
                      <span className="font-mono text-[11px] text-muted-foreground/50">
                        {p.steamid}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {pages.length > 0 && (
              <CommandGroup heading="Pages">
                {pages.map((page) => (
                  <CommandItem
                    key={page.to}
                    value={`page-${page.label}`}
                    onSelect={() => {
                      close();
                      void navigate({ to: page.to });
                    }}
                  >
                    <page.icon className="opacity-60" />
                    {page.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
