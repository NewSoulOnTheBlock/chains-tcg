# Card ownership — the missing foundation for boosters and ranked

Status: **not built.** This file records exactly what has to exist before ranked
play or any prize can be run, so the work can be picked up directly.

## Why this blocks everything above it

Card ownership currently lives in the browser:

```
localStorage["ocva.collection.<name>"]  ->  {"node_sol":20, ...}
```

There is no `card_ownership` table anywhere in this backend (verified: no such
table in `db/migrations/`, no such query in any service). `redeem/digital`
generates card ids and writes a redemption row, but never records *who owns
what*, so ownership cannot be queried, let alone enforced.

Consequences today, all confirmed against the live API:

- A ranked match created with a **starter deck** is accepted — the server does
  no ownership check at all; `mode` is stored as a label and nothing else.
- Any player can open devtools, grant themselves the entire catalogue, and
  enter ranked with cards they never obtained.
- `mintingEnabled: false`, so nobody can legitimately obtain booster cards
  anyway. Opening ranked today would mean *only* the devtools path qualifies.

Enforcing this in the client is not a mitigation — the client runs on the
player's machine. With a prize attached, the payoff for editing one
localStorage value exceeds the cost of playing honestly, which makes this the
highest-value attack surface in the product.

## The work, in dependency order

### 1. Ownership table — `db/migrations/0010_card_ownership.sql`

```sql
create table core.card_ownership (
  profile_id  bigint      not null references core.profiles(id) on delete cascade,
  card_id     text        not null,
  qty         int         not null check (qty >= 0),
  updated_at  timestamptz not null default now(),
  primary key (profile_id, card_id)
);
create index card_ownership_profile_idx on core.card_ownership (profile_id);
```

This becomes the single source of truth. The client's localStorage copy stays,
but only as a display cache — never as an input to a decision.

### 2. Write ownership when a booster is redeemed

`services/wager/src/services/boosterService.ts` — `redeemTicket()` (line ~375)
already generates `cardIds` inside a transaction. Add, **in that same
transaction**, one upsert per card:

```sql
insert into core.card_ownership (profile_id, card_id, qty)
values ($1, $2, 1)
on conflict (profile_id, card_id)
  do update set qty = core.card_ownership.qty + 1, updated_at = now();
```

Same transaction is not optional: a split would hand out cards whose ownership
was never recorded, and the failure would be silent.

### 3. Fill the card pool

`BOOSTER_CARD_POOL` is empty in `.env.example` and in the deployed `.env`, which
is why digital redemption answers 503 rather than inventing card ids. Populate it
with the non-Node card ids from `src/cards.ts`. The code path already exists —
this is configuration, not development.

### 4. Enforce ownership on ranked seating

`services/game/src/lib/seating.ts` — `assertSeatableDeck()` (line 18) currently
validates format only. Give it the match mode and, for ranked, verify every
non-Node card in the deck against `core.card_ownership` for that profile:

```ts
if (mode === 'ranked') {
  // basic Nodes are granted to everyone and are exempt
  // missing cards -> AppError.badRequest(..., { reason: 'unowned_cards', issues })
}
```

The client is already shaped for this: it branches on `err.reason` and renders
`err.issues` individually, so a new reason surfaces correctly with no client
change. Enforce it at seating rather than at `activate()` — a player may
legitimately keep a casual deck active that would not qualify for ranked.

### 5. Turn minting on

`services/wager/src/bootstrap.ts` wires `UnavailableTicketMinter`. Until a real
minter replaces it, steps 1–4 are inert: nobody can obtain a card through the
intended path, so ranked would remain empty of legitimate entrants.

### 6. Ladder (separate work)

Ranked also needs a rating store, seasons, a queue and pairer, placements and a
standings read model before any weekly award can be computed. `src/ranked-client.ts`
documents the endpoints the client expects. None of it exists server-side.

## Until then

Keep ranked and wager gated in the client, as they are now. The gate is honest
signposting, not a security control — the security control is step 4, and it
does not exist yet.

Wager has a second, independent blocker: `escrows.deposit_address` is an
externally-owned account, not a contract (`eth_getCode` returns `0x`). Stakes
would sit in a hot wallet whose key is an environment variable, and no payout
has ever executed against a real chain.
