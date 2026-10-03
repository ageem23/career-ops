/**
 * dedup-utils.test.mjs — tests for the shared scan/merge dedup normalizer.
 *
 * Focus: normalizeCompany hardening (corporate-suffix stripping + token sort)
 * added to kill real "same company+role evaluated twice" misses, while NOT
 * over-merging genuinely distinct companies.
 *
 * Run: node dedup-utils.test.mjs
 */

import assert from 'assert';
import { normalizeCompany, roleMatch } from './dedup-utils.mjs';

let pass = 0;
const eq = (a, b, msg) => { assert.strictEqual(normalizeCompany(a), normalizeCompany(b), msg); pass++; };
const ne = (a, b, msg) => { assert.notStrictEqual(normalizeCompany(a), normalizeCompany(b), msg); pass++; };
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };

// ── Corporate-suffix stripping: same company must collapse ──────────────
eq('Vizient', 'Vizient, Inc', 'Vizient == Vizient, Inc');
eq('Acme', 'Acme LLC', 'Acme == Acme LLC');
eq('Acme, Inc.', 'Acme LLC', 'Acme Inc == Acme LLC (both strip to acme)');
eq('Trading Co', 'Trading Company', 'Trading Co == Trading Company');
eq('Metro Global Ventures LLC', 'Metro Global Ventures', 'LLC suffix stripped');

// ── Parenthetical-alias reordering must collapse ────────────────────────
eq('FreeWheel (Comcast)', 'Comcast (FreeWheel)', 'alias reorder collapses');
eq('Acme (Parent Co)', 'Parent (Acme)', 'sorted tokens collapse reorder');

// ── Distinct companies must STAY distinct (no over-merge) ────────────────
ne('Stripe', 'Square', 'different companies');
ne('Coates Group', 'Coates', 'descriptive "group" is part of the name, not a suffix');
ne('Rezilient Health', 'Rezilient', 'descriptive "health" not stripped');
ne('The Scion Group', 'Scion', 'multi-word name not collapsed to bare token');
ne('Northern Trust', 'Northern', 'second real word not dropped');
ne('OpenAI', 'Anthropic', 'obviously distinct');

// ── Empty / suffix-only guards: never collapse to "" ────────────────────
ok(normalizeCompany('Inc') !== '', '"Inc" alone falls back, not empty');
ne('Inc', 'LLC', 'suffix-only names stay distinct via fallback');
ok(normalizeCompany(null) === '' || typeof normalizeCompany(null) === 'string', 'null-safe');
ok(normalizeCompany(undefined) === '' || typeof normalizeCompany(undefined) === 'string', 'undefined-safe');

// ── roleMatch sanity (ensure module still loads/behaves) ────────────────
ok(roleMatch('Backend Platform Engineer', 'Platform Backend Developer') === true,
   'role reorder with 2+ content tokens matches');
ok(roleMatch('Engineering Manager (Payments)', 'Engineering Manager (Catalog)') === false,
   'distinct role specialties stay separate');

console.log(`✅ dedup-utils: all ${pass} assertions passed`);
