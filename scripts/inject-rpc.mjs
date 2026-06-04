// Inject VITE_SOLANA_RPC into the build env when the operator only set
// HELIUS_API_KEY. The public mainnet-beta RPC is gated (403) and unusable
// for client-side reads, so we MUST point the client at a private endpoint.
//
// Precedence:
//   1. If VITE_SOLANA_RPC is already set → keep it (operator override).
//   2. Else if HELIUS_API_KEY is set → derive `https://mainnet.helius-rpc.com/?api-key=…`.
//   3. Else → leave unset; the app will fall back to api.mainnet-beta and
//      log a loud warning. Wagers will likely 403 in this case.
//
// We write a tiny `.env.production.local` next to vite.config so the value
// is captured at build time. Vite only inlines `import.meta.env.VITE_*`
// vars known at build, not runtime, so this MUST run before `vite build`.

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, '.env.production.local');

let rpc = process.env.VITE_SOLANA_RPC || '';
if (!rpc && process.env.HELIUS_API_KEY) {
  rpc = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  console.log('[inject-rpc] derived VITE_SOLANA_RPC from HELIUS_API_KEY');
} else if (rpc) {
  console.log('[inject-rpc] using operator-provided VITE_SOLANA_RPC');
} else {
  console.warn('[inject-rpc] no VITE_SOLANA_RPC or HELIUS_API_KEY set — client will fall back to api.mainnet-beta (likely 403 for wager flows).');
}

// Preserve any existing entries the operator placed in this file (rare).
const lines = [];
if (existsSync(envFile)) {
  for (const ln of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    if (ln && !/^VITE_SOLANA_RPC=/.test(ln)) lines.push(ln);
  }
}
if (rpc) lines.push(`VITE_SOLANA_RPC=${rpc}`);
writeFileSync(envFile, lines.join('\n') + (lines.length ? '\n' : ''));
