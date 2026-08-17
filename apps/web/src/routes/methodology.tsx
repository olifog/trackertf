import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/methodology")({
  component: MethodologyPage,
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-heading text-lg font-semibold">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-muted-foreground [&_b]:text-foreground">
        {children}
      </div>
    </section>
  );
}

function MethodologyPage() {
  return (
    <div className="max-w-prose space-y-8">
      <div>
        <h1 className="font-heading text-2xl font-bold">Methodology</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every subtle decision behind the numbers, so you can judge them yourself.
        </p>
      </div>

      <Section title="Where players come from">
        <p>
          There is no Steam API that lists TF2 players, so the corpus is discovered two ways:{" "}
          <b>Steam store review authors</b> (a casual-skewed seed pool) and{" "}
          <b>friend-graph expansion</b> from active players with 1,666+ hours. Friend-graph sampling
          over-represents socially connected and veteran players — the 2022 style.tf data famously
          showed a 1% Golden Frying Pan rate on sniper for this reason. Every player's discovery
          source is recorded, and sample sizes are shown on every page.
        </p>
      </Section>

      <Section title="What counts as equipped">
        <p>
          Loadouts come from <code>GetPlayerItems</code>, which only exposes the{" "}
          <b>currently active loadout preset</b> per class (A/B/C/D presets are invisible). Stock
          weapons never appear in backpack data, so an empty weapon slot is counted as the stock
          item. Troll loadouts are counted as-is; we assume swaps roughly cancel out.
        </p>
        <p>
          Engineer's destruction PDA and toolbox occupy different physical equip slots than the
          construction PDA — we remap them all into one semantic "PDA" slot so slot filters mean one
          thing (4 = sapper, 5 = PDAs, 6 = watch).
        </p>
      </Section>

      <Section title="Reskin & strange merging">
        <p>
          The Steam API treats renamed/strange stock weapons ("Upgradeable"), festives, botkillers,
          australiums, and warpainted weapons as separate items. By default we merge anything{" "}
          <b>functionally identical</b>: items sharing a weapon class and gameplay attributes after
          resolving items_game prefab inheritance, ignoring a curated list of cosmetic-only
          attributes (kill counters, paintkits, killstreak effects, viewmodel offsets…). Two
          community-consensus reskins with technically-real quirks are merged manually:{" "}
          <b>The Original</b> (centered projectile) and <b>The Rainblower</b> (pyrovision). The
          unmerged view is one toggle away, and every merged row expands to its variants.
        </p>
        <p>
          The all-class melees (Frying Pan, Conscientious Objector, …) merge <b>into each other</b>{" "}
          globally, and additionally fold into each class's stock melee on class-specific views — a
          Pan is a Bat for a scout — but not on the Any-class view, where transitively merging
          Pan→Bat→Bottle→… would collapse all stock-stat melee into one row and erase the "how many
          people pan" signal.
        </p>
      </Section>

      <Section title="How usage % is computed">
        <p>
          For a specific class, usage = players equipping the item on that class ÷ all players whose
          loadout we can see. For <b>Any class</b>, an equip is counted per class-slot opportunity:
          total equips ÷ (players × classes that can use the item). For slot-filtered Any-class
          views, the denominator uses classes that equip the item <b>in that slot</b> — the Panic
          Attack in the primary slot is an engineer-only opportunity even though four classes own
          it. Merged groups use the union of their members' classes.
        </p>
        <p>
          Every player contributes all 9 class loadouts, whether or not they play the class — this
          matches how the game presents loadouts and how style.tf counted in 2022.
        </p>
      </Section>

      <Section title="Privacy & API reliability">
        <p>
          Roughly half of encountered accounts hide their backpack or game stats. The inventory
          endpoint signals a private backpack with a bare HTTP 503 — but the TF2 Game Coordinator
          behind it also fails transiently under load (community measurements show ~40% failure in
          busy periods), so we only classify 503 as "private" after it persists across three spaced
          retries, and transient errors are retried without being recorded. Live rates are on the{" "}
          <a href="/health" className="underline">
            health page
          </a>
          .
        </p>
      </Section>

      <Section title="What we can't measure">
        <p>
          <b>Deaths do not exist</b> in Steam's TF2 stats — the schema defines a deaths field, but
          the game client never uploads it — so no true K/D is possible; we show kills/hour and
          points/minute instead. Per-map stats only include <b>playtime</b>, not points, so per-map
          performance isn't derivable. Casual win/loss and MMR exist only in each player's private
          Game Coordinator data. Per-player stats accumulate across <b>all servers</b>, not just
          official casual — there is no server-type filter in Steam's player stats.
        </p>
      </Section>

      <Section title="Weapon performance stats">
        <p>
          "Points per minute with this weapon" averages the lifetime per-class rates of players who
          currently equip it (10+ hours on the class, 3+ players minimum). This is{" "}
          <b>correlation, not causation</b> — lifetime stats span every loadout a player ever used,
          so read it as "the kind of player who equips X", not "X makes you better".
        </p>
      </Section>
    </div>
  );
}
