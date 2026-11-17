// tests/morning-brief.test.mjs — the nightly "check last night's batch run" brief.
//
// Builds a fake night (run logs, batch state, a report, a tracker) in a temp
// directory and checks what morning-brief.mjs makes of it: the night window,
// pay-floor skips told apart from real failures, a missing run flagged, and the
// health check diffed against the previous brief. node:test suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBrief, explainNotCompleted, previousDate, renderMarkdown, sameEmployer, splitRuns, parseRun,
  workerErrorFromLog,
} from '../morning-brief.mjs';

const iso = (...a) => new Date(...a).toISOString();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'morning-brief-'));
  const w = (rel, text) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
  w('tmp/nightly-2026-11-11.log', [
    '================================================',
    '  Nightly career-ops run — 2026-11-11_180003',
    'Companies scanned:     46',
    'New offers added:      5',
    '🚨 FIX NEEDED: 2 target(s) have been unreachable for 3+ runs:',
    '   Parloa, Hightouch',
    'Errors (1):',
    '  ✗ LinkedIn — VP of Engineering: page.goto: Timeout 30000ms exceeded.',
    '',
    '=== Scan complete: 18:16:54 — summary: tmp/nightly-latest-summary.txt ===',
  ].join('\n'));
  w('tmp/nightly-2026-11-11-eval.log', [
    '  Nightly career-ops run — 2026-11-11_220001',
    'imported 3 new offer(s) of 3 pending',
    '=== Verifying pipeline integrity ===',
    '⚠️  Possible duplicates: #1, #2 (Old — Role)',
    '⚠️  Orphan report — no tracker row references #99',
    '⚠️  #7045: unknown employer (?) but the tracker has no Via column — add it with: node merge-tracker.mjs --migrate-via',
    '✅ All statuses are canonical',
    '',
    '=== Run complete: 22:42:10 — summary: tmp/nightly-latest-summary.txt ===',
  ].join('\n'));
  // No -late.log: the 04:00 run never happened.
  w('batch/batch-input.tsv', [
    'id\turl\tsource\tnotes',
    '1\thttps://a/1\tn\tEarlier | Daytime Role',
    '2\thttps://a/2\tn\tAcme | Director of Engineering | Remote',
    '3\thttps://a/3\tn\tCheapCo | Team Lead',
    '4\thttps://a/4\tn\tBrokenCo | Head of AI',
  ].join('\n') + '\n');
  w('batch/batch-state.tsv', [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    `1\thttps://a/1\tcompleted\t${iso(2026, 10, 11, 17, 15)}\t-\t100\t3.9\t-\t0`,
    `2\thttps://a/2\tcompleted\t${iso(2026, 10, 11, 22, 5)}\t-\t101\t4.2\t-\t0`,
    `3\thttps://a/3\tskipped\t${iso(2026, 10, 11, 22, 6)}\t-\t102\t-\tdealbreaker: "compensation.minimum $175K"\t0`,
    `4\thttps://a/4\tfailed\t${iso(2026, 10, 11, 22, 7)}\t-\t103\t-\tworker timeout\t2`,
  ].join('\n') + '\n');
  w('reports/101-acme-2026-11-11.md', [
    '# Evaluation: Acme — Director of Engineering',
    '',
    '**Score:** 4.2/5',
    '**Decision:** Apply',
    '**Legitimacy:** High Confidence',
    '**URL:** https://acme.example/jobs/1',
    '',
    '**Apply.** Strong fit for the platform team.',
  ].join('\n'));
  w('data/applications.md', [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 50 | 2026-06-01 | Acme | VP Engineering | 3.5/5 | Rejected | ❌ | [50](../reports/050-acme-2026-06-01.md) | |',
    '| 101 | 2026-11-11 | Acme | Director of Engineering | 4.2/5 | Evaluated | ❌ | [101](../reports/101-acme-2026-11-11.md) | |',
  ].join('\n') + '\n');
  w('data/pipeline.md', '## Pendientes\n\n- [ ] https://x/1 | Left | Over\n');
  return dir;
}

test('builds the night from logs, batch state, report and tracker', () => {
  const dir = fixture();
  try {
    const previous = { health: { all: ['⚠️  Possible duplicates: #1, #2 (Old — Role)'] } };
    const b = buildBrief({ root: dir, repoDir: dir, date: '2026-11-12', now: new Date(2026, 10, 12, 4, 30), previous });

    // The 17:15 manual run is outside the night; the three 22:xx rows are in.
    assert.equal(b.evaluated.length, 1);
    assert.equal(b.counts.applyWorthy, 1);
    const pick = b.topPicks[0];
    assert.equal(pick.company, 'Acme');
    assert.equal(pick.role, 'Director of Engineering');
    assert.equal(pick.decision, 'Apply');
    assert.equal(pick.trackerRow, 101);
    assert.deepEqual(pick.seenBefore.map((s) => s.trackerRow), [50]);
    assert.match(pick.verdict, /Strong fit/);

    const byCo = Object.fromEntries(b.notCompleted.map((r) => [r.company, r]));
    assert.equal(byCo.CheapCo.kind, 'skipped');
    assert.match(byCo.CheapCo.reason, /below your \$175K floor/);
    assert.equal(byCo.BrokenCo.kind, 'failed');
    assert.equal(b.counts.skipped, 1);
    assert.equal(b.counts.failed, 1);
    assert.equal(b.counts.pendingLeft, 1);
    assert.equal(b.counts.scanAdded, 5);

    const texts = b.issues.map((i) => i.text).join('\n');
    assert.match(texts, /04:00 catch-up did not run/);
    assert.match(texts, /BrokenCo .*Failed: worker timeout/);
    assert.match(texts, /Scan errors on 1\/46 providers: LinkedIn — VP of Engineering/);
    assert.match(texts, /unreachable for 3\+ runs: Parloa, Hightouch/);
    assert.equal(b.status, 'problem');

    // Only the warning absent from the previous brief is new; Via noise is dropped.
    assert.deepEqual(b.health.newWarnings, ['⚠️  Orphan report — no tracker row references #99']);
    assert.equal(b.health.recurringCount, 1);
    assert.equal(b.health.total, 2); // the Via-column line is dropped as noise
    assert.equal(b.health.seen.length, 2);

    // The next morning diffs against the hashes this brief stored.
    const next = buildBrief({ root: dir, repoDir: dir, date: '2026-11-12', now: new Date(2026, 10, 12, 4, 30), previous: b });
    assert.deepEqual(next.health.newWarnings, []);

    const md = renderMarkdown(b);
    assert.match(md, /## At or above 4\.0/);
    assert.match(md, /❌ 04:00 catch-up: did not run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('first brief records the health check as a baseline', () => {
  const dir = fixture();
  try {
    const b = buildBrief({ root: dir, repoDir: dir, date: '2026-11-12', now: new Date(2026, 10, 12, 4, 30) });
    assert.equal(b.health.baseline, true);
    assert.deepEqual(b.health.newWarnings, []);
    assert.equal(b.health.total, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mass of new health-check errors is one issue, a few are listed one by one', () => {
  const dir = fixture();
  const evalLog = (errors) => [
    '  Nightly career-ops run — 2026-11-11_220001',
    '=== Verifying pipeline integrity ===',
    ...errors,
    '',
    '=== Run complete: 22:42:10 ===',
  ].join('\n');
  const previous = { health: { seen: [] } };
  const build = () => buildBrief({ root: dir, repoDir: dir, date: '2026-11-12', now: new Date(2026, 10, 12, 4, 30), previous });
  try {
    // A half-copied reports/ folder: every row loses its report at once.
    const many = Array.from({ length: 40 }, (_, i) => `❌ #${i + 1}: Report not found: reports/${i + 1}-x.md`);
    writeFileSync(join(dir, 'tmp/nightly-2026-11-11-eval.log'), evalLog(many));
    const health = build().issues.filter((i) => i.text.startsWith('Tracker health check'));
    assert.equal(health.length, 1);
    assert.match(health[0].text, /40 new errors since the previous brief, for example #1: Report not found/);

    writeFileSync(join(dir, 'tmp/nightly-2026-11-11-eval.log'), evalLog(many.slice(0, 2)));
    assert.equal(build().issues.filter((i) => i.text.startsWith('Tracker health check')).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('splitRuns keeps appended runs apart; parseRun reads an unfinished run', () => {
  const runs = splitRuns('  Nightly career-ops run — 2026-11-11_090000\nimported 1 new offer(s) of 1 pending\n=== Run complete: 09:10:00 ===\n  Nightly career-ops run — 2026-11-11_220001\nTimed out waiting for state lock\n');
  assert.deepEqual(runs.map((r) => r.ts), ['2026-11-11_090000', '2026-11-11_220001']);
  assert.equal(parseRun(runs[0].lines).finished, true);
  const late = parseRun(runs[1].lines);
  assert.equal(late.finished, false);
  assert.equal(late.lockTimeouts, 1);
});

test('helpers', () => {
  assert.equal(previousDate('2026-11-01'), '2026-10-31');
  assert.equal(previousDate('2026-01-01'), '2025-12-31');
  assert.ok(sameEmployer('Temporal', 'Temporal Technologies'));
  assert.ok(sameEmployer('Early Warning Services, LLC', 'Early Warning Services'));
  assert.ok(!sameEmployer('Compass Group', 'Levy Restaurants'));
  assert.ok(!sameEmployer('?', 'Acme'));
  assert.equal(explainNotCompleted({ status: 'processing' }).kind, 'stuck');
  assert.match(explainNotCompleted({ status: 'skipped', error: 'dealbreaker: "no on-site"' }).reason, /dealbreaker \(no on-site\)/);
});

test('worker failures report the real error, not Claude Code startup rule warnings', () => {
  const warn = "Permission allow rule (.claude\settings.local.json): Bash(sed -E 's#x#y#') has a wildcard before the rest of the command, so it also matches any options.";
  const log = [warn, warn, warn, 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare', ''].join('\n');
  assert.equal(workerErrorFromLog(log), 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare');
  assert.equal(workerErrorFromLog([warn, ''].join('\n')), null);
  const r = explainNotCompleted({ status: 'failed', error: 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare' });
  assert.equal(r.kind, 'failed');
  assert.match(r.reason, /Cloudflare 403/);
});
