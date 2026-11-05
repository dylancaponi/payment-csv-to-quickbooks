// Golden output files: every fixture x every target. Regenerate after an
// intentional change with: UPDATE_GOLDEN=1 node --test
// Review the diff of golden/ before committing a regeneration.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse, write, TARGETS } from '../index.js';
import { CASES, GOLDEN, readFixture, UNSUPPORTED } from '../test-support/fixtures.js';

const update = process.env.UPDATE_GOLDEN === '1';
mkdirSync(GOLDEN, { recursive: true });

describe('golden outputs', () => {
  for (const c of CASES) {
    const parsed = parse(c.source, readFixture(c.file), c.options);
    for (const t of TARGETS) {
      if (UNSUPPORTED.has(`${c.source}>${t.id}`)) continue;
      const name = `${c.file.replace(/\.csv$/, '')}.${t.id}${t.extension === 'csv' ? '.csv' : ''}`;
      test(name, () => {
        const out = write(t.id, parsed.transactions, { sourceId: c.source });
        const p = join(GOLDEN, name);
        if (update) { writeFileSync(p, out.content); return; }
        assert.ok(existsSync(p), `missing golden file ${name}; run UPDATE_GOLDEN=1 node --test`);
        assert.equal(out.content, readFileSync(p, 'utf8'), `${name} changed; if intended, run UPDATE_GOLDEN=1 node --test and review the diff`);
      });
    }
  }
});
