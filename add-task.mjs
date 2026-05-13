#!/usr/bin/env node
/**
 * add-task.mjs — append a single task row to data/tasks.md
 *
 * Intended to be invoked by mode skills (e.g. contacto) so that contact
 * suggestions, interview prep items, and other ad-hoc todos land in the same
 * dashboard view as cadence-driven follow-ups. Idempotent on (type, title,
 * appNum) for pending tasks so re-running a mode never duplicates rows.
 *
 * Usage:
 *   node add-task.mjs --type contact --title "LinkedIn: Jane Doe (Recruiter)" \
 *                     --company "Acme" --notes "linkedin.com/in/jane-doe"
 *
 *   node add-task.mjs --type manual --title "Prep portfolio" --app 412 \
 *                     --due 2026-05-20
 *
 * Flags:
 *   --type     followup | contact | interview | manual   (required)
 *   --title    short description                          (required)
 *   --company  associated company                         (optional)
 *   --app      App# from data/applications.md             (optional)
 *   --due      YYYY-MM-DD                                 (optional)
 *   --notes    free text                                  (optional)
 *   --json     emit machine-readable result
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const TASKS_FILE = join(CAREER_OPS, 'data/tasks.md');

const ALLOWED_TYPES = new Set(['followup', 'contact', 'interview', 'manual']);

const HEADER = `# Tasks

Follow-up tasks generated from cadence rules, contacto suggestions, and manual entries. Managed by \`sync-tasks.mjs\` and the dashboard.

| # | Created | Due | App# | Company | Type | Title | Status | Completed | Notes |
|---|---------|-----|------|---------|------|-------|--------|-----------|-------|
`;

function todayLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      throw new Error(`flag ${a} requires a value`);
    }
    out[key] = val;
    i++;
  }
  return out;
}

function validate(args) {
  if (!args.type) throw new Error('--type is required');
  if (!ALLOWED_TYPES.has(args.type)) {
    throw new Error(`--type must be one of: ${[...ALLOWED_TYPES].join(', ')}`);
  }
  if (!args.title || !args.title.trim()) throw new Error('--title is required');
  if (args.due && !/^\d{4}-\d{2}-\d{2}$/.test(args.due)) {
    throw new Error('--due must be YYYY-MM-DD');
  }
  if (args.app !== undefined) {
    const n = parseInt(args.app, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error('--app must be a positive integer');
    args.app = n;
  }
}

// Mirrors sync-tasks.mjs escapeField so a value containing "|" or a newline
// can't fracture the table on the next parseTasks() pass.
function escapeField(value) {
  return String(value ?? '').replace(/\|/g, '¦').replace(/\r?\n/g, ' ');
}

function readRows() {
  if (!existsSync(TASKS_FILE)) {
    return { header: HEADER.trimEnd(), rows: [], nextNum: 1 };
  }
  const content = readFileSync(TASKS_FILE, 'utf-8');
  const lines = content.split('\n');
  const rows = [];
  const headerLines = [];
  let maxNum = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith('|') &&
      !trimmed.startsWith('|---') &&
      !trimmed.startsWith('| #')
    ) {
      const parts = trimmed.split('|').map(s => s.trim()).filter(Boolean);
      const n = parseInt(parts[0], 10);
      if (Number.isFinite(n)) {
        rows.push({ raw: line, parts });
        if (n > maxNum) maxNum = n;
        continue;
      }
    }
    headerLines.push(line);
  }
  while (headerLines.length && headerLines[headerLines.length - 1].trim() === '') {
    headerLines.pop();
  }
  return { header: headerLines.join('\n'), rows, nextNum: maxNum + 1 };
}

function alreadyHas(rows, type, title, appNum) {
  const wantTitle = title.trim();
  const wantApp = appNum ?? null;
  return rows.some(r => {
    const p = r.parts;
    // parts: [num, created, due, app, company, type, title, status, completed, notes?]
    if ((p[7] || '').toLowerCase() !== 'pending') return false;
    if ((p[5] || '') !== type) return false;
    if ((p[6] || '').trim() !== wantTitle) return false;
    const rowApp = p[3] === '-' || p[3] === '' ? null : parseInt(p[3], 10);
    return rowApp === wantApp;
  });
}

function formatRow(t) {
  const appCol = t.appNum ? String(t.appNum) : '-';
  return `| ${t.num} | ${t.created} | ${t.due || '-'} | ${appCol} | ${escapeField(t.company) || '-'} | ${escapeField(t.type)} | ${escapeField(t.title)} | pending | - | ${escapeField(t.notes)} |`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  validate(args);

  const { header, rows, nextNum } = readRows();

  if (alreadyHas(rows, args.type, args.title, args.app)) {
    const result = { status: 'duplicate', message: 'matching pending task already exists' };
    if (args.json) console.log(JSON.stringify(result));
    else console.log('skip: a pending task with that type, title, and app already exists');
    return;
  }

  const task = {
    num: nextNum,
    created: todayLocal(),
    due: args.due || '',
    appNum: args.app,
    company: args.company || '',
    type: args.type,
    title: args.title.trim(),
    notes: args.notes || '',
  };

  mkdirSync(dirname(TASKS_FILE), { recursive: true });
  const newRow = formatRow(task);
  const body = (header.endsWith('\n') ? header : header + '\n') +
    rows.map(r => r.raw).join('\n') +
    (rows.length ? '\n' : '') +
    newRow + '\n';
  writeFileSync(TASKS_FILE, body, 'utf-8');

  const result = { status: 'added', num: task.num, title: task.title };
  if (args.json) console.log(JSON.stringify(result));
  else console.log(`added: #${task.num} — ${task.title}`);
}

try {
  main();
} catch (err) {
  console.error(`add-task failed: ${err.message}`);
  process.exit(1);
}
