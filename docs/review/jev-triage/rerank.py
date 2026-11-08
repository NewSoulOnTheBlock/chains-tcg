"""Re-rank cached Jev judgments with a code-owned liveness policy.

Jev judged each finding in isolation. What it cannot know is which code paths
actually serve production. The reviewers established that (server agent probed
api.ocva.online/healthz -> new-backend gateway; contracts agent traced that the
EVM WagerEscrow and Anchor master_wager are deployed but unused, and CardPack
minting is switched off in the client). That is policy, so it lives here.
No Jev calls are made: judgments are cached, policy is free to change.
"""
import json
from pathlib import Path

HERE = Path(__file__).parent
SRC = json.loads((HERE / "triaged.json").read_text(encoding="utf-8"))

# path prefix -> (multiplier, label)
LIVENESS = [
    ("src/server-custodial.ts", 0.45, "legacy server, not live"),
    ("src/server-wager.ts",     0.35, "dead code"),
    ("src/server.ts",           0.45, "legacy server, not live"),
    ("src/db.ts",               0.45, "legacy server, not live"),
    ("src/ranked/db.ts",        0.45, "legacy server, not live"),
    ("src/wager-program.ts",    0.40, "unused client module"),
    ("src/boosters-api.ts",     0.40, "unused client module"),
    ("contracts/",              0.55, "deployed, unused by product"),
    ("solana/",                 0.55, "deployed, unused by product"),
    ("src/pack-evm.ts",         0.60, "minting gated off"),
    ("src/booster-mint.ts",     0.60, "minting gated off"),
    ("render.yaml",             0.70, "stale deploy target"),
]

def liveness(path):
    for prefix, mult, label in LIVENESS:
        if path.startswith(prefix):
            return mult, label
    return 1.0, "live"

TIER_A, TIER_B = 2.6, 1.8
out = []
for f in SRC["findings"]:
    j = f.get("jev")
    if not j:
        out.append({**f, "live_mult": None, "live_label": "error"}); continue
    mult, label = liveness(f["file"])
    eff_sev = j["severity"] * mult
    priority = eff_sev * (0.4 + 0.6 * j["real"]) - (0.8 if j["generic"] > 0.6 else 0) + 0.15 * (3 - j["effort"])
    if j["real"] < 0.55: tier = "unverified"
    elif eff_sev >= TIER_A: tier = "A"
    elif eff_sev >= TIER_B: tier = "B"
    else: tier = "C"
    out.append({**f, "eff_severity": round(eff_sev, 2), "priority": round(priority, 3), "tier": tier,
                "live_mult": mult, "live_label": label})
out.sort(key=lambda x: -x["priority"])
(HERE / "ranked.json").write_text(json.dumps({"usage": SRC["usage"], "findings": out}, ensure_ascii=False, indent=2), encoding="utf-8")

import collections
print("tiers", collections.Counter(x["tier"] for x in out))
for i, x in enumerate(out[:70], 1):
    j = x["jev"] or {}
    print("%3d %-10s p=%5s sev=%4s real=%4s eff=%4s %-15s %-14s %s:%s  %s  [%s]" % (
        i, x["tier"], x["priority"], x.get("eff_severity"), j.get("real"), j.get("effort"), j.get("category"),
        x["id"], x["file"], x.get("line"), x["title"], x["live_label"]))
