# Content Security Policy for egregoretcg.xyz (client-api-02 / server-20)

The SPA is served by Vercel (`vercel.json`), not the gateway. Before this change
`vercel.json` had no `headers` block, so the CSP that `src/api/session.ts` and
`.env.production` claim protects the token store was never delivered. Tokens sat
in sessionStorage with no script-injection constraint. This document records the
real header set now shipped in `vercel.json` (`headers` for `/(.*)`), and why
each origin is allowed. Every origin below was grepped out of `src/` on
2026-11-01.

## Full policy

```
default-src 'self';
base-uri 'self';
object-src 'none';
frame-ancestors 'none';
form-action 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;
font-src 'self';
media-src 'self' blob: mediastream:;
worker-src 'self' blob:;
frame-src 'self' https://auth.privy.io https://*.privy.io;
connect-src 'self'
  https://api.ocva.online wss://api.ocva.online
  https://auth.privy.io https://*.privy.io wss://*.privy.io
  https://rpc.mainnet.chain.robinhood.com
  https://robinhoodchain.blockscout.com
  https://solana-rpc.publicnode.com
  https://solana.drpc.org
  https://solana-mainnet.public.blastapi.io
  https://api.mainnet-beta.solana.com
  https://mainnet.helius-rpc.com
  https://0.peerjs.com wss://0.peerjs.com
  stun: turn: turns:;
upgrade-insecure-requests
```

Plus:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: microphone=(self), camera=(), geolocation=(), payment=(), usb=()`
- `X-Frame-Options: DENY` (belt-and-braces with `frame-ancestors 'none'`)

## Origin inventory and justification

### script-src `'self' 'wasm-unsafe-eval'`
All application JS is bundled same-origin by Vite. Privy (`@privy-io/react-auth`)
and `<model-viewer>` (`@google/model-viewer`) are npm imports, not CDN `<script>`
tags, so `'self'` is enough for code. `'wasm-unsafe-eval'` is required because
model-viewer / three.js compile WebAssembly (DRACO / KTX2 transcoders); it allows
WASM compilation only, NOT arbitrary `eval`, so the anti-injection property the
storage design relies on is preserved. The model-viewer decoder paths are already
pinned to same-origin `/model-viewer/*` in `src/Boosters.tsx`, so no CDN is needed.

### style-src `'self' 'unsafe-inline'`
model-viewer and Privy inject `<style>` elements at runtime; React/emotion set
inline styles. `'unsafe-inline'` for styles (not scripts) is the pragmatic choice
to avoid breaking those. Style injection is not a token-theft vector.

### img-src `'self' data: blob: https:`
- `'self'` + bundled card art in `public/cards/**`.
- `data:` / `blob:` for generated/preview images and canvas exports.
- `https:` (any) because player **avatar URLs** are arbitrary user-supplied HTTPS
  images (`src/error-text.ts` enforces `https://` only; no fixed avatar host or
  IPFS gateway is configured in the client, so a host allow-list would break
  avatars). No IPFS/Arweave gateway literal exists in `src/` today; if one is
  added later, prefer narrowing this to that gateway.

### font-src `'self'`
Fonts are self-hosted and preloaded from `/fonts/*` in `index.html`. No Google
Fonts / gstatic.

### media-src `'self' blob: mediastream:`
- `'self'` for bundled audio (menu music, SFX in `public/`).
- `blob:` for generated audio.
- `mediastream:` for the WebRTC remote audio stream in `src/Voice.tsx`
  (`audio.srcObject = remoteStream`).

### connect-src
- `'self'` — the Vercel origin: the `/gw/*` API rewrite, and the `/api/chat` +
  `/api/presence` serverless functions.
- `https://api.ocva.online` + `wss://api.ocva.online` — the backend gateway. REST
  goes through the `/gw` rewrite (same-origin) but the boardgame.io socket.io
  connection uses the absolute `SOCKET_URL` fallback `https://api.ocva.online`
  (`src/api/config.ts`), which needs both the https polling handshake and the
  `wss` upgrade.
- `https://auth.privy.io https://*.privy.io wss://*.privy.io` — Privy social
  sign-in API, embedded-wallet relay and realtime. **Blocking these breaks
  login**, so they are explicit. (`src/privy/**`, `src/api/auth.ts`.)
- Solana RPC hosts — `solana-rpc.publicnode.com`, `solana.drpc.org`,
  `solana-mainnet.public.blastapi.io`, `api.mainnet-beta.solana.com`,
  `mainnet.helius-rpc.com` (booster-mint / wallet read paths, `src/booster-mint.ts`,
  `src/wallet.ts`).
- Robinhood Chain EVM — `rpc.mainnet.chain.robinhood.com` (RPC) and
  `robinhoodchain.blockscout.com` (explorer reads), `src/wallet.ts`, `src/pack-evm.ts`.
- `https://0.peerjs.com` + `wss://0.peerjs.com` — the public PeerJS broker for
  in-match proximity voice (`src/Voice.tsx`, default PeerJS cloud host).
- `stun: turn: turns:` — ICE servers for the voice WebRTC session
  (`stun.l.google.com:19302`, `global.stun.twilio.com:3478`,
  `openrelay.metered.ca:80/443`). Scheme-source form is used so the broker's
  STUN/TURN candidates are allowed regardless of port without enumerating each.

### frame-src `'self' https://auth.privy.io https://*.privy.io`
Privy renders its auth/MFA/embedded-wallet UI in an iframe from `auth.privy.io`.
Nothing else is framed.

### Not in the policy (navigations, not resource loads)
`twitter.com`, `github.com`, `solscan.io`, `dexscreener.com`, `masterstcg.com`,
`egregoretcg.xyz`, `reactbits.dev`, `play.workadventu.re` appear in `src/` only as
anchor `href`/`window.open` targets, which top-level navigation governs, not CSP
fetch directives, so they need no `connect-src`/`frame-src` entry.

## Follow-up (not in vercel.json)
The stale comments in `src/api/session.ts` (~line 366) and `.env.production`
(~lines 50-53) still say the CSP comes from "the gateway". Those files are owned by
the client/front-end agent; they should be corrected to point at this `vercel.json`
header block. (Noted for client-api-02; the header itself is now delivered.)
