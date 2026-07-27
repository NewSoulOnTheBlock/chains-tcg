// Rules page — ported from the legacy interactive Rulebook (old-frontend
// App.tsx RulesPage), restyled to the new app: dark hub scene, Cinzel
// headings, scrollable sections with a sticky section-jump chip bar.

import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CARDS, COLOR_META, type Color } from "@chains/game-core";
import { Button } from "@/components/ui/button";
import { SceneBackground } from "@/components/SceneBackground";
import { GameCard, CostPips } from "@/components/game/GameCard";
import { SectionNav, type RulesSection } from "./SectionNav";

export const metadata: Metadata = {
  title: "Rules — Chains TCG",
  description: "How to play Chains TCG: setup, card types, gas, turns, and combat.",
};

const SECTIONS: RulesSection[] = [
  { id: "goal", label: "The Goal" },
  { id: "setup", label: "Setup & Mulligan" },
  { id: "cards", label: "Card Types" },
  { id: "gas", label: "Gas & Costs" },
  { id: "turn", label: "Turn Structure" },
  { id: "combat", label: "Combat" },
  { id: "advanced", label: "Advanced" },
  { id: "cheatsheet", label: "Cheatsheet" },
];

/** Five-chain flavor table (chain → color → playstyle), per the project README
 *  and the game-core card catalogue. */
const CHAIN_FLAVOR: { color: Color; colorName: string; playstyle: string }[] = [
  { color: "bnb", colorName: "Gold", playstyle: "Fast, cheap, aggressive Memes" },
  { color: "sol", colorName: "Purple", playstyle: "Burst damage, card draw, fast turns" },
  { color: "eth", colorName: "Silver", playstyle: "Control, removal, big finishers" },
  { color: "robinhood", colorName: "Green", playstyle: "Lifegain midrange, sturdy bodies" },
  { color: "base", colorName: "Blue", playstyle: "Card-advantage aggro, cheap swarm" },
];

/** One real example card per type, straight from the game-core catalogue. */
const CARD_TYPE_EXAMPLES: { type: string; cardId: string; blurb: string }[] = [
  {
    type: "Node",
    cardId: "node_sol",
    blurb:
      "Your “land”. Free to play, but only one per turn. Tap it to add 1 Gas of its chain’s color to your pool. Nodes are how every other card gets paid for.",
  },
  {
    type: "Meme",
    cardId: "eth_pepe",
    blurb:
      "Your fighters. Each Meme has Power / Toughness. Memes attack your opponent and block incoming attacks — but they enter the field summoning sick and can’t attack the turn they arrive.",
  },
  {
    type: "Machine",
    cardId: "bnb_sniper",
    blurb:
      "Permanents with a passive, always-on effect — nothing to activate. This one gives your Memes haste. Machines keep working until something destroys them.",
  },
  {
    type: "Aura",
    cardId: "bnb_liquidity",
    blurb:
      "A spell that attaches to a single Meme, buffing its stats or granting a keyword (haste, lifelink…). If the enchanted Meme dies or is bounced back to hand, the Aura goes to the graveyard with it.",
  },
  {
    type: "Move",
    cardId: "sol_zap",
    blurb:
      "A one-shot spell. Pay its cost, it resolves immediately (this one deals 3 damage to any target), then it goes to the graveyard.",
  },
];

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-32 pt-8">
      <h2 className="font-heading text-lg font-bold uppercase tracking-[0.2em] text-amber-300/90">
        {title}
      </h2>
      <div className="mt-3 space-y-3 rounded-xl border border-border bg-card/80 p-4 text-sm leading-relaxed text-foreground/90 backdrop-blur-sm sm:p-5">
        {children}
      </div>
    </section>
  );
}

function LifeOrb({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: "green" | "red";
}) {
  const ring =
    tone === "green"
      ? "border-emerald-400/70 shadow-[0_0_24px_rgba(52,211,153,0.35)] bg-emerald-500/15"
      : "border-red-400/70 shadow-[0_0_24px_rgba(248,113,113,0.35)] bg-red-500/15";
  return (
    <div className="text-center">
      <div
        className={`mx-auto flex h-20 w-20 items-center justify-center rounded-full border-2 font-heading text-3xl font-black ${ring}`}
      >
        {value}
      </div>
      <div className="mt-1.5 text-[11px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function Steps({ items }: { items: { title: string; body: string }[] }) {
  return (
    <ol className="space-y-3">
      {items.map((s, i) => (
        <li key={s.title} className="flex gap-3">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-xs font-black text-amber-300 ring-1 ring-amber-400/40">
            {i + 1}
          </span>
          <div>
            <div className="font-heading font-bold tracking-wide">{s.title}</div>
            <p className="mt-0.5 text-foreground/80">{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function RulesPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-16">
      <SceneBackground src="/hub-bg.png" blur overlay="strong" />

      {/* Sticky top bar: back link + title + section chips */}
      <div className="sticky top-0 z-20 -mx-4 border-b border-border bg-background/85 backdrop-blur-md">
        <header className="flex items-center gap-3 px-4 py-3">
          <Button asChild variant="ghost" size="icon" aria-label="Back">
            <Link href="/">
              <ArrowLeft className="size-5" />
            </Link>
          </Button>
          <h1 className="font-heading text-xl font-bold tracking-wide">Rulebook</h1>
        </header>
        <SectionNav sections={SECTIONS} />
      </div>

      {/* Quick start */}
      <div className="mt-6 rounded-xl border border-amber-400/25 bg-gradient-to-br from-violet-500/15 to-amber-400/10 p-4 backdrop-blur-sm">
        <div className="text-center font-heading text-sm font-bold uppercase tracking-[0.25em] text-amber-300">
          Learn in 30 seconds
        </div>
        <ol className="mt-3 grid grid-cols-1 gap-1.5 text-sm sm:grid-cols-5 sm:gap-2 sm:text-center">
          {["Play Nodes", "Nodes make Gas", "Cast Memes", "Attack opponent", "Life 20 → 0"].map(
            (t, i) => (
              <li key={t} className="flex items-center gap-2 sm:flex-col sm:gap-1">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-400/20 text-xs font-black text-amber-300">
                  {i + 1}
                </span>
                <span className="font-semibold text-foreground/90">{t}</span>
              </li>
            )
          )}
        </ol>
        <p className="mt-3 text-center font-garamond text-sm italic text-muted-foreground">
          Last player standing wins.
        </p>
      </div>

      <Section id="goal" title="The Goal">
        <p>
          Reduce your opponent&apos;s life from <b>20 to 0</b>. Last player standing wins.
        </p>
        <div className="flex items-center justify-center gap-6 py-2">
          <LifeOrb value={20} label="Start" tone="green" />
          <span aria-hidden className="text-2xl font-black text-amber-300">
            &rarr;
          </span>
          <LifeOrb value={0} label="Win" tone="red" />
        </div>
        <p className="text-foreground/80">
          There is a second way to lose: <b>decking out</b>. If you ever have to draw from an
          empty deck, you lose on the spot &mdash; so a stalled game still ends.
        </p>
      </Section>

      <Section id="setup" title="Setup & Mulligan">
        <p>
          Each player picks one of the <b>five chains</b>, shuffles their <b>60-card deck</b>,
          draws <b>7 cards</b>, and starts at <b>20 life</b>.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-3 font-semibold">Chain</th>
                <th className="py-2 pr-3 font-semibold">Color</th>
                <th className="py-2 font-semibold">Playstyle</th>
              </tr>
            </thead>
            <tbody>
              {CHAIN_FLAVOR.map((c) => (
                <tr key={c.color} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-3">
                    <span className="flex items-center gap-2 font-semibold">
                      <span
                        aria-hidden
                        className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/50"
                        style={{ backgroundColor: COLOR_META[c.color].hex }}
                      />
                      {COLOR_META[c.color].name}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">{c.colorName}</td>
                  <td className="py-2 text-foreground/80">{c.playstyle}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="list-disc space-y-1.5 pl-5 text-foreground/80">
          <li>
            A starter deck is <b>12 Nodes + 4 copies</b> of each other card in your chain&apos;s
            color (you can build your own deck later).
          </li>
          <li>
            The player who goes first <b>skips their draw on turn 1</b> &mdash; a small tax for
            moving first.
          </li>
          <li>
            Maximum hand size is <b>7</b> &mdash; you discard down to 7 at the end of your turn.
          </li>
        </ul>
        <div className="rounded-lg border border-violet-400/25 bg-violet-500/10 p-3">
          <div className="font-heading text-xs font-bold uppercase tracking-[0.2em] text-violet-300">
            Mulligan
          </div>
          <p className="mt-1.5 text-foreground/85">
            Don&apos;t like your opening hand? Shuffle it back and redraw. The <b>first mulligan
            is free</b> &mdash; you draw 7 again. Every mulligan after that draws <b>one fewer
            card</b>, down to a floor of <b>4</b>. You have about <b>10 seconds</b> to keep or
            mulligan before your opponent can push the game forward.
          </p>
        </div>
      </Section>

      <Section id="cards" title="Card Types">
        <p>
          Five card types make up your deck. Here is a real example of each, straight from the
          card pool.
        </p>
        <div className="space-y-4">
          {CARD_TYPE_EXAMPLES.map((t) => {
            const def = CARDS[t.cardId];
            if (!def) return null;
            return (
              <div
                key={t.cardId}
                className="flex items-start gap-4 rounded-lg border border-border/60 bg-black/25 p-3"
              >
                <GameCard def={def} size="md" className="sm:w-28" />
                <div className="min-w-0">
                  <div className="font-heading text-base font-bold uppercase tracking-[0.15em] text-amber-300/90">
                    {t.type}
                  </div>
                  <div className="text-xs text-muted-foreground">{def.name}</div>
                  <p className="mt-1.5 text-foreground/85">{t.blurb}</p>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section id="gas" title="Gas & Costs">
        <p>
          <b>Nodes generate Gas. Cards cost Gas.</b> Tap an untapped Node and it adds 1 Gas of
          its chain&apos;s color to your pool.
        </p>
        <div className="rounded-lg border border-border/60 bg-black/25 p-3">
          <div className="flex items-center gap-2">
            <span className="text-foreground/85">Example cost:</span>
            <CostPips cost={{ sol: 2, any: 1 }} size="lg" />
          </div>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-foreground/80">
            <li>
              <b>Colored pips</b> must be paid with Gas of that exact chain &mdash; here, 2
              Solana Gas.
            </li>
            <li>
              The <b>numbered grey pip</b> is an &ldquo;any&rdquo; cost &mdash; pay it with Gas
              of any color, in any mix.
            </li>
          </ul>
        </div>
        <ul className="list-disc space-y-1.5 pl-5 text-foreground/80">
          <li>
            No card ever needs more than <b>3 Gas of its own color</b> &mdash; big cards demand a
            bigger board, not a stricter color.
          </li>
          <li>
            You may play <b>one Node per turn</b> (some Machines grant an extra Node drop).
          </li>
          <li>
            <b>Unspent Gas drains at the end of your turn</b> &mdash; spend it or lose it. There
            is no saving up between turns.
          </li>
        </ul>
      </Section>

      <Section id="turn" title="Turn Structure">
        <Steps
          items={[
            {
              title: "Untap",
              body: "Untap your Nodes, Memes, and Machines. Summoning sickness wears off, and your free Node drop for the turn resets.",
            },
            {
              title: "Draw",
              body: "Draw 1 card (the starting player skips this on the game’s very first turn). If your deck is empty, you lose.",
            },
            {
              title: "Main",
              body: "Play up to 1 Node, tap Nodes for Gas, and cast Memes, Machines, Auras, and Moves in any order. When you’re ready, declare attackers to enter combat — or just end the turn.",
            },
            {
              title: "Combat",
              body: "Your Memes attack, the opponent blocks, damage resolves — full details in the Combat section below.",
            },
            {
              title: "End",
              body: "Unspent Gas evaporates and you discard down to 7 cards. The turn passes to your opponent.",
            },
          ]}
        />
        <div className="rounded-lg border border-border/60 bg-black/25 p-3">
          <div className="font-heading text-xs font-bold uppercase tracking-[0.2em] text-amber-300/90">
            Example first turn
          </div>
          <p className="mt-1.5 text-foreground/85">
            Play a Solana Node (your free Node drop) &rarr; tap it for 1 Purple Gas &rarr; cast a
            cheap Meme like PNUT &mdash; it enters summoning sick, so it can&apos;t attack yet
            &rarr; end the turn. Your leftover Gas evaporates.
          </p>
        </div>
      </Section>

      <Section id="combat" title="Combat">
        <Steps
          items={[
            {
              title: "Declare attackers",
              body: "Select any of your untapped, non-sick Memes and confirm the attack. Attackers tap when the attack is confirmed.",
            },
            {
              title: "Declare blockers",
              body: "The defender assigns untapped Memes as blockers. Several blockers can gang up on one attacker. Anything left unblocked is going to hit the player.",
            },
            {
              title: "Damage — simultaneous",
              body: "A blocked attacker deals its Power across its blockers in order, and every blocker deals its Power back at the same time. Unblocked attackers deal their Power straight to the defending player’s life.",
            },
            {
              title: "Deaths",
              body: "Any Meme with damage equal to or greater than its Toughness is destroyed (its attached Auras go to the graveyard too). Damage on survivors clears at the end of the turn.",
            },
          ]}
        />
      </Section>

      <Section id="advanced" title="Advanced">
        <ul className="list-disc space-y-2 pl-5 text-foreground/85">
          <li>
            <b className="text-amber-300/90">Summoning sickness &amp; haste</b> &mdash; Memes
            can&apos;t attack the turn they enter play. Some Machines (Sniper Bot, AMM Router) and
            Auras (Validator Boost) remove sickness so your Memes can swing immediately.
          </li>
          <li>
            <b className="text-amber-300/90">Machines are passive</b> &mdash; there is nothing to
            activate. Their effect is always on: pumping your attackers, discounting your Moves,
            granting an extra Node drop, or drawing you cards when Memes arrive.
          </li>
          <li>
            <b className="text-amber-300/90">Auras fall off</b> &mdash; an Aura lives on the Meme
            it enchants. If that Meme dies or is bounced back to hand, the Aura is put into the
            graveyard.
          </li>
          <li>
            <b className="text-amber-300/90">Hand limit</b> &mdash; maximum 7 cards. Extras are
            discarded at the end of your turn.
          </li>
          <li>
            <b className="text-amber-300/90">Graveyard</b> &mdash; destroyed Memes, spent Moves,
            fallen Auras, and discards all pile up here, and some cards interact with it.
          </li>
          <li>
            <b className="text-amber-300/90">Turn timer / AFK</b> &mdash; each turn has a{" "}
            <b>90-second deadline</b>. Once it passes, either player can force-end the stalled
            turn (this also unsticks a disconnected opponent mid-combat). The mulligan decision
            has its own ~10-second window.
          </li>
          <li>
            <b className="text-amber-300/90">Deck-out</b> &mdash; forced to draw from an empty
            deck? You lose immediately.
          </li>
        </ul>
      </Section>

      <Section id="cheatsheet" title="Quick Cheatsheet">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[380px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-3 font-semibold">You want to&hellip;</th>
                <th className="py-2 font-semibold">Do this</th>
              </tr>
            </thead>
            <tbody className="text-foreground/85">
              {[
                ["Get Gas", "Tap an untapped Node"],
                ["Play a card", "Tap it in hand (Moves and Auras then ask for a target)"],
                ["Attack", "Tap your untapped Memes, then confirm the attack"],
                ["Block", "Tap your Meme, then tap the attacker it should block"],
                ["Pass", "Press End Turn"],
              ].map(([a, b]) => (
                <tr key={a} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-3 font-semibold">{a}</td>
                  <td className="py-2">{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[380px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-3 font-semibold">Number</th>
                <th className="py-2 font-semibold">Rule</th>
              </tr>
            </thead>
            <tbody className="text-foreground/85">
              {[
                ["20", "Starting life"],
                ["60", "Cards in a deck"],
                ["7", "Opening hand — and the end-of-turn hand limit"],
                ["1", "Free Node drop per turn"],
                ["4", "Mulligan floor (hands never shrink below this)"],
                ["90s", "Turn deadline before either player may force-end"],
              ].map(([a, b]) => (
                <tr key={a} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-3 font-black tabular-nums text-amber-300/90">{a}</td>
                  <td className="py-2">{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <p className="pt-8 text-center font-garamond text-sm italic text-muted-foreground">
        That&apos;s the whole game. Have fun.
      </p>
    </main>
  );
}
