#!/usr/bin/env bash
# Nightly career-ops automation — runs portal scan, imports new offers, and
# batch-evaluates them. Registered in Windows Task Scheduler ("career-ops-nightly")
# to fire daily at 21:00. Each run logs to tmp/nightly-{date}.log and writes a
# morning summary to tmp/nightly-latest-summary.txt.
#
# Steps:
#   1. node scan.mjs                          — zero-token portal scan
#   2. import pipeline.md Pendientes           — append new offers to batch-input.tsv
#   3. batch/batch-runner.sh --parallel 3      — evaluate; merge + reconcile + verify
#
# Caps at 30 offers per night; any overflow stays in data/pipeline.md Pendientes
# (picked up by the next run, or clear it manually with /career-ops pipeline).
#
# Manual run: bash nightly-careerops.sh
set -uo pipefail

# Work from the repo root regardless of how Task Scheduler invokes us.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

# Guarantee node / claude / bc are on PATH even under a bare Task Scheduler shell.
export PATH="/c/Users/magee/scoop/shims:/c/Users/magee/.local/bin:/c/Program Files/nodejs:$PATH"

TS=$(date +%Y-%m-%d_%H%M%S)
DATE=$(date +%Y-%m-%d)
mkdir -p tmp
LOG="tmp/nightly-$DATE.log"
SUMMARY="tmp/nightly-latest-summary.txt"
exec > >(tee -a "$LOG") 2>&1

echo "================================================"
echo "  Nightly career-ops run — $TS"
echo "================================================"

# --- Step 1: portal scan (zero-token) ---
echo ""
echo "--- Step 1/3: portal scan ---"
node scan.mjs

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
  const CAP = 30;  // max offers evaluated per night; overflow stays in pipeline.md
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

if [[ "$FIRST_NEW_ID" == "none" || -z "$FIRST_NEW_ID" ]]; then
  echo "No new offers to evaluate tonight."
  { echo "career-ops nightly summary — $TS"; echo ""; echo "No new offers found."; } > "$SUMMARY"
  echo ""
  echo "=== Run complete: $(date +%H:%M:%S) — no evaluations ==="
  exit 0
fi
echo "  first new batch ID: $FIRST_NEW_ID"

# --- Step 3: batch-evaluate (merge + reconcile + verify run inside) ---
echo ""
echo "--- Step 3/3: batch evaluation ---"
bash batch/batch-runner.sh --start-from "$FIRST_NEW_ID" --parallel 3

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
  if (remaining) s += remaining + " offer(s) still in pipeline.md (over the 30/night cap) — run /career-ops pipeline to clear\n";
  fs.writeFileSync("tmp/nightly-latest-summary.txt", s);
  console.log(s);
' "$FIRST_NEW_ID" "$TS"

echo ""
echo "=== Run complete: $(date +%H:%M:%S) — summary: $SUMMARY ==="
