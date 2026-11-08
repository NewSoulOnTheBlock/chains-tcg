"""Jev triage for code-review findings.

Reviewers (Claude subagents) produce candidate findings as JSON. This script
asks Jev (TypeSafe System One, typed judgments only) a fixed set of questions
about EACH finding, then CODE ranks them. Jev never decides what to do; it only
answers the questions in QUESTIONS. Every exchange is logged to judge/.

Usage: python triage.py findings/*.json  -> writes triaged.json + triaged.md
"""
import glob, json, os, sys, time, urllib.request, urllib.error
from pathlib import Path

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"
HERE = Path(__file__).parent
JUDGE_DIR = HERE / "judge"

# ---------------------------------------------------------------- questions
SEVERITY_LEVELS = [
    "Cosmetic or stylistic; no effect on behaviour, players or operators",
    "Developer friction only: harder to maintain, duplicated code, missing lint or docs",
    "Degrades a feature or performance for players, but a workaround exists",
    "Breaks a feature, corrupts saved data, desyncs a match, or lets a player cheat in a game",
    "Loss of funds, authentication bypass, remote code execution, or exposure of secrets",
]
EFFORT_LEVELS = [
    "Trivial: a one-line or config change",
    "Small: under an hour, one file",
    "Medium: a focused day, a few files, needs a test",
    "Large: multi-day refactor across modules",
]
QUESTIONS = {
    "evidence_supports_claim": {
        "type": "noul",
        "instructions": "Does the code quoted in `evidence` actually exhibit the problem that `title` and `description` claim? Judge only from the quoted code and the stated scenario.",
        "criteria": {
            "true": "The quoted code visibly does what the description says is wrong, and the failure scenario follows from it",
            "false": "The claim is speculation, the quote does not show the described behaviour, or the quote contradicts the claim",
        },
    },
    "is_generic_advice": {
        "type": "noul",
        "instructions": "Is this finding generic best-practice advice that could be pasted into any codebase, rather than something specific to the quoted code?",
    },
    "severity": {
        "type": "score",
        "instructions": "If the finding is real, how severe is its worst realistic consequence for this card game (players, operators, or money)?",
        "criteria": SEVERITY_LEVELS,
    },
    "effort": {
        "type": "score",
        "instructions": "How much work is the proposed `fix`, as described?",
        "criteria": EFFORT_LEVELS,
    },
    "category": {
        "type": "choice",
        "instructions": "Which single category best fits the problem described?",
        "criteria": {
            "money": "Wagers, escrow, token mints, payouts, fees: anything where value can be lost or stolen",
            "auth": "Identity, sessions, signatures, admin checks, authorization of requests",
            "game_integrity": "Rules bugs, hidden-information leaks, desync between client and server, cheating in matches",
            "data": "Database schema, queries, migrations, persistence correctness, SQL injection",
            "reliability": "Crashes, unhandled errors, leaks, races, retries, timeouts, resource exhaustion",
            "performance": "Slow rendering, bundle size, unnecessary work, memory growth",
            "ux": "Player-visible UI behaviour, layout, accessibility, confusing states",
            "maintainability": "Structure, duplication, dead code, god components, naming, types",
            "testing": "Missing or weak tests, test infrastructure",
            "tooling": "Build, lint, CI, deploy config, dependencies, repo hygiene",
        },
    },
    "fix_is_actionable": {
        "type": "noul",
        "instructions": "Is the proposed `fix` concrete enough that an engineer could start implementing it without further investigation?",
    },
    "player_visible": {
        "type": "noul",
        "instructions": "If the problem occurs, would an ordinary player of the game notice it (as opposed to only developers or operators)?",
    },
}

# ------------------------------------------------------------------- client
def load_key():
    k = os.environ.get("TYPESAFE_API_KEY")
    if k:
        return k
    for p in [Path.home() / "dev/jev-trading-floor/.env.live", Path.home() / "dev/jev-harness-engineering/.env.live"]:
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("TYPESAFE_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("TYPESAFE_API_KEY not found")

KEY = load_key()
USAGE = {"calls": 0, "input_tokens": 0, "output_tokens": 0}

def ask(state, questions, tag):
    body = json.dumps({"state": state, "model": MODEL, "questions": questions}, ensure_ascii=False).encode("utf-8")
    hdr = {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"}
    rec = {"at": time.time(), "request": {"state": state, "model": MODEL, "questions": questions}}
    resp = None
    for attempt in range(4):
        req = urllib.request.Request(ENDPOINT, data=body, method="POST", headers=hdr)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                resp = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "replace")
            if e.code in (429, 529) and attempt < 3:
                ra = e.headers.get("retry-after")
                time.sleep(float(ra) if ra and ra.replace(".", "", 1).isdigit() else 2 ** attempt)
                continue
            rec["error"] = "HTTP %d: %s" % (e.code, txt[:500])
            _log(rec, tag)
            raise RuntimeError(rec["error"])
    rec["response"] = resp
    _log(rec, tag)
    USAGE["calls"] += 1
    u = resp.get("usage") or {}
    USAGE["input_tokens"] += u.get("input_tokens", 0)
    USAGE["output_tokens"] += u.get("output_tokens", 0)
    return resp["answers"]

def _log(rec, tag):
    JUDGE_DIR.mkdir(exist_ok=True)
    (JUDGE_DIR / (tag + ".json")).write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")

# ------------------------------------------------------------------- policy
# Thresholds live here, next to the questions, so a reviewer sees both at once.
REAL_MIN = 0.55          # below this the finding is "unverified"; kept but demoted
GENERIC_MAX = 0.60       # above this, generic advice gets a flat penalty
TIER_A_SEV = 2.6         # fix now
TIER_B_SEV = 1.8         # schedule
LOW_CONF = 0.35          # Score/Choice confidence below this -> mark "needs human look"

def judge_finding(f):
    state = {
        "title": f["title"], "file": f["file"], "line": f.get("line"),
        "description": f["description"], "evidence": f.get("evidence", ""), "fix": f.get("fix", ""),
    }
    a = ask(state, QUESTIONS, f["id"])
    real = a["evidence_supports_claim"]["noul"]
    generic = a["is_generic_advice"]["noul"]
    sev = a["severity"]["score"]; sev_conf = a["severity"]["confidence"]
    eff = a["effort"]["score"]
    cat = a["category"]["choice"]; cat_conf = a["category"]["confidence"]
    # Composite priority: severity gated by plausibility, cheap fixes float up a little.
    priority = sev * (0.4 + 0.6 * real) - (0.8 if generic > GENERIC_MAX else 0) + 0.15 * (3 - eff)
    if real < REAL_MIN:
        tier = "unverified"
    elif sev >= TIER_A_SEV:
        tier = "A"
    elif sev >= TIER_B_SEV:
        tier = "B"
    else:
        tier = "C"
    return {
        **f,
        "jev": {
            "real": round(real, 3), "generic": round(generic, 3),
            "severity": round(sev, 2), "severity_conf": round(sev_conf, 2),
            "effort": round(eff, 2), "category": cat, "category_conf": round(cat_conf, 2),
            "actionable": round(a["fix_is_actionable"]["noul"], 3),
            "player_visible": round(a["player_visible"]["noul"], 3),
            "needs_human": sev_conf < LOW_CONF or cat_conf < LOW_CONF,
        },
        "priority": round(priority, 3), "tier": tier,
    }

def main(paths):
    findings = []
    for p in paths:
        for g in glob.glob(p):
            data = json.loads(Path(g).read_text(encoding="utf-8"))
            findings.extend(data)
    print("%d findings" % len(findings), file=sys.stderr)
    out = []
    for i, f in enumerate(findings, 1):
        try:
            out.append(judge_finding(f))
        except Exception as e:  # keep going; a service failure is not a finding failure
            out.append({**f, "jev": None, "priority": -1, "tier": "error", "error": str(e)})
        print("  [%d/%d] %s -> %s p=%s" % (i, len(findings), f["id"], out[-1]["tier"], out[-1]["priority"]), file=sys.stderr)
    out.sort(key=lambda x: -x["priority"])
    (HERE / "triaged.json").write_text(json.dumps({"usage": USAGE, "findings": out}, ensure_ascii=False, indent=2), encoding="utf-8")
    rows = ["| # | tier | prio | sev | real | cat | effort | id | file:line | title |",
            "|---|---|---|---|---|---|---|---|---|---|"]
    for n, x in enumerate(out, 1):
        j = x.get("jev") or {}
        rows.append("| %d | %s | %s | %s | %s | %s | %s | %s | `%s:%s` | %s |" % (
            n, x["tier"], x["priority"], j.get("severity", "-"), j.get("real", "-"), j.get("category", "-"),
            j.get("effort", "-"), x["id"], x["file"], x.get("line", ""), x["title"]))
    (HERE / "triaged.md").write_text("\n".join(rows) + "\n\nJev usage: %s\n" % json.dumps(USAGE), encoding="utf-8")
    print(json.dumps(USAGE), file=sys.stderr)

if __name__ == "__main__":
    main(sys.argv[1:] or [str(HERE / "findings" / "*.json")])
