// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fnBody, loadMigrationSql, migrationFiles } from './helpers/migration.js';

const sql = loadMigrationSql('20261009002000_event_model');
function prosrc(statement) {
  const tag = statement.match(/\bas\s+(\$[a-z_]*\$)/i)[1];
  return statement.slice(statement.indexOf(tag) + tag.length, statement.lastIndexOf(tag));
}
const digest = (value) => createHash('md5').update(value).digest('hex');

describe('reapplicable event model migration', () => {
  it.each(['public.rsvp_to_event', 'public.get_calendar_feed_events', 'public.get_admin_events'])('pins both exact bodies for %s', (name) => {
    const predecessor = [...migrationFiles()].reverse().find((migration) => migration.name < '20261009002000_event_model.sql'
      && new RegExp(`(?:create|replace)\\s+function\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i').test(migration.sql));
    const oldBody = prosrc(fnBody(predecessor.sql, name));
    const newBody = prosrc(fnBody(sql, name));
    expect(sql).toContain(`pg_catalog.jsonb_build_array('${digest(oldBody)}', '${digest(newBody)}')`);
    expect(sql).toContain('pg_catalog.md5(p.prosrc)');
  });
  it('checks canonical column, constraint and index definitions on every application', () => {
    for (const column of ['ends_at', 'event_kind', 'event_date', 'series_id', 'sort_at']) {
      expect(sql).toContain(`add column if not exists ${column}`);
    }
    expect(sql).toContain("'pg_temp.event_model_expected'::regclass");
    expect(sql).toContain('actual.expression is distinct from expected.expression');
    expect(sql).toContain('convalidated and pg_catalog.pg_get_constraintdef(oid) = expected.definition');
    expect(sql).toContain('create index if not exists member_events_chapter_sort_idx');
    expect(sql).toContain('i.indnkeyatts = 3 and i.indnatts = 3 and i.indpred is null and i.indexprs is null');
  });
  it('emits series creation notifications only for the first occurrence', () => {
    const create = fnBody(sql, 'public.create_member_event_model');
    expect(create).toMatch(/if occurrence = 0 then\s+begin\s+for m in/);
    expect(create).toMatch(/end;\s+end if;\s+ids := ids/);
  });
});
