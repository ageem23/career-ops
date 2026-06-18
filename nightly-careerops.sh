#!/usr/bin/env bash
# Nightly career-ops automation — runs portal scan, imports new offers, and
# batch-evaluates them. Registered in Windows Task Scheduler:
#   - "career-ops-scan"         → 18:00 daily (--scan-only: portal scan, no eval)
#   - "career-ops-nightly"      → 22:00 daily (--no-scan --cap=30: import + eval)
#   - "career-ops-nightly-late" → 04:00 daily (--no-scan --cap=30: leftovers + eval)
# Each run logs to tmp/nightly-{date}[-late].log and writes a morning summary
# to tmp/nightly-latest-summary.txt.
#
# Steps:
#   1. node scan.mjs                          — zero-token portal scan (skipped with --no-scan; --scan-only stops after this step)
#   2. import pipeline.md Pendientes           — append new offers to batch-input.tsv
#   3. batch/batch-runner.sh --parallel 3      — evaluate; merge + reconcile + verify
#
# Caps at --cap=N offers per run (default 20); any overflow stays in
# data/pipeline.md Pendientes (picked up by the next run, or clear it manually
# with /career-ops pipeline).
#
# Manual run: bash nightly-careerops.sh            (full: scan + import + eval)
#             bash nightly-careerops.sh --no-scan  (leftovers only)
#             bash nightly-careerops.sh --scan-only (scan only, no eval)
#
# Non-interactive runs (Task Scheduler after wake-from-sleep) auto-sleep 60s
# before scan.mjs so the VPN can connect — otherwise some providers return
# ERR_CONNECTION_RESET. Override with --wait=SECS or --no-wait.
set -uo pipefail

# --- Parse flags ---
NO_SCAN=false
NO_PREFLIGHT=false
SCAN_ONLY=false
CAP=20          # max offers imported+evaluated per run; override with --cap=N
WAIT_SECS=""  # empty → auto-detect below; explicit value overrides
for arg in "$@"; do
  case "$arg" in
    --no-scan) NO_SCAN=true ;;
    --scan-only) SCAN_ONLY=true ;;
    --cap=*) CAP="${arg#--cap=}" ;;
    --no-wait) WAIT_SECS=0 ;;
    --wait=*) WAIT_SECS="${arg#--wait=}" ;;
    --no-preflight) NO_PREFLIGHT=true ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if ! [[ "$CAP" =~ ^[0-9]+$ ]]; then
  echo "Invalid --cap value: '$CAP' (must be a non-negative integer)" >&2
  exit 2
fi
if $SCAN_ONLY && $NO_SCAN; then
  echo "--scan-only and --no-scan are mutually exclusive" >&2
  exit 2
fi
export NIGHTLY_CAP="$CAP"

# Auto-detect: interactive (TTY) → no wait; non-interactive (scheduler) → 60s.
# Must run BEFORE the tee exec below, which makes stdout non-TTY.
if [[ -z "$WAIT_SECS" ]]; then
  if [[ -t 1 ]]; then WAIT_SECS=0; else WAIT_SECS=60; fi
fi

# Work from the repo root regardless of how Task Scheduler invokes us.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

# Guarantee node / claude / bc are on PATH even under a bare Task Scheduler shell.
export PATH="/c/Users/magee/scoop/shims:/c/Users/magee/.local/bin:/c/Program Files/nodejs:$PATH"

TS=$(date +%Y-%m-%d_%H%M%S)
DATE=$(date +%Y-%m-%d)
mkdir -p tmp
if $NO_SCAN; then
  LOG="tmp/nightly-$DATE-late.log"
else
  LOG="tmp/nightly-$DATE.log"
fi
SUMMARY="tmp/nightly-latest-summary.txt"
exec > >(tee -a "$LOG") 2>&1

echo "================================================"
echo "  Nightly career-ops run — $TS"
echo "================================================"

# --- Step 1: portal scan (zero-token) ---
if $NO_SCAN; then
  echo ""
  echo "--- Step 1/3: portal scan — SKIPPED (--no-scan, processing leftovers) ---"
else
  if [[ "$WAIT_SECS" -gt 0 ]]; then
    echo ""
    echo "Sleeping ${WAIT_SECS}s for VPN/network to come up before scan..."
    sleep "$WAIT_SECS"
  fi
  # Pre-flight network probe: confirm we can reach a few representative hosts
  # before the scan starts. Logs per-host transport success so the morning
  # diagnosis isn't "scan failed; was the network up?"
  if ! $NO_PREFLIGHT; then
    echo ""
    echo "Pre-flight network probe..."
    # GET (not HEAD): api.anthropic.com rejects HEAD with no body, so HEAD
    # gives a false negative. GET to a known endpoint returns a code (200/
    # 301/401) which means transport succeeded — that's what we want to know.
    PROBE_HOSTS=("https://api.anthropic.com/v1/models" "https://www.linkedin.com" "https://boards-api.greenhouse.io")
    attempt=1
    while :; do
      ok=true
      for h in "${PROBE_HOSTS[@]}"; do
        if curl --silent --connect-timeout 5 --max-time 8 -o /dev/null "$h"; then
          echo "  ok   $h"
        else
          echo "  fail $h"
          ok=false
        fi
      done
      $ok && break
      if [[ $attempt -ge 3 ]]; then
        echo "  WARN: pre-flight still failing after $attempt attempts — running scan anyway"
        break
      fi
      echo "  retry in 20s (attempt $attempt/3)..."
      sleep 20
      ((attempt++))
    done
  fi
  echo ""
  echo "--- Step 1/3: portal scan ---"
  node scan.mjs
fi

# --- Build scan-error banner for the morning summary ---
SCAN_BANNER=""
if ! $NO_SCAN; then
  ERR_COUNT=$(grep -E "^Errors \([0-9]+\):" "$LOG" | head -1 | sed -E 's/^Errors \(([0-9]+)\):.*$/\1/')
  TOTAL=$(grep -E "Companies scanned:" "$LOG" | head -1 | sed -E 's/.*Companies scanned:[[:space:]]+([0-9]+).*/\1/')
  if [[ -n "${ERR_COUNT:-}" && "${ERR_COUNT:-0}" -gt 0 ]]; then
    FIRST_FEW=$(awk '/^Errors \(/{flag=1; next} flag && /^  ✗ /{ sub(/^  ✗ /, ""); sub(/:.*$/, ""); if (n) printf ", "; printf "%s", $0; n++; if (n>=5) exit } END { print "" }' "$LOG")
    EXTRA=$((ERR_COUNT - 5))
    if [[ "$EXTRA" -gt 0 ]]; then
      SCAN_BANNER="⚠️  Scan errors: $ERR_COUNT/${TOTAL:-?} providers — $FIRST_FEW (+$EXTRA more)"
    else
      SCAN_BANNER="⚠️  Scan errors: $ERR_COUNT/${TOTAL:-?} providers — $FIRST_FEW"
    fi
  fi
fi
export SCAN_BANNER

# --- Scan-only mode: stop after the scan, leave offers in pipeline.md ---
# The evaluation jobs (--no-scan) import and score them later. We still write a
# morning summary so the scan result is visible even when no eval ran.
if $SCAN_ONLY; then
  PENDING=$(node -e '
    const fs = require("fs");
    let inPend = false, n = 0;
    for (const line of fs.readFileSync("data/pipeline.md", "utf8").split("\n")) {
      if (line.startsWith("## ")) { inPend = /pend/i.test(line); continue; }
      if (inPend && line.startsWith("- [ ]")) n++;
    }
    process.stdout.write(String(n));
  ')
  {
    echo "career-ops scan summary — $TS"
    [[ -n "$SCAN_BANNER" ]] && echo "$SCAN_BANNER"
    echo ""
    echo "$PENDING offer(s) pending in pipeline.md — evaluation jobs (22:00 / 04:00) will process up to ${CAP} each."
  } > "$SUMMARY"
  echo ""
  echo "--- scan-only: $PENDING offer(s) pending in pipeline.md, skipping import + eval ---"
  echo ""
  echo "=== Scan complete: $(date +%H:%M:%S) — summary: $SUMMARY ==="
  exit 0
fi

# --- Step 2: import new pipeline.md Pendientes into batch-input.tsv ---
echo ""
echo "--- Step 2/3: import new offers into batch-input.tsv ---"
FIRST_NEW_ID=$(node -e '
  const fs = require("fs");
  const pipe = fs.readFileSync("data/pipeline.md", "utf8");
  let inPend = false;
  const pending = [];
  for (const line of pipe.split("\n")) {
    if (line.startsWith("## ")) { inPend = /pend/i.test(line); continue; }
    if (inPend && line.startsWith("- [ ]")) {
      const body = line.replace(/^- \[ \]\s*/, "").trim();
      const parts = body.split("|").map(s => s.trim());
      if (parts[0]) pending.push([parts[0], parts.slice(1).join(" | ")]);
    }
  }
  let txt = fs.existsSync("batch/batch-input.tsv")
    ? fs.readFileSync("batch/batch-input.tsv", "utf8")
    : "id\turl\tsource\tnotes\n";
  let maxId = 0;
  const seen = new Set();
  for (const line of txt.split("\n")) {
    const c = line.split("\t");
    const id = parseInt(c[0], 10);
    if (Number.isFinite(id)) { if (id > maxId) maxId = id; seen.add(c[1]); }
  }
  if (!txt.endsWith("\n")) txt += "\n";
  const firstNew = maxId + 1;
  const src = "nightly-" + new Date().toISOString().slice(0, 10);
  const CAP = parseInt(process.env.NIGHTLY_CAP || "20", 10);  // max offers evaluated per run; overflow stays in pipeline.md
  let added = 0, out = "", deferred = 0;
  for (const [url, notes] of pending) {
    if (seen.has(url)) continue;
    if (added >= CAP) { deferred++; continue; }
    out += [++maxId, url, src, notes].join("\t") + "\n";
    added++;
  }
  if (added) fs.writeFileSync("batch/batch-input.tsv", txt + out);
  console.error("imported " + added + " new offer(s) of " + pending.length + " pending"
    + (deferred ? "; " + deferred + " deferred (cap " + CAP + ", left in pipeline.md)" : ""));
  process.stdout.write(added ? String(firstNew) : "none");
')

# Late run augments the evening summary; full run resets it.
SUMMARY_APPEND=""
if $NO_SCAN && [[ -s "$SUMMARY" ]]; then SUMMARY_APPEND=1; fi
export SUMMARY_APPEND

if [[ "$FIRST_NEW_ID" == "none" || -z "$FIRST_NEW_ID" ]]; then
  echo "No new offers to evaluate tonight."
  if [[ -n "$SUMMARY_APPEND" ]]; then
    {
      echo ""
      echo "--- late run — $TS ---"
      [[ -n "$SCAN_BANNER" ]] && echo "$SCAN_BANNER"
      echo "No new offers found."
    } >> "$SUMMARY"
  else
    {
      echo "career-ops nightly summary — $TS"
      [[ -n "$SCAN_BANNER" ]] && echo "$SCAN_BANNER"
      echo ""
      echo "No new offers found."
    } > "$SUMMARY"
  fi
  echo ""
  echo "=== Run complete: $(date +%H:%M:%S) — no evaluations ==="
  exit 0
fi
echo "  first new batch ID: $FIRST_NEW_ID"

# --- Step 3: batch-evaluate (merge + reconcile + verify run inside) ---
# No --start-from: the runner processes every batch-input row whose state is
# not yet "completed" (it skips completed rows, so this is idempotent). This
# lets it self-heal orphans — offers imported on a prior night whose state row
# was lost to a lock race and which a fixed start-from watermark would skip
# forever. FIRST_NEW_ID is still used below to scope the morning summary to the
# night's newly imported offers.
echo ""
echo "--- Step 3/3: batch evaluation ---"
bash batch/batch-runner.sh --parallel 3

# --- Write morning summary ---
node -e '
  const fs = require("fs");
  const firstNew = parseInt(process.argv[1], 10);
  const ts = process.argv[2];
  const inp = {};
  for (const line of fs.readFileSync("batch/batch-input.tsv", "utf8").split("\n")) {
    const c = line.split("\t");
    inp[c[0]] = c[3] || "";
  }
  const rows = [];
  for (const line of fs.readFileSync("batch/batch-state.tsv", "utf8").split("\n")) {
    const c = line.split("\t");
    const id = parseInt(c[0], 10);
    if (Number.isFinite(id) && id >= firstNew) {
      rows.push({ id, status: c[2], rpt: c[5] || "-", score: parseFloat(c[6]), note: inp[id] || "" });
    }
  }
  rows.sort((a, b) => (b.score || 0) - (a.score || 0));
  let s = "career-ops nightly summary — " + ts + "\n";
  if (process.env.SCAN_BANNER) s += process.env.SCAN_BANNER + "\n";
  s += "evaluated " + rows.length + " offer(s)\n\n";
  s += "score  report  offer\n";
  s += "-----  ------  -----------------------------------------------\n";
  for (const r of rows) {
    const sc = Number.isFinite(r.score) ? r.score.toFixed(1) : "  - ";
    const tag = r.status !== "completed" ? "  [" + r.status + "]" : "";
    s += sc.padStart(5) + "  " + String(r.rpt).padStart(6) + "  " + r.note + tag + "\n";
  }
  const apply = rows.filter(r => r.score >= 4.0);
  const fails = rows.filter(r => r.status !== "completed");
  s += "\n" + apply.length + " offer(s) scored >= 4.0 (apply threshold)\n";
  if (fails.length) s += fails.length + " offer(s) did not complete — review the log\n";
  let remaining = 0, inPend = false;
  for (const line of fs.readFileSync("data/pipeline.md", "utf8").split("\n")) {
    if (line.startsWith("## ")) { inPend = /pend/i.test(line); continue; }
    if (inPend && line.startsWith("- [ ]")) remaining++;
  }
  if (remaining) s += remaining + " offer(s) still in pipeline.md (over the " + (process.env.NIGHTLY_CAP || "20") + "/run cap) — run /career-ops pipeline to clear\n";
  const path = "tmp/nightly-latest-summary.txt";
  if (process.env.SUMMARY_APPEND) {
    const body = s.replace(/^career-ops nightly summary — [^\n]*\n/, "");
    fs.appendFileSync(path, "\n--- late run — " + ts + " ---\n" + body);
  } else {
    fs.writeFileSync(path, s);
  }
  console.log(s);
' "$FIRST_NEW_ID" "$TS"

echo ""
echo "=== Run complete: $(date +%H:%M:%S) — summary: $SUMMARY ==="
