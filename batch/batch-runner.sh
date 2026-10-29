#!/usr/bin/env bash
set -euo pipefail

# career-ops batch runner — standalone orchestrator for claude -p workers
# Reads batch-input.tsv, delegates each offer to a claude -p worker,
# tracks state in batch-state.tsv for resumability.
#
# NOTE: This script is Claude Code-specific. It uses claude -p with
# --dangerously-skip-permissions and --append-system-prompt-file flags
# that are not available in other CLIs. Multi-CLI support is out of scope
# for now — contributions welcome.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BATCH_DIR="$SCRIPT_DIR"
INPUT_FILE="$BATCH_DIR/batch-input.tsv"
STATE_FILE="$BATCH_DIR/batch-state.tsv"
PROMPT_FILE="$BATCH_DIR/batch-prompt.md"
PROFILE_FILE="$PROJECT_DIR/config/profile.yml"
LOGS_DIR="$BATCH_DIR/logs"
DISCARD_LOG="$LOGS_DIR/discard.log"
TRACKER_DIR="$BATCH_DIR/tracker-additions"
REPORTS_DIR="$PROJECT_DIR/reports"
APPLICATIONS_FILE="$PROJECT_DIR/data/applications.md"
LOCK_FILE="$BATCH_DIR/batch-runner.pid"
PAUSE_FILE="$BATCH_DIR/batch-runner.paused"
STATE_LOCK_DIR="$BATCH_DIR/.batch-state.lock"
STATE_LOCK_PID_FILE="$STATE_LOCK_DIR/pid"
STATE_LOCK_TIMEOUT_SECONDS=60
# Persisted high-water mark for report numbers. Reconciled once per run against
# the reports directory and batch-state.tsv; read/incremented per reservation so
# the hot path never touches the (OneDrive-backed, ~3,000 file) reports dir.
REPORT_COUNTER_FILE="$BATCH_DIR/.report-high-water"
# How many times process_offer retries reserving its state row before giving
# up. acquire_state_lock can lose the mkdir race or time out under a parallel
# burst; if the initial "processing" row never lands, the worker would run
# claude -p with no state row and silently orphan the offer (in batch-input,
# never in batch-state, never reconciled out of pipeline.md). On exhaustion we
# mark the offer failed instead of evaluating it, so it's retried next run.
RESERVE_STATE_MAX_ATTEMPTS=5
# How often (in seconds of wall time) the parallel-mode wait loop runs the
# orphan sweep to recover state rows where a worker finished but update_state
# silently failed (e.g. lock-acquire timeout). 0 disables the periodic sweep;
# the end-of-batch sweep still runs.
ORPHAN_SWEEP_INTERVAL_SECONDS=30
MAIN_PID="${BASHPID:-$$}"

# Defaults
PARALLEL=1
DRY_RUN=false
RETRY_FAILED=false
RESUME_PAUSED=false
START_FROM=0
MAX_RETRIES=2
# Wall-clock cap per worker, passed to `timeout`. A normal evaluation runs
# 3-5 minutes, so 30m is generous headroom for a slow one while still killing a
# genuine hang the same night instead of jamming the run until someone notices.
# Override with --worker-timeout or the WORKER_TIMEOUT env var; "0" disables.
WORKER_TIMEOUT="${WORKER_TIMEOUT:-30m}"
MIN_SCORE=0
SKIP_PDF=false
MODEL=""  # explicit override; otherwise resolved from config/profile.yml spend_tier
RESOLVED_MODEL=""
RESOLVED_SPEND_TIER=""
RATE_LIMIT_SLEEP=300
BATCH_PAUSED=false
STATUS_ONLY=false
WATCH_MODE=false
LIMIT=0

# Return success for non-negative integer or decimal strings.
is_decimal_number() {
  [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]
}

usage() {
  cat <<'USAGE'
career-ops batch runner — process job offers in batch via claude -p workers
Uses spend_tier from config/profile.yml unless --model overrides it.

Usage: batch-runner.sh [OPTIONS]

Options:
  --parallel N         Number of parallel workers (default: 1)
  --dry-run            Show what would be processed, don't execute
  --retry-failed       Only retry offers marked as "failed" in state
  --resume-paused      Resume offers paused by a Claude session/rate limit
  --start-from N       Start from offer ID N (skip earlier IDs)
  --limit N            Max number of offers to process in this run
  --max-retries N      Max retry attempts per offer (default: 2)
  --worker-timeout T   Wall-clock cap per worker, any `timeout` duration
                       (default: 30m; "0" disables). A worker that exceeds it
                       is killed and counted as a failed attempt, so one hung
                       worker cannot jam the whole run.
  --min-score N        Skip PDF/tracker for offers scoring below N (default: 0 = off)
  --skip-pdf           Skip PDF generation entirely (write ❌ in tracker PDF column)
  --rate-limit-sleep N Seconds to wait before retrying a rate-limited worker
                       (default: 300)
  --model NAME         Override the tier-resolved Claude model passed to
                       `claude -p --model` (otherwise uses config/profile.yml
                       spend_tier: economy/standard/premium; default standard)
  --status             Show batch progress and a per-job table, then exit
  --watch              Live-refresh progress until the run completes
  -h, --help           Show this help

Files:
  batch-input.tsv      Input offers (id, url, source, notes)
  batch-state.tsv      Processing state (auto-managed)
  batch-prompt.md      Prompt template for workers
  logs/                Per-offer logs
  tracker-additions/   Tracker lines for post-batch merge

Examples:
  # Dry run to see pending offers
  ./batch-runner.sh --dry-run

  # Process all pending
  ./batch-runner.sh

  # Retry only failed offers
  ./batch-runner.sh --retry-failed

  # Process 2 at a time starting from ID 10
  ./batch-runner.sh --parallel 2 --start-from 10
USAGE
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel) PARALLEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --retry-failed) RETRY_FAILED=true; shift ;;
    --resume-paused) RESUME_PAUSED=true; shift ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --max-retries) MAX_RETRIES="$2"; shift 2 ;;
    --worker-timeout)
      [[ $# -ge 2 ]] || { echo "ERROR: --worker-timeout requires an argument"; exit 1; }
      WORKER_TIMEOUT="$2"; shift 2
      ;;
    --min-score) MIN_SCORE="$2"; shift 2 ;;
    --skip-pdf) SKIP_PDF=true; shift ;;
    --rate-limit-sleep)
      [[ $# -ge 2 ]] || { echo "ERROR: --rate-limit-sleep requires an argument"; exit 1; }
      RATE_LIMIT_SLEEP="$2"
      shift 2
      ;;
    --model) MODEL="$2"; shift 2 ;;
    --status) STATUS_ONLY=true; shift ;;
    --watch) WATCH_MODE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if ! [[ "$RATE_LIMIT_SLEEP" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --rate-limit-sleep must be a non-negative integer (seconds)."
  exit 1
fi

if ! is_decimal_number "$MIN_SCORE"; then
  echo "ERROR: --min-score must be a non-negative number."
  exit 1
fi

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --limit must be a non-negative integer."
  exit 1
fi

# Lock file to prevent double execution
acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCK_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "ERROR: Another batch-runner is already running (PID $old_pid)"
      echo "If this is stale, remove $LOCK_FILE"
      exit 1
    else
      echo "WARN: Stale lock file found (PID $old_pid not running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo "$MAIN_PID" > "$LOCK_FILE"
}

release_lock() {
  if [[ "${BASHPID:-$$}" != "$MAIN_PID" ]]; then
    return
  fi
  rm -f "$LOCK_FILE"
}

trap release_lock EXIT

# Validate prerequisites
check_prerequisites() {
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "ERROR: $INPUT_FILE not found. Add offers first."
    exit 1
  fi

  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "ERROR: $PROMPT_FILE not found."
    exit 1
  fi

  if ! command -v claude &>/dev/null; then
    echo "ERROR: 'claude' CLI not found in PATH."
    exit 1
  fi

  mkdir -p "$LOGS_DIR" "$TRACKER_DIR" "$REPORTS_DIR"
}

# Status/watch mode only needs prior batch state, not worker prerequisites.
check_status_prerequisites() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found at $STATE_FILE"
    exit 0
  fi
}

# Initialize state file if it doesn't exist
init_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' > "$STATE_FILE"
  fi
}

acquire_state_lock() {
  if [[ "${STATE_LOCK_DISABLED:-0}" -eq 1 ]]; then
    return 0
  fi

  local waited=0
  local max_waits=$((STATE_LOCK_TIMEOUT_SECONDS * 10))

  while true; do
    if mkdir "$STATE_LOCK_DIR" 2>/dev/null; then
      if printf '%s\n' "${BASHPID:-$$}" > "$STATE_LOCK_PID_FILE"; then
        STATE_LOCK_OWNED=1
        return 0
      fi
      rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
      rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
      echo "ERROR: Failed to initialize state lock metadata at $STATE_LOCK_DIR"
      return 1
    fi

    if [[ ! -d "$STATE_LOCK_DIR" ]]; then
      if (( PARALLEL <= 1 )); then
        echo "WARN: State lock creation failed. Falling back to lock-free operation (single-worker mode)." >&2
        STATE_LOCK_DISABLED=1
        STATE_LOCK_OWNED=0
        return 0
      fi
      echo "ERROR: Failed to create state lock directory $STATE_LOCK_DIR"
      return 1
    fi

    if [[ -f "$STATE_LOCK_PID_FILE" ]]; then
      local lock_pid
      lock_pid=$(cat "$STATE_LOCK_PID_FILE" 2>/dev/null || true)
      if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$STATE_LOCK_PID_FILE"
        if rmdir "$STATE_LOCK_DIR" 2>/dev/null; then
          echo "WARN: Recovered stale state lock (PID $lock_pid not running)."
          continue
        fi
      fi
    fi

    if (( waited >= max_waits )); then
      echo "ERROR: Timed out waiting for state lock at $STATE_LOCK_DIR"
      echo "If no batch-runner worker is active, remove the stale lock directory."
      return 1
    fi

    sleep 0.1
    ((waited += 1))
  done
}

release_state_lock() {
  if [[ "${STATE_LOCK_OWNED:-0}" -ne 1 ]]; then
    return
  fi
  rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
  rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
  STATE_LOCK_OWNED=0
}

run_with_state_lock() {
  acquire_state_lock || return $?

  local status=0
  if "$@"; then
    status=0
  else
    status=$?
  fi

  release_state_lock
  return "$status"
}

# Get status of an offer from state file
get_status() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "none"
    return
  fi
  local status
  status=$(awk -F'\t' -v id="$id" '$1 == id { print $3 }' "$STATE_FILE")
  echo "${status:-none}"
}

# Get retry count for an offer
get_retries() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "0"
    return
  fi
  local retries
  retries=$(awk -F'\t' -v id="$id" '$1 == id { print $9 }' "$STATE_FILE")
  echo "${retries:-0}"
}

# Read spend_tier from config/profile.yml. Defaults to "standard" if the key
# is absent or invalid.
read_spend_tier() {
  local raw=""

  if [[ -f "$PROFILE_FILE" ]]; then
    raw=$(
      awk -F: '
        /^[[:space:]]*spend_tier[[:space:]]*:/ {
          value = substr($0, index($0, ":") + 1)
          print value
          exit
        }
      ' "$PROFILE_FILE"
    )
    raw="${raw%%#*}"
    raw="${raw//$'\r'/}"
    raw="${raw#"${raw%%[![:space:]]*}"}"
    raw="${raw%"${raw##*[![:space:]]}"}"
    case "$raw" in
      \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
      \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
    esac
    raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  fi

  case "$raw" in
    economy|standard|premium)
      printf '%s\n' "$raw"
      ;;
    "")
      printf '%s\n' "standard"
      ;;
    *)
      echo "WARN: Invalid spend_tier \"$raw\" in ${PROFILE_FILE#"$PROJECT_DIR/"}; falling back to standard." >&2
      printf '%s\n' "standard"
      ;;
  esac
}

# Tier -> model mapping. Keep in sync with the table in modes/_shared.md.
spend_tier_to_model() {
  case "$1" in
    economy) echo "claude-haiku-4-5" ;;
    premium) echo "claude-opus-4-8" ;;
    standard|*) echo "claude-sonnet-5-5" ;;
  esac
}

# Resolve the model to pass to `claude -p --model`. --model always wins.
resolve_worker_model() {
  if [[ -n "$MODEL" ]]; then
    RESOLVED_MODEL="$MODEL"
    RESOLVED_SPEND_TIER="override"
    return 0
  fi

  RESOLVED_SPEND_TIER="$(read_spend_tier)"
  RESOLVED_MODEL="$(spend_tier_to_model "$RESOLVED_SPEND_TIER")"
}

# Append a one-line, auditable record of a pre-screen-gate discard to
# batch/logs/discard.log (see modes/batch.md — Pre-screen gate). Format:
# {ISO8601 timestamp}\t{job id}\t{url}\t{reason}
log_discard() {
  local id="$1" url="$2" reason="$3"
  mkdir -p "$LOGS_DIR"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\t%s\t%s\t%s\n' "$ts" "$id" "$url" "$reason" >> "$DISCARD_LOG"
}

# Calculate next report number.
# Caller must hold STATE_LOCK_DIR while this runs.
# Highest report number present on disk.
#
# Deliberately NOT called while holding the state lock. This scan is O(reports)
# and the directory has ~3,000 files; the state-file check in
# next_report_num_unlocked is what actually needs serializing.
#
# The `${f##*/}` expansion replaces a `basename` subprocess that used to run
# once per file. On Windows/MSYS a process spawn costs milliseconds, so at 2,959
# reports that loop measured 167 SECONDS against a 60-second lock timeout: the
# first worker held the lock for nearly three minutes while workers 2 and 3
# timed out and orphaned their rows. Pure expansion measures 0.2s, an ~800x
# reduction, and it is the root cause behind every orphaned "processing" row and
# both duplicate evaluations this week.
scan_reports_max() {
  local max_num=0 num
  if [[ -d "$REPORTS_DIR" ]]; then
    for f in "$REPORTS_DIR"/*.md; do
      [[ -f "$f" ]] || continue
      num="${f##*/}"        # strip directory, no subprocess
      num="${num%%-*}"      # leading numeric segment
      # `case` rather than a `=~` regex: bash regex costs ~4x more per
      # iteration, which is material across ~3,000 files. This also absorbs the
      # unmatched-glob case, where $f is the literal "*.md".
      case "$num" in ''|*[!0-9]*) continue ;; esac
      num=$((10#$num))      # tolerate leading zeros
      (( num > max_num )) && max_num=$num
    done
  fi
  printf '%s\n' "$max_num"
}

# Next free report number. Takes the on-disk maximum as an argument so the
# expensive directory scan happens outside the lock; only the state-file read
# below needs to be serialized against concurrent reservations.
#
# Computing the disk max before acquiring is safe: reports only appear on disk
# after a worker has already reserved its number, so the disk max can only lag,
# never over-allocate. The state-file pass inside the lock is the authority on
# numbers reserved by in-flight workers.
# Highest report number recorded in batch-state.tsv.
state_reports_max() {
  local max_num=0 n
  if [[ -f "$STATE_FILE" ]]; then
    while IFS=$'\t' read -r _ _ _ _ _ rnum _ _ _; do
      [[ "$rnum" == "report_num" || "$rnum" == "-" || -z "$rnum" ]] && continue
      case "$rnum" in ''|*[!0-9]*) continue ;; esac
      n=$((10#$rnum))
      (( n > max_num )) && max_num=$n
    done < "$STATE_FILE"
  fi
  printf '%s\n' "$max_num"
}

# Rebuild the persisted high-water mark from the authoritative sources.
#
# Called ONCE per run, from main(), never from the per-offer path. This is the
# only place the reports directory is scanned.
#
# Why the counter exists: reports/ lives inside a OneDrive-synced tree with
# ~3,000 files, and a full directory read there measured anywhere from 3 to 47
# SECONDS across runs. Doing that per reservation is what produced the
# 60-second lock timeouts, and even after removing the per-file subprocess the
# reservation path still measured 5-24s on 2026-08-17. Reading a single integer
# from a file is constant-time and independent of report count, which is the
# property that matters as the corpus keeps growing.
reconcile_report_high_water() {
  local fs_max state_max stored=0 best
  fs_max=$(scan_reports_max)
  state_max=$(state_reports_max)
  if [[ -f "$REPORT_COUNTER_FILE" ]]; then
    stored=$(< "$REPORT_COUNTER_FILE")
    case "$stored" in ''|*[!0-9]*) stored=0 ;; esac
  fi
  best="$fs_max"
  (( state_max > best )) && best="$state_max"
  (( stored > best )) && best="$stored"
  printf '%s\n' "$best" > "$REPORT_COUNTER_FILE"
  echo "Report high-water mark: $best (disk=$fs_max state=$state_max stored=$stored)"
}

# Allocate the next report number from the persisted counter.
#
# Constant-time: read an integer, increment, write it back. The caller holds the
# state lock, so the read-modify-write is atomic against sibling workers.
#
# The collision check is a safety net, not the primary mechanism. Other tools
# (reserve-report-num.mjs, hand-written reports) can create reports without
# touching the counter; a stale counter would otherwise overwrite one. A
# single-prefix glob costs ~0.4s against ~3-47s for a full scan, so the net is
# still an order of magnitude cheaper than what it replaces. Startup
# reconciliation catches anything this misses on the next run.
next_report_num_unlocked() {
  local cur=0 n attempts=0
  if [[ -f "$REPORT_COUNTER_FILE" ]]; then
    cur=$(< "$REPORT_COUNTER_FILE")
    case "$cur" in ''|*[!0-9]*) cur=0 ;; esac
  fi
  # A missing or zeroed counter means the startup reconcile never ran (e.g. a
  # direct call in a test). Rebuild rather than allocate from 1 and collide.
  if (( cur == 0 )); then
    cur=$(scan_reports_max)
    local sm; sm=$(state_reports_max)
    (( sm > cur )) && cur="$sm"
  fi
  n=$((cur + 1))
  while (( attempts < 50 )) && compgen -G "$REPORTS_DIR/${n}-*.md" >/dev/null 2>&1; do
    echo "    ⚠️  report number $n already exists on disk — counter was stale, skipping ahead." >&2
    n=$((n + 1))
    attempts=$((attempts + 1))
  done
  printf '%s\n' "$n" > "$REPORT_COUNTER_FILE"
  printf '%03d' "$n"
}

# Update or insert state for an offer.
# Caller must hold STATE_LOCK_DIR while this runs.
update_state_unlocked() {
  local id="$1" url="$2" status="$3" started="$4" completed="$5" report_num="$6" score="$7" error="$8" retries="$9"

  if [[ ! -f "$STATE_FILE" ]]; then
    init_state
  fi

  local tmp="$STATE_FILE.tmp"
  local row
  row=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' \
    "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries")

  # One awk pass, not a bash read loop. The loop appended each of ~3,200 rows
  # with its own `printf >>`, reopening the file per line: ~5s per call on
  # Windows, all of it inside the state lock, so reservations queued behind it
  # for 40-80s. Values go through ENVIRON, not -v, so backslashes in error
  # messages are written verbatim.
  STATE_ROW="$row" STATE_ID="$id" awk -F'\t' '
    NR == 1 { print; next }
    $1 == "id" { next }
    $1 == ENVIRON["STATE_ID"] { print ENVIRON["STATE_ROW"]; found = 1; next }
    { print }
    END { if (!found) print ENVIRON["STATE_ROW"] }
  ' "$STATE_FILE" > "$tmp" || { rm -f "$tmp"; return 1; }

  mv "$tmp" "$STATE_FILE"
}

update_state() {
  run_with_state_lock update_state_unlocked "$@"
}

# Atomic compare-and-set: only patch a row to "completed" if its current
# status is still "processing". Used by sweep_orphans to avoid racing
# worker updates that legitimately marked the row "skipped" / "failed" /
# "completed" between the sweep's snapshot of processing IDs and the
# patch step. Returns 0 if the row was patched, 1 if it was no longer
# processing (caller should skip silently).
# Caller must hold STATE_LOCK_DIR while this runs.
update_state_if_processing_unlocked() {
  local id="$1" url="$2" started="$3" completed="$4" report_num="$5" score="$6" retries="$7"
  if [[ ! -f "$STATE_FILE" ]]; then
    return 1
  fi
  local current
  current=$(awk -F'\t' -v id="$id" '$1==id {print $3; exit}' "$STATE_FILE")
  if [[ "$current" != "processing" ]]; then
    return 1
  fi
  update_state_unlocked "$id" "$url" "completed" "$started" "$completed" "$report_num" "$score" "-" "$retries"
}

update_state_if_processing() {
  run_with_state_lock update_state_if_processing_unlocked "$@"
}

is_rate_limit_log() {
  local log_file="$1"
  grep -Eiq '(rate limit|rate_limit|too many requests|429|quota exceeded|try again later|temporarily unavailable)' "$log_file"
}

is_session_limit_log() {
  local log_file="$1"
  grep -Eiq '(session limit|resets [0-9:]+[ap]m|usage limit|limit[[:space:]]+reached)' "$log_file"
}

mark_paused_rate_limit() {
  local id="$1" url="$2" started_at="$3" report_num="$4" retries="$5" log_file="$6"
  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local error_msg
  error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "session/rate limit reached")
  update_state "$id" "$url" "paused_rate_limit" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries"
  printf '%s\t%s\t%s\n' "$id" "$report_num" "$error_msg" > "$PAUSE_FILE"
  BATCH_PAUSED=true
}

reserve_report_num_unlocked() {
  local id="$1" url="$2" started="$3" retries="$4"

  local report_num=""
  if report_num=$(next_report_num_unlocked); then
    update_state_unlocked "$id" "$url" "processing" "$started" "-" "$report_num" "-" "-" "$retries"
  fi

  printf '%s\n' "$report_num"
}

# Threshold above which the reservation path is considered pathologically slow.
# The whole path should now run in well under a second; anything approaching the
# lock timeout means an O(n) operation has crept back into the critical section,
# which is exactly how the 167-second regression went unnoticed for a week.
RESERVE_SLOW_WARN_SECONDS="${RESERVE_SLOW_WARN_SECONDS:-5}"

reserve_report_num() {
  # No directory scan here. The number comes from the persisted high-water
  # counter, reconciled once per run in main().
  local started_ns elapsed
  started_ns=$(date +%s%N 2>/dev/null || echo 0)

  local out rc=0
  out=$(run_with_state_lock reserve_report_num_unlocked "$1" "$2" "$3" "$4") || rc=$?

  if [[ "$started_ns" != "0" ]]; then
    local now_ns
    now_ns=$(date +%s%N 2>/dev/null || echo 0)
    if [[ "$now_ns" != "0" ]]; then
      elapsed=$(( (now_ns - started_ns) / 1000000000 ))
      if (( elapsed >= RESERVE_SLOW_WARN_SECONDS )); then
        echo "    ⚠️  reservation for #$1 took ${elapsed}s (warn threshold ${RESERVE_SLOW_WARN_SECONDS}s) — something O(n) may be inside the state lock again." >&2
      fi
    fi
  fi

  printf '%s\n' "$out"
  return "$rc"
}

# Resolve the report number and score the worker ACTUALLY produced.
#
# The runner reserves a report number up front and hands it to the worker, but
# nothing verified the worker used it. When it wrote a different report (for
# example updating an existing report for the same company), the state row kept
# the reserved number, so `report_num` pointed at a file that either did not
# exist or belonged to a different offer. That single gap produced three
# related defects: rows whose score stayed "-" though the report carried one,
# report_num values that disagreed with the file on disk, and a report->JD
# mapping built from state that silently resolved to the wrong posting.
#
# The old score regex compounded it: `"score":[[:space:]]*([0-9.]+)` matched
# only a bare number, so `"score": null` or a quoted value yielded nothing and
# the row silently landed as "-" even when the report said 2.0/5. It also took
# head -1, the FIRST match anywhere in the log, rather than the worker's final
# result line.
#
# Resolution order, most authoritative first:
#   1. the "report" path in the worker's own result JSON
#   2. the report whose "**Batch ID:** <id>" stamp matches this offer
#   3. the reserved number (previous behaviour)
#
# Score prefers the JSON (last match, i.e. the final result line, and tolerating
# quotes) and falls back to "**Score:** X.X/5" in the resolved report.
#
# Echoes "<report_num>\t<score>"; score is "-" when genuinely unavailable.
resolve_worker_result() {
  local log_file="$1" reserved="$2" offer_id="$3"
  local rnum="" score="" rpath="" rfile=""

  if [[ -f "$log_file" ]]; then
    rpath=$(sed -nE 's@.*"report"[[:space:]]*:[[:space:]]*"([^"]+\.md)".*@\1@p' "$log_file" 2>/dev/null | tail -1 || true)
    score=$(sed -nE 's/.*"score"[[:space:]]*:[[:space:]]*"?([0-9]+(\.[0-9]+)?)"?.*/\1/p' "$log_file" 2>/dev/null | tail -1 || true)
  fi

  # 1. the path the worker said it wrote
  if [[ -n "$rpath" ]]; then
    local cand="$rpath"
    [[ "$cand" != /* ]] && cand="$PROJECT_DIR/${rpath#./}"
    [[ -f "$cand" ]] && rfile="$cand"
  fi

  # 2. the report stamped with this batch id — but ONLY when that stamp is
  #    unambiguous. batch-input.tsv has been regenerated several times, so low
  #    ids are reused: id 1 currently matches 21 different reports going back to
  #    May. Taking the first match would silently bind a 2026-08 offer to a
  #    2026-05 report. A single match is trustworthy; anything else is not, and
  #    we fall through to the reserved number rather than guess.
  if [[ -z "$rfile" && -n "$offer_id" ]]; then
    local bid_matches bid_count
    bid_matches=$(grep -l -- "^\*\*Batch ID:\*\* ${offer_id}\$" "$REPORTS_DIR"/*.md 2>/dev/null || true)
    bid_count=$(printf '%s' "$bid_matches" | grep -c . || true)
    if [[ "${bid_count:-0}" -eq 1 ]]; then
      rfile="$bid_matches"
    elif [[ "${bid_count:-0}" -gt 1 ]]; then
      echo "    ⚠️  #$offer_id: Batch ID stamp matches $bid_count reports (ids are reused across batch-input generations) — using the reserved number instead." >&2
    fi
  fi

  # 3. whatever carries the reserved number
  if [[ -z "$rfile" && -n "$reserved" && "$reserved" != "-" ]]; then
    rfile=$(ls "$REPORTS_DIR/${reserved}"-*.md 2>/dev/null | head -1 || true)
  fi

  if [[ -n "$rfile" && -f "$rfile" ]]; then
    rnum=$(basename "$rfile" | sed -nE 's/^([0-9]+)-.*/\1/p')
    if ! is_decimal_number "${score:-}"; then
      score=$(sed -nE 's@^\*\*Score:\*\*[[:space:]]*([0-9]+(\.[0-9]+)?)/5.*@\1@p' "$rfile" 2>/dev/null | head -1 || true)
    fi
  fi

  [[ -n "$rnum" ]] || rnum="$reserved"
  is_decimal_number "${score:-}" || score="-"
  printf '%s\t%s\n' "$rnum" "$score"
}

# Process a single offer
# Return the path of the report already written for this offer, if there is
# exactly one. Empty when none exists or the Batch ID stamp is ambiguous.
#
# The uniqueness requirement is not optional: batch-input.tsv has been
# regenerated repeatedly, so low ids are reused and id 1 currently matches 21
# reports going back to May. Accepting the first match would bind a current
# offer to an unrelated historical report.
find_existing_report_for_offer() {
  local offer_id="$1"
  [[ -n "$offer_id" ]] || return 0
  local matches count
  matches=$(grep -l -- "^\*\*Batch ID:\*\* ${offer_id}\$" "$REPORTS_DIR"/*.md 2>/dev/null || true)
  count=$(printf '%s' "$matches" | grep -c . || true)
  [[ "${count:-0}" -eq 1 ]] && printf '%s\n' "$matches"
  return 0
}

process_offer() {
  local id="$1" url="$2" source="$3" notes="$4"

  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local retries
  retries=$(get_retries "$id")

  # Pre-flight duplicate guard: never spend a worker on an offer that already
  # has a report on disk.
  #
  # Every duplicate evaluation so far has come through this hole. A state write
  # is lost to lock contention, the row stays "processing", sweep_orphans
  # cannot promote it because the worker log has no parsable JSON, and the next
  # run evaluates the offer from scratch. Bankjoy (#1341) went that way on
  # 2026-08-11: report 3193 already existed, the 04:00 resolver even identified
  # it, and 22:00 still produced report 3210. Codal went the same way on
  # 2026-08-07 (2578 -> 3148).
  #
  # Checking the filesystem is authoritative in a way the log is not: if a
  # report carrying this offer's Batch ID exists, the evaluation happened,
  # regardless of what any log does or does not say. Recording it as completed
  # both stops the re-run and repairs the state row to point at the real report.
  local existing_report
  existing_report=$(find_existing_report_for_offer "$id")
  if [[ -n "$existing_report" && -f "$existing_report" ]]; then
    local existing_num existing_score
    existing_num=$(basename "$existing_report" | sed -nE 's/^([0-9]+)-.*/\1/p')
    existing_score=$(sed -nE 's@^\*\*Score:\*\*[[:space:]]*([0-9]+(\.[0-9]+)?)/5.*@\1@p' "$existing_report" 2>/dev/null | head -1 || true)
    is_decimal_number "${existing_score:-}" || existing_score="-"
    echo "--- Skipping offer #$id: already evaluated as report $existing_num ($(basename "$existing_report"))"
    update_state "$id" "$url" "completed" "$started_at" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$existing_num" "$existing_score" \
      "pre-flight: report already on disk, no re-evaluation" "$retries"
    return 0
  fi
  # Reserve a report number AND persist the "processing" state row before doing
  # any expensive work. reserve_report_num can come back empty (lock-acquire
  # timeout) or the row can fail to land under a parallel burst; treat the
  # reservation as successful only when we get a number AND can read the row
  # back as "processing". Retry a few times, then bail rather than run claude -p
  # with no state row (which is what produced silent orphans previously).
  local report_num="" reserve_attempt=0
  while (( reserve_attempt < RESERVE_STATE_MAX_ATTEMPTS )); do
    if report_num=$(reserve_report_num "$id" "$url" "$started_at" "$retries") \
        && [[ -n "$report_num" ]] \
        && [[ "$(get_status "$id")" == "processing" ]]; then
      break
    fi
    report_num=""
    ((reserve_attempt += 1))
    sleep 0.3
  done
  if [[ -z "$report_num" ]]; then
    local failed_at
    failed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    retries=$((retries + 1))
    update_state "$id" "$url" "failed" "$started_at" "$failed_at" "-" "-" \
      "could not persist state row (lock contention) after ${RESERVE_STATE_MAX_ATTEMPTS} attempts" "$retries"
    echo "    ❌ #$id: could not reserve state row after $RESERVE_STATE_MAX_ATTEMPTS attempts — skipping evaluation (will retry next run)"
    return 0
  fi
  local date
  date=$(date +%Y-%m-%d)
  # Use mktemp instead of a predictable /tmp path: a fixed name like
  # /tmp/batch-jd-${id}.txt is guessable, so an attacker on a shared machine
  # could pre-create it as a symlink and redirect or clobber the write.
  local jd_file
  jd_file="$(mktemp "${TMPDIR:-/tmp}/batch-jd-${id}.XXXXXX")"

  # Resolve the URL that goes into the report header.
  #
  # For a `local:jds/foo.md` input the raw value is a filesystem path, and
  # substituting it into {{URL}} put that path in the report's **URL:** header,
  # where the dashboard expects a clickable posting link. The real URL lives in
  # the JD's YAML frontmatter (`url: "https://..."`), so recover it here.
  #
  # We also copy the JD body into the temp file. The worker prompt says to fall
  # back to WebFetch on {{URL}} when the JD file is empty; once {{URL}} is the
  # real posting link that fallback would hit a login wall (LinkedIn) instead of
  # reading the JD we already have on disk. Feeding the content in keeps the
  # worker off the network. The copy is deliberate: the temp file stays
  # disposable, so nothing downstream can touch the original in jds/.
  # Path handed to the worker for the JD. For a local: input this is the
  # repo-relative path (e.g. jds/foo.md), NOT the mktemp path.
  #
  # The mktemp path is a POSIX string like /tmp/batch-jd-1289.cdYICD embedded in
  # the prompt prose. MSYS only rewrites paths passed as command arguments, so
  # the worker receives it untranslated and resolves it however its tooling
  # happens to: through the Bash tool it works, through the Read tool it lands
  # on C:\tmp\... and misses. Same offer, same input, different outcome per run.
  # On 2026-08-06 that cost two evaluations (#1289, #1291) while three sibling
  # offers with identical inputs succeeded. A repo-relative path resolves
  # identically for every tool, since the worker runs with the project as cwd.
  local worker_jd_path="$jd_file"
  local report_url="$url"
  if [[ "$url" == local:* ]]; then
    local local_jd="$PROJECT_DIR/${url#local:}"
    if [[ -f "$local_jd" ]]; then
      worker_jd_path="${url#local:}"
      cat "$local_jd" > "$jd_file" 2>/dev/null || true
      local fm_url
      fm_url=$(awk '
        NR==1 && $0 !~ /^---/ { exit }
        NR>1 && /^---/ { exit }
        NR>1 && /^url:/ {
          line = $0
          sub(/^url:[ \t]*/, "", line)
          gsub(/"/, "", line)
          gsub(/'"'"'/, "", line)
          if (length(line)) { print line; exit }
        }' "$local_jd")
      # Only override when the frontmatter actually carries a URL; otherwise
      # keep the local: path rather than writing an empty header field.
      if [[ -n "$fm_url" ]]; then
        report_url="$fm_url"
      else
        echo "    ⚠️  #$id: no url in JD frontmatter — report URL stays as the local path"
      fi
    fi
  fi

  echo "--- Processing offer #$id: $url (report $report_num, attempt $((retries + 1)))"

  # Build the prompt with placeholders replaced
  local prompt
  if [[ "$SKIP_PDF" == "true" ]]; then
    prompt="Process this job offer. Run the pipeline: A-G evaluation + report .md + tracker line. Do not generate PDF; write ❌ in the tracker PDF column and set \"pdf\": null in the final JSON."
    echo "    ⏭️  --skip-pdf set — skipping PDF generation for #$id ($url)"
  else
    prompt="Process this job offer. Run the full pipeline: A-G evaluation + report .md + optional PDF + tracker line."
  fi
  prompt="$prompt URL: $report_url"
  prompt="$prompt JD file: $worker_jd_path"
  prompt="$prompt Report number: $report_num"
  prompt="$prompt Date: $date"
  prompt="$prompt Batch ID: $id"

  local log_file="$LOGS_DIR/${report_num}-${id}.log"

  # Prepare system prompt with placeholders resolved
  local resolved_prompt="$BATCH_DIR/.resolved-prompt-${id}.md"
  # Escape sed delimiter characters in variables to prevent substitution breakage
  local esc_url esc_jd_file esc_report_num esc_date esc_id
  esc_url="${report_url//\\/\\\\}"
  esc_url="${esc_url//|/\\|}"
  esc_jd_file="${jd_file//\\/\\\\}"
  esc_jd_file="${esc_jd_file//|/\\|}"
  esc_report_num="${report_num//|/\\|}"
  esc_date="${date//|/\\|}"
  esc_id="${id//|/\\|}"
  sed \
    -e "s|{{URL}}|${esc_url}|g" \
    -e "s|{{JD_FILE}}|${esc_jd_file}|g" \
    -e "s|{{REPORT_NUM}}|${esc_report_num}|g" \
    -e "s|{{DATE}}|${esc_date}|g" \
    -e "s|{{ID}}|${esc_id}|g" \
    "$PROMPT_FILE" > "$resolved_prompt"

  # Inject user-layer personalization into the temporary worker prompt.
  # The resolved prompt is gitignored runtime state, so user profile data stays
  # out of the system layer while batch scoring matches interactive scoring.
  for context_file in "$PROJECT_DIR/modes/_profile.md" "$PROJECT_DIR/config/profile.yml" "$PROJECT_DIR/modes/_custom.md"; do
    if [[ -f "$context_file" ]]; then
      {
        printf '\n\n---\n\n'
        printf '## Runtime personalization: %s\n\n' "${context_file#"$PROJECT_DIR/"}"
        sed 's/^/    /' "$context_file"
        printf '\n'
      } >> "$resolved_prompt"
    fi
  done

  # Launch claude -p worker.
  # The model is resolved once per run from spend_tier unless --model was
  # passed. Building the command in an array keeps quoting safe regardless.
  # --strict-mcp-config (with no --mcp-config) starts workers with no MCP
  # servers: they only evaluate offers and need none. Without it each parallel
  # worker inherits the parent session's MCP (e.g. Playwright) and they deadlock
  # fighting over the single shared browser when --parallel > 1 (issue #506).
  local -a claude_args=(-p --dangerously-skip-permissions --strict-mcp-config)
  if [[ -n "$RESOLVED_MODEL" ]]; then
    claude_args+=(--model "$RESOLVED_MODEL")
  fi
  claude_args+=(--append-system-prompt-file "$resolved_prompt" "$prompt")

  local exit_code=0
  local terminal_failure_recorded=false
  local shim_retries=0
  local max_shim_retries=4
  while true; do
    exit_code=0
    # Hard wall-clock cap on the worker.
    #
    # Without it a `claude -p` that hangs without exiting blocks this loop
    # forever, and because the loop holds the run open, one stuck worker jams
    # the whole nightly job: no summary is written, the tracker merge never
    # runs, and the next scheduled job refuses to start on the PID guard. That
    # happened on 2026-08-04, where a worker hung at 22:38 and was still alive
    # 15 hours later with a 0-byte log.
    #
    # `timeout` exits 124 on expiry, which falls through to the normal failure
    # path below: the offer is marked failed, retried within MAX_RETRIES, and
    # the run continues. A jam becomes one bad offer.
    timeout "${WORKER_TIMEOUT}" claude "${claude_args[@]}" > "$log_file" 2>&1 || exit_code=$?

    if [[ $exit_code -eq 124 ]]; then
      echo "    ⏱️  Worker exceeded ${WORKER_TIMEOUT} with no output — killed. Treating as a failed attempt."
      printf '\n[batch-runner] worker killed after %s (timeout)\n' "$WORKER_TIMEOUT" >> "$log_file"
    fi

    if [[ $exit_code -eq 0 ]]; then
      break
    fi

    # Check for Claude Code npm shim swap (exit code 127 + command not found)
    if [[ $exit_code -eq 127 ]] && grep -qE "(claude: command not found|claude:.*not found|cannot find.*claude)" "$log_file" && (( shim_retries < max_shim_retries )); then
      shim_retries=$((shim_retries + 1))
      echo "    ⏳ Claude command not found (shim swap detected). Retrying in 30s (attempt $shim_retries/$max_shim_retries)..."
      sleep 30
      continue
    fi

    if is_session_limit_log "$log_file"; then
      mark_paused_rate_limit "$id" "$url" "$started_at" "$report_num" "$retries" "$log_file"
      echo "    ⏸️  Session/rate limit reached; pausing batch without consuming retry budget."
      terminal_failure_recorded=true
      break
    fi

    if is_rate_limit_log "$log_file" && (( retries < MAX_RETRIES )); then
      if (( RATE_LIMIT_SLEEP <= 0 )); then
        mark_paused_rate_limit "$id" "$url" "$started_at" "$report_num" "$retries" "$log_file"
        echo "    ⏸️  Rate limited and --rate-limit-sleep is 0; pausing batch without consuming retry budget."
        terminal_failure_recorded=true
        break
      fi
      retries=$((retries + 1))
      local retry_completed_at
      retry_completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      update_state "$id" "$url" "rate_limited" "$started_at" "$retry_completed_at" "$report_num" "-" "rate-limit; retrying after ${RATE_LIMIT_SLEEP}s" "$retries"
      echo "    ⏳ Rate limited (attempt $retries/$MAX_RETRIES). Waiting ${RATE_LIMIT_SLEEP}s before retry..."
      sleep "$RATE_LIMIT_SLEEP"
      continue
    fi

    break
  done

  # Cleanup resolved prompt
  rm -f "$resolved_prompt"

  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  if [[ $exit_code -eq 0 ]]; then
    # Resolve what the worker ACTUALLY produced, rather than trusting the
    # reserved number and a single loose regex (see resolve_worker_result).
    local score="-"
    local actual_report_num="$report_num"
    local _resolved
    _resolved=$(resolve_worker_result "$log_file" "$report_num" "$id")
    actual_report_num="${_resolved%%$'\t'*}"
    score="${_resolved##*$'\t'}"
    [[ -n "$actual_report_num" ]] || actual_report_num="$report_num"
    [[ -n "$score" ]] || score="-"

    if [[ "$actual_report_num" != "$report_num" ]]; then
      echo "    ⚠️  #$id: worker wrote report $actual_report_num, not the reserved $report_num — recording the actual one."
      report_num="$actual_report_num"
    fi

    # A zero exit code only means the CLI ran, not that the evaluation
    # succeeded. A worker that cannot obtain the JD writes
    # {"status":"failed", ..., "report":null} and exits 0; branching on the
    # exit code alone recorded that as "completed" with no score and no report
    # on disk, so the offer was never retried and the row lied about it. That
    # happened to #1289 and #1291 on 2026-08-06.
    #
    # Treat it as a failure when the worker says so, or when no report exists
    # for the resolved number. Both go down the normal failure path, so the
    # offer keeps its retry budget and comes back on the next run.
    local worker_status produced_report=false
    worker_status=$(sed -nE 's/.*"status"[[:space:]]*:[[:space:]]*"([a-zA-Z_]+)".*/\1/p' "$log_file" 2>/dev/null | tail -1 || true)
    if [[ -n "$report_num" && "$report_num" != "-" ]] \
      && compgen -G "$REPORTS_DIR/${report_num}-*.md" >/dev/null 2>&1; then
      produced_report=true
    fi

    if [[ "$worker_status" == "failed" ]] || ! $produced_report; then
      local why="no report was written"
      [[ "$worker_status" == "failed" ]] && why="worker reported status=failed"
      local reason
      reason=$(sed -nE 's/.*"error"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$log_file" 2>/dev/null | tail -1 || true)
      # A posting that is gone (404/410, "closed"/"removed") will never come
      # back, but "failed" kept it eligible for retry — and the nightly
      # recovery pass raises the retry cap past every recorded count, so dead
      # postings were re-run every night without end (#3483 hit attempt 8).
      # Record it as terminal "skipped" instead. Matched against the worker's
      # full error text, before truncation.
      if [[ "$worker_status" == "failed" ]] \
        && grep -qiE 'HTTP[[:space:]]*(404|410)|404 Not Found|410 Gone|posting (appears to be |is |was |likely |has been )?(closed|removed|expired)|no longer (accepting|available|open)' <<< "$reason"; then
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "-" "posting-closed: ${reason:0:160}" "$retries"
        echo "    ⏭️  #$id: posting closed (${reason:0:120}) — recording as skipped, not retried."
        return 0
      fi
      [[ -n "$reason" ]] && why="$why: ${reason:0:160}"
      echo "    ❌ #$id: exited 0 but $why — recording as failed, not completed."
      if (( retries < MAX_RETRIES )); then
        retries=$((retries + 1))
      fi
      update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "$why" "$retries"
      return 0
    fi
    if [[ "$score" == "-" ]]; then
      echo "    ⚠️  #$id: completed but no score could be resolved from the log or report $report_num."
    fi

    # Check min-score gate
    if is_decimal_number "$score" && awk -v min="$MIN_SCORE" 'BEGIN{exit !(min > 0)}'; then
      if awk -v score="$score" -v min="$MIN_SCORE" 'BEGIN{exit !(score < min)}'; then
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "$score" "below-min-score" "$retries"
        echo "    ⏭️  Skipped (score: $score < min-score: $MIN_SCORE)"
        return 0
      fi
    fi

    update_state "$id" "$url" "completed" "$started_at" "$completed_at" "$report_num" "$score" "-" "$retries"
    echo "    ✅ Completed (score: $score, report: $report_num)"
  elif [[ "$terminal_failure_recorded" == "false" ]]; then
    if (( retries < MAX_RETRIES )); then
      retries=$((retries + 1))
    fi
    local error_msg
    error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "Unknown error (exit code $exit_code)")
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries"
    echo "    ❌ Failed (attempt $retries, exit code $exit_code)"
  fi
}

# Recover orphan rows in batch-state.tsv where status=processing but the
# worker's log JSON shows it actually completed. This happens when
# acquire_state_lock returns non-zero (mkdir race on burst completions,
# stale lock timeout) and the update_state call inside process_offer fails
# silently — the caller doesn't check the return code and the row stays
# "processing" forever. Without this sweep, the user has to patch state
# manually and the slot is wasted until they do.
#
# Called periodically during the parallel wait loop AND once at end-of-batch
# (before merge_tracker) so anything still slipping through gets caught.
sweep_orphans() {
  local phase="${1:-sweep}"
  local patched=0
  local processing_ids
  processing_ids=$(awk -F'\t' 'NR>1 && $3=="processing" {print $1}' "$STATE_FILE" 2>/dev/null)
  [[ -z "$processing_ids" ]] && return 0

  # Workers that completed within the last (lock_timeout + buffer) seconds might
  # still be queuing for the state lock — patching their state now would race
  # with their own update_state call and inflate the recovered count with
  # non-orphans. Past this window the worker has either succeeded (state row
  # already updated, we'd skip it) or given up (timed out / crashed), so any
  # row still in `processing` is a genuine orphan worth recovering.
  #
  # The freshness gate is bypassed for the "end-of-batch" phase: at that point
  # every worker has been reaped (main() waited on every spawned pid), so there
  # is no remaining lock-queue race to avoid. Leaving the gate active here
  # would leave just-completed orphans behind for a future invocation.
  local orphan_min_age=$((STATE_LOCK_TIMEOUT_SECONDS + 30))
  local now_epoch
  now_epoch=$(date +%s)

  for id in $processing_ids; do
    # Find the most recent log for this id (logs are named {report_num}-{id}.log).
    # ls fails with a non-zero exit when the glob matches nothing; under
    # `set -euo pipefail` that would kill the script, so swallow with `|| log=""`
    # and let the empty-string check below handle it.
    local log
    log=$(ls -t "$LOGS_DIR"/*-"${id}".log 2>/dev/null | head -1) || log=""
    [[ -z "$log" ]] && continue
    # Only recover if the worker JSON shows completion. Empty / partial logs
    # (silent worker death) stay as "processing" so the human can decide
    # whether to mark them failed and retry.
    # Completion signal, most reliable first:
    #   1. a report on disk carrying this offer's Batch ID — authoritative,
    #      and survives a worker log that never captured its JSON (which is
    #      exactly what stranded Bankjoy #1341 on 2026-08-11)
    #   2. the worker's own JSON status, matched whitespace-tolerantly.
    #      The old check was the literal '"status": "completed"' with exactly
    #      one space, so a worker emitting '"status":"completed"' was silently
    #      skipped and its offer re-evaluated.
    local swept_report
    swept_report=$(find_existing_report_for_offer "$id")
    if [[ -z "$swept_report" ]] \
      && ! grep -qE '"status"[[:space:]]*:[[:space:]]*"completed"' "$log"; then
      continue
    fi

    # Freshness check: skip rows where the worker MAY still be holding/queuing
    # for the state lock. Skipped entirely at end-of-batch (all workers reaped).
    if [[ "$phase" != "end-of-batch" ]]; then
      local log_epoch
      log_epoch=$(date -r "$log" +%s 2>/dev/null || echo 0)
      local log_age=$((now_epoch - log_epoch))
      if (( log_age < orphan_min_age )); then
        continue
      fi
    fi

    local recovered_score recovered_report recovered_ts
    # Whitespace-tolerant, and falling back to the report on disk when the log
    # carried no usable JSON. Without the fallback a promoted row could land
    # with an empty report number and score.
    recovered_score=$(sed -nE 's/.*"score"[[:space:]]*:[[:space:]]*"?([0-9]+(\.[0-9]+)?)"?.*/\1/p' "$log" | tail -1)
    recovered_report=$(sed -nE 's/.*"report_num"[[:space:]]*:[[:space:]]*"?([0-9]+)"?.*/\1/p' "$log" | tail -1)
    if [[ -n "$swept_report" && -f "$swept_report" ]]; then
      [[ -n "$recovered_report" ]] || recovered_report=$(basename "$swept_report" | sed -nE 's/^([0-9]+)-.*/\1/p')
      if ! is_decimal_number "${recovered_score:-}"; then
        recovered_score=$(sed -nE 's@^\*\*Score:\*\*[[:space:]]*([0-9]+(\.[0-9]+)?)/5.*@\1@p' "$swept_report" | head -1)
      fi
    fi
    is_decimal_number "${recovered_score:-}" || recovered_score="-"
    [[ -n "$recovered_report" ]] || recovered_report="-"
    recovered_ts=$(date -u -r "$log" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Preserve started_at + url + retries from the existing row
    local existing
    existing=$(awk -F'\t' -v id="$id" '$1==id {print; exit}' "$STATE_FILE")
    local existing_url existing_started existing_retries
    IFS=$'\t' read -r _ existing_url _ existing_started _ _ _ _ existing_retries <<<"$existing"

    # Compare-and-set: only write if the row is still "processing" under
    # the lock. Between this loop's snapshot and now, a worker may have
    # legitimately patched it to "skipped" / "failed" / "completed";
    # blindly writing "completed" would clobber that. update_state_if_processing
    # returns 1 if the row changed underneath us; treat that as a quiet skip.
    if update_state_if_processing "$id" "$existing_url" "$existing_started" "$recovered_ts" "$recovered_report" "$recovered_score" "${existing_retries:-0}"; then
      echo "    🔧 [${phase}] recovered orphan #${id} (score: ${recovered_score}, report: ${recovered_report})"
      patched=$((patched + 1))
    fi
  done

  if (( patched > 0 )); then
    echo "    [${phase}] recovered ${patched} orphan(s) total"
  fi
}

# Merge tracker additions into applications.md
merge_tracker() {
  echo ""
  echo "=== Merging tracker additions ==="
  node "$PROJECT_DIR/merge-tracker.mjs"
  echo ""
  echo "=== Reconciling pipeline.md ==="
  node "$PROJECT_DIR/reconcile-pipeline.mjs" || echo "⚠️  Pipeline reconcile had issues (see above)"
  echo ""
  echo "=== Verifying pipeline integrity ==="
  node "$PROJECT_DIR/verify-pipeline.mjs" || echo "⚠️  Verification found issues (see above)"
}

# Print summary
print_summary() {
  echo ""
  echo "=== Batch Summary ==="

  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found."
    return
  fi

  local total=0 completed=0 skipped=0 failed=0 pending=0
  local score_sum=0 score_count=0

  while IFS=$'\t' read -r sid _ sstatus _ _ _ sscore _ _; do
    [[ "$sid" == "id" ]] && continue
    total=$((total + 1))
    case "$sstatus" in
      completed) completed=$((completed + 1))
        if is_decimal_number "$sscore"; then
          score_sum=$(awk -v sum="$score_sum" -v score="$sscore" 'BEGIN{print sum + score}' 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      skipped) skipped=$((skipped + 1)) ;;
      failed) failed=$((failed + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "Total: $total | Completed: $completed | Skipped: $skipped | Failed: $failed | Pending: $pending"

  if (( score_count > 0 )); then
    local avg
    avg=$(awk -v sum="$score_sum" -v count="$score_count" 'BEGIN{printf "%.1f", sum / count}' 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi

  if [[ -f "$BATCH_DIR/aggregate-tokens.mjs" ]]; then
    if ! node "$BATCH_DIR/aggregate-tokens.mjs"; then
      echo "Warning: token aggregation failed." >&2
    fi
  fi
}

print_status_table() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found at $STATE_FILE"
    return
  fi

  local total=0 completed=0 processing=0 failed=0 pending=0 skipped=0 rate_limited=0 paused_rate_limit=0
  local score_sum=0 score_count=0

  # Read first line to skip header
  local header=true
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries || [[ -n "$sid" ]]; do
    if [[ "$header" == "true" ]]; then
      header=false
      continue
    fi
    [[ -z "$sid" ]] && continue
    sstatus="${sstatus%$'\r'}"
    sscore="${sscore%$'\r'}"
    serror="${serror%$'\r'}"
    sreport="${sreport%$'\r'}"
    total=$((total + 1))
    case "$sstatus" in
      completed)
        completed=$((completed + 1))
        if is_decimal_number "$sscore"; then
          score_sum=$(awk -v sum="$score_sum" -v score="$sscore" 'BEGIN{print sum + score}' 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      processing) processing=$((processing + 1)) ;;
      failed) failed=$((failed + 1)) ;;
      skipped) skipped=$((skipped + 1)) ;;
      rate_limited) rate_limited=$((rate_limited + 1)) ;;
      paused_rate_limit) paused_rate_limit=$((paused_rate_limit + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "=== Batch Progress ==="
  echo "Total: $total | Completed: $completed | Processing: $processing | Failed: $failed | Pending: $pending | Skipped: $skipped | Rate Limited: $rate_limited | Paused: $paused_rate_limit"
  if (( score_count > 0 )); then
    local avg
    avg=$(awk -v sum="$score_sum" -v count="$score_count" 'BEGIN{printf "%.1f", sum / count}' 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi
  echo ""

  # Format the per-job table:
  # Columns: ID, Status, Report, Score, Target (URL or Error Message)
  printf "%-4s | %-17s | %-6s | %-5s | %-40s\n" "ID" "Status" "Report" "Score" "URL / Error"
  printf "%-4s+%-19s+%-8s+%-7s+%-42s\n" "----" "-------------------" "--------" "-------" "------------------------------------------"

  header=true
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries || [[ -n "$sid" ]]; do
    if [[ "$header" == "true" ]]; then
      header=false
      continue
    fi
    [[ -z "$sid" ]] && continue
    sstatus="${sstatus%$'\r'}"
    sscore="${sscore%$'\r'}"
    serror="${serror%$'\r'}"
    sreport="${sreport%$'\r'}"
    local target="$surl"
    if [[ "$sstatus" == "failed" && -n "$serror" && "$serror" != "-" ]]; then
      target="Error: $serror"
    fi
    # Trim target to fit nicely (e.g. 50 chars)
    if (( ${#target} > 50 )); then
      target="${target:0:47}..."
    fi
    printf "%-4s | %-17s | %-6s | %-5s | %-50s\n" "$sid" "$sstatus" "$sreport" "$sscore" "$target"
  done < "$STATE_FILE"
}

watch_status() {
  local active_pid=""
  if [[ -f "$LOCK_FILE" ]]; then
    active_pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  fi

  if [[ -n "$active_pid" ]] && kill -0 "$active_pid" 2>/dev/null; then
    echo "Watching batch-runner (PID $active_pid)... Press Ctrl+C to stop."
    while kill -0 "$active_pid" 2>/dev/null; do
      clear || printf "\033[c"
      echo "=== Watching Batch Progress (PID $active_pid) ==="
      print_status_table
      sleep 2
    done
    echo ""
    echo "=== Batch runner process (PID $active_pid) has finished ==="
  else
    echo "No active batch-runner detected."
  fi

  echo "Showing final status:"
  print_status_table

  # Chain verify-pipeline.mjs
  if [[ -f "$PROJECT_DIR/verify-pipeline.mjs" ]]; then
    echo ""
    echo "=== Running pipeline verification ==="
    node "$PROJECT_DIR/verify-pipeline.mjs" || echo "⚠️  Verification found issues"
  fi
}

# Main
main() {
  if [[ "$STATUS_ONLY" == "true" ]]; then
    check_status_prerequisites
    print_status_table
    exit 0
  fi

  if [[ "$WATCH_MODE" == "true" ]]; then
    check_status_prerequisites
    watch_status
    exit 0
  fi

  check_prerequisites

  resolve_worker_model

  if [[ "$DRY_RUN" == "false" ]]; then
    acquire_lock
    rm -f "$PAUSE_FILE"
  fi

  init_state

  # Count input offers (skip header, ignore blank lines)
  local total_input
  total_input=$(tail -n +2 "$INPUT_FILE" | grep -c '[^[:space:]]' 2>/dev/null || true)
  total_input="${total_input:-0}"

  if (( total_input == 0 )); then
    echo "No offers in $INPUT_FILE. Add offers first."
    exit 0
  fi

  echo "=== career-ops batch runner ==="
  if (( LIMIT > 0 )); then
    echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES | Limit: $LIMIT"
  else
    echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES"
  fi
  if [[ "$RESOLVED_SPEND_TIER" == "override" ]]; then
    echo "Model: $RESOLVED_MODEL (explicit --model override)"
  else
    echo "Model: $RESOLVED_MODEL (spend_tier=${RESOLVED_SPEND_TIER})"
  fi
  echo "Input: $total_input offers"
  echo ""

  # Sweep orphans BEFORE selecting work, not just during and after the run.
  #
  # A row left as "processing" by a previous run (worker finished, state write
  # lost to a lock timeout, or the run was killed mid-flight) is selected as
  # pending here and re-evaluated from scratch — even though its report was
  # already written. That produced a genuine duplicate on 2026-08-06: offer
  # #1277 wrote report 3122 at 22:00, the row stayed "processing", and the
  # 04:00 recovery re-ran the same offer into report 3128. Two reports, two
  # evaluations paid for, one of them orphaned with no tracker row.
  #
  # sweep_orphans only promotes rows whose worker log JSON shows completion, so
  # running it first converts exactly those rows to "completed" and drops them
  # out of the pending set. Genuinely incomplete rows (empty or partial log)
  # are left alone and still get re-processed below, which is what we want.
  if [[ "$DRY_RUN" != "true" ]]; then
    sweep_orphans "startup"
    # Rebuild the report-number counter once, here, so no per-offer reservation
    # has to scan the reports directory.
    reconcile_report_high_water
  fi

  # Build list of offers to process
  local -a pending_ids=()
  local -a pending_urls=()
  local -a pending_sources=()
  local -a pending_notes=()

  while IFS=$'\t' read -r id url source notes; do
    [[ "$id" == "id" ]] && continue  # skip header
    [[ -z "$id" || -z "$url" ]] && continue

    # Guard against non-numeric id values
    [[ "$id" =~ ^[0-9]+$ ]] || continue

    # Skip if before start-from
    if (( id < START_FROM )); then
      continue
    fi

    local status
    status=$(get_status "$id")

    if [[ "$RESUME_PAUSED" == "true" ]]; then
      if [[ "$status" != "paused_rate_limit" ]]; then
        continue
      fi
    elif [[ "$RETRY_FAILED" == "true" ]]; then
      # Only process failed offers
      if [[ "$status" != "failed" ]]; then
        continue
      fi
      # Check retry limit
      local retries
      retries=$(get_retries "$id")
      if (( retries >= MAX_RETRIES )); then
        echo "SKIP #$id: max retries ($MAX_RETRIES) reached"
        continue
      fi
    else
      # Skip terminal offers
      if [[ "$status" == "completed" || "$status" == "skipped" ]]; then
        continue
      fi
      # Paused rate-limit offers resume explicitly with --resume-paused.
      if [[ "$status" == "paused_rate_limit" ]]; then
        continue
      fi
      # Skip failed offers that hit retry limit (unless --retry-failed)
      if [[ "$status" == "failed" ]]; then
        local retries
        retries=$(get_retries "$id")
        if (( retries >= MAX_RETRIES )); then
          echo "SKIP #$id: failed and max retries reached (use --retry-failed to force)"
          continue
        fi
      fi
    fi

    if (( LIMIT > 0 )) && (( ${#pending_ids[@]} >= LIMIT )); then
      break
    fi

    pending_ids+=("$id")
    pending_urls+=("$url")
    pending_sources+=("$source")
    pending_notes+=("$notes")
  done < "$INPUT_FILE"

  local pending_count=${#pending_ids[@]}

  if (( pending_count == 0 )); then
    echo "No offers to process."
    print_summary
    exit 0
  fi

  echo "Pending: $pending_count offers"
  echo ""

  # Dry run: just list
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN (no processing) ==="
    for i in "${!pending_ids[@]}"; do
      local status
      status=$(get_status "${pending_ids[$i]}")
      echo "  #${pending_ids[$i]}: ${pending_urls[$i]} [${pending_sources[$i]}] (status: $status)"
    done
    echo ""
    echo "Would process $pending_count offers"
    exit 0
  fi

  # Process offers
  if (( PARALLEL <= 1 )); then
    # Sequential processing
    for i in "${!pending_ids[@]}"; do
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}"
      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        echo "=== Batch paused: session/rate limit reached. Resume later with --resume-paused. ==="
        break
      fi
    done
  else
    # Parallel processing with job control
    local running=0
    local -a pids=()
    local -a pid_ids=()
    local last_sweep=$SECONDS

    for i in "${!pending_ids[@]}"; do
      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        echo "=== Batch paused: session/rate limit reached. Waiting for running workers, not scheduling new offers. ==="
        break
      fi

      # Wait if we're at parallel limit
      while (( running >= PARALLEL )); do
        # Wait for any child to finish
        for j in "${!pids[@]}"; do
          if ! kill -0 "${pids[$j]}" 2>/dev/null; then
            wait "${pids[$j]}" 2>/dev/null || true
            unset 'pids[j]'
            unset 'pid_ids[j]'
            running=$((running - 1))
          fi
        done
        # Compact arrays
        pids=("${pids[@]}")
        pid_ids=("${pid_ids[@]}")

        # Periodic orphan sweep — recovers slots where a worker finished
        # but its state row didn't update (lock race). Without this, the
        # main loop counts those slots as "in flight" forever and effective
        # parallelism drops over time. Runs from the orchestrator thread,
        # not from workers, so no extra lock contention.
        if (( ORPHAN_SWEEP_INTERVAL_SECONDS > 0 && SECONDS - last_sweep >= ORPHAN_SWEEP_INTERVAL_SECONDS )); then
          sweep_orphans "mid-run"
          last_sweep=$SECONDS
        fi

        if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
          echo "=== Batch paused: session/rate limit reached. Waiting for running workers, not scheduling new offers. ==="
          break
        fi
        sleep 1
      done

      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        break
      fi

      # Launch worker in background
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}" &
      pids+=($!)
      pid_ids+=("${pending_ids[$i]}")
      running=$((running + 1))
    done

    # Wait for remaining workers
    for pid in "${pids[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  # Final orphan sweep — catch anything that slipped past the periodic check.
  # Runs in both sequential and parallel modes for consistency. Cheap when
  # there's nothing to recover.
  sweep_orphans "end-of-batch"

  # Merge tracker additions
  merge_tracker

  # Print summary
  print_summary

  exit 0
}

main "$@"
