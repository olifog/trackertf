# Methodology

The decisions behind the numbers, so you can judge them yourself.

## Where players come from

There is no Steam API that lists TF2 players, so the corpus is discovered two ways:

- **Steam store review authors**, a casual-skewed seed pool.
- **Friend-graph expansion** from active players with 1,666+ hours.

Friend-graph sampling over-represents socially connected and veteran players. A widely-cited 2022
dataset showed a 1% Golden Frying Pan rate on sniper for this reason. Every player's discovery
source is recorded, and sample sizes are shown on every page.

## What counts as equipped

Loadouts come from `GetPlayerItems`, which only exposes the currently active loadout preset per
class (A/B/C/D presets are invisible). Stock weapons never appear in backpack data, so an empty
weapon slot is counted as the stock item. Troll loadouts are counted as-is; swaps roughly cancel
out.

Engineer's destruction PDA and toolbox occupy different physical equip slots than the construction
PDA. They are remapped into one semantic "PDA" slot so slot filters mean one thing (4 = sapper,
5 = PDAs, 6 = watch).

## Reskin and strange merging

The Steam API treats renamed/strange stock weapons ("Upgradeable"), festives, botkillers,
australiums, and warpainted weapons as separate items. By default anything functionally identical
is merged: items sharing a weapon class and gameplay attributes after resolving items_game prefab
inheritance, ignoring a curated list of cosmetic-only attributes (kill counters, paintkits,
killstreak effects, viewmodel offsets, and so on). Two community-consensus reskins with
technically-real quirks are merged manually: **The Original** (centered projectile) and **The
Rainblower** (pyrovision). The unmerged view is one toggle away, and every merged row expands to
its variants.

The all-class melees (Frying Pan, Conscientious Objector, and so on) merge into each other
globally, and additionally fold into each class's stock melee on class-specific views: a Pan is a
Bat for a scout. They do not merge on the Any-class view, where transitively merging
Pan to Bat to Bottle would collapse all stock-stat melee into one row and erase the "how many
people pan" signal.

## How usage % is computed

For a specific class, usage = players equipping the item on that class / all players whose loadout
is visible.

For **Any class**, an equip is counted per class-slot opportunity: total equips / (players ×
classes that can use the item). For slot-filtered Any-class views, the denominator uses classes
that equip the item in that slot. The Panic Attack in the primary slot is an engineer-only
opportunity even though four classes own it. Merged groups use the union of their members' classes.

Every player contributes all 9 class loadouts, whether or not they play the class. This matches how
the game presents loadouts.

## Privacy and API reliability

Roughly half of encountered accounts hide their backpack or game stats. The inventory endpoint
signals a private backpack with a bare HTTP 503, but the TF2 Game Coordinator behind it also fails
transiently under load (community measurements show around 40% failure in busy periods). A 503 is
only classified as "private" after it persists across three spaced retries; transient errors are
retried without being recorded. Live rates are on the health page.

## What can't be measured

**Deaths do not exist** in Steam's TF2 stats. The schema defines a deaths field, but the game
client never uploads it, so no true K/D is possible. Kills/hour and points/minute are shown
instead. Per-map stats only include playtime, not points, so per-map performance isn't derivable.
Casual win/loss and MMR exist only in each player's private Game Coordinator data. Per-player stats
accumulate across all servers, not just official casual; there is no server-type filter in Steam's
player stats.

## Weapon performance stats

"Points per minute with this weapon" averages the lifetime per-class rates of players who currently
equip it (10+ hours on the class, 3+ players minimum). This is correlation, not causation. Lifetime
stats span every loadout a player ever used, so read it as "the kind of player who equips X", not
"X makes you better".
