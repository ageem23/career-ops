#!/usr/bin/env node
/**
 * sync-tasks.mjs — Reconcile cadence output → data/tasks.md
 *
 * Calls followup-cadence.mjs for its JSON view of actionable applications and
 * ensures a pending follow-up task exists for each (appNum, cycle) that isn't
 * already represented in tasks.md as pending, done, or skipped.
 *
 * Idempotent: re-running never duplicates tasks. Tasks the user marked done or
 * skipped stay in the file and block the same cycle from being recreated.
 *
 * Phase 1 only generates `followup` tasks. Contacto + manual + interview
 * thank-yous arrive in later phases.
 *
 * Run: node sync-tasks.mjs            (writes tasks.md, prints summary)
 *      node sync-tasks.mjs --dry-run  (prints planned additions, no writes)
 *      node sync-tasks.mjs --json     (machine-readable result)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const TASKS_FILE = join(CAREER_OPS, 'data/tasks.md');
const CADENCE_SCRIPT = join(CAREER_OPS, 'followup-cadence.mjs');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const jsonOut = args.includes('--json');

const HEADER = `# Tasks

Follow-up tasks generated from cadence rules, contacto suggestions, and manual entries. Managed by \`sync-tasks.mjs\` and the dashboard.

| # | Created | Due | App# | Company | Type | Title | Status | Completed | Notes |
|---|---------|-----|------|---------|------|-------|--------|-----------|-------|
`;

function today() {
  return new Date().toISOString().split('T')[0];
}

function runCadence() {
  const result = spawnSync('node', [CADENCE_SCRIPT], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`followup-cadence.mjs exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function parseTasks() {
  if (!existsSync(TASKS_FILE)) return { tasks: [], nextNum: 1 };
  const content = readFileSync(TASKS_FILE, 'utf-8');
  const tasks = [];
  let maxNum = 0;
  for (const line of content.split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map(s => s.trim());
    // Skip header / separator
    if (parts.length < 11) continue;
    const num = parseInt(parts[1]);
    if (isNaN(num)) continue;
    if (num > maxNum) maxNum = num;
    tasks.push({
      num,
      created: parts[2],
      due: parts[3],
      appNum: parts[4] === '-' ? null : parseInt(parts[4]),
      company: parts[5],
      type: parts[6],
      title: parts[7],
      status: parts[8],
      completed: parts[9],
      notes: parts[10] || '',
    });
  }
  return { tasks, nextNum: maxNum + 1 };
}

function plannedFollowups(cadence) {
  const planned = [];
  for (const e of cadence.entries || []) {
    if (!e.nextFollowupDate) continue; // cold or no cadence rule
    const cycle = (e.followupCount || 0) + 1;
    planned.push({
      appNum: e.num,
      company: e.company,
      cycle,
      due: e.nextFollowupDate,
      urgency: e.urgency,
      role: e.role,
      reportPath: e.reportPath,
    });
  }
  return planned;
}

function alreadyTracked(tasks, plan) {
  // A planned followup is already represented if a task with same App# + type=followup
  // and cycle marker in title exists in ANY status (pending/done/skipped).
  const marker = `Follow up #${plan.cycle}`;
  return tasks.some(t =>
    t.type === 'followup' &&
    t.appNum === plan.appNum &&
    t.title.startsWith(marker)
  );
}

function formatRow(task) {
  const appCol = task.appNum === null || task.appNum === undefined ? '-' : String(task.appNum);
  return `| ${task.num} | ${task.created} | ${task.due || '-'} | ${appCol} | ${task.company || '-'} | ${task.type} | ${task.title} | ${task.status} | ${task.completed || '-'} | ${task.notes || ''} |`;
}

function writeTasks(allTasks) {
  const rows = allTasks.map(formatRow).join('\n');
  const content = HEADER + (rows ? rows + '\n' : '');
  writeFileSync(TASKS_FILE, content, 'utf-8');
}

function main() {
  const cadence = runCadence();
  const { tasks, nextNum } = parseTasks();

  const planned = plannedFollowups(cadence);
  const additions = [];
  let n = nextNum;
  const created = today();

  for (const plan of planned) {
    if (alreadyTracked(tasks, plan)) continue;
    additions.push({
      num: n++,
      created,
      due: plan.due,
      appNum: plan.appNum,
      company: plan.company,
      type: 'followup',
      title: `Follow up #${plan.cycle} — ${plan.role || plan.company}`,
      status: 'pending',
      completed: '-',
      notes: plan.urgency,
    });
  }

  const merged = tasks.concat(additions);

  const summary = {
    cadenceEntries: planned.length,
    existing: tasks.length,
    added: additions.length,
    additions: additions.map(a => ({ num: a.num, appNum: a.appNum, company: a.company, due: a.due, title: a.title })),
  };

  if (!dryRun) {
    writeTasks(merged);
  }

  if (jsonOut) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const verb = dryRun ? 'Would add' : 'Added';
    console.log(`sync-tasks: ${summary.cadenceEntries} cadence entries, ${summary.existing} existing tasks, ${verb} ${summary.added}`);
    for (const a of summary.additions) {
      console.log(`  #${a.num} → App#${a.appNum} ${a.company} (due ${a.due}) — ${a.title}`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`sync-tasks failed: ${err.message}`);
  process.exit(1);
}
