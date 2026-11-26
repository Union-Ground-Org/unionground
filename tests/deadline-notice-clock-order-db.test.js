// @vitest-environment node
// Execute the real remap and upsert SQL in an isolated schema. The case-graph
// gate is a transaction advisory lock; existing integration proofs cover the
// full sweeps, authorization, extension RPC and notification dispatch.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const migration = readFileSync('supabase/migrations/20261105191200_deadline_notice_clock_reconciliation.sql', 'utf8');
const legacy = readFileSync('supabase/migrations/20261002135600_restore_review_hotfixes.sql', 'utf8');
// Pin the reconciliation calendar only; delivery/history clocks stay real.
const remap = migration.slice(0, migration.indexOf('create or replace function private.'))
  .replace(/^begin;$/m, '')
  .replace("(pg_catalog.clock_timestamp() at time zone 'America/New_York')::date", "date '2026-11-11'");
const upsert = legacy.match(/insert into private\.staff_deadline_notice_marks as mark \(source, deadline_id, due_on, stage\)[\s\S]*?where mark\.stage < excluded\.stage;/)[0];
const currentUpsert = migration.match(/insert into private\.staff_deadline_notice_marks as mark \([\s\S]*?where not mark\.eastern_day or mark\.stage < excluded\.stage;/)[0];
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live('deadline notice delivery order', () => {
  let extension;
  let sweep;
  const notices = [];
  const schema = `deadline_clock_${randomUUID().replaceAll('-', '')}`;
  const gate = `deadline-clock-${randomUUID()}`;
  const qualify = sql => sql
    .replaceAll('private.staff_deadline_notice_marks', `${schema}.marks`)
    .replaceAll('public.casework_deadlines', `${schema}.deadlines`)
    .replaceAll('public.member_cases', `${schema}.cases`)
    .replaceAll('private.casework_record_versions', `${schema}.versions`)
    .replaceAll('private.lock_case_graph', `${schema}.lock_case_graph`);
  const query = (sql, values = []) => extension.query(sql, values);

  beforeAll(async () => {
    const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    extension = new pg.Client({ connectionString: url });
    sweep = new pg.Client({ connectionString: url });
    await extension.connect();
    await sweep.connect();
    extension.on('notice', notice => notices.push(notice.message));
  });
  afterAll(async () => {
    await sweep?.query('rollback');
    await extension?.query('rollback');
    await extension?.query(`drop schema if exists ${schema} cascade`);
    await sweep?.end();
    await extension?.end();
  });
  beforeEach(async () => {
    await query(`drop schema if exists ${schema} cascade; create schema ${schema};
      create function ${schema}.lock_case_graph(uuid[], uuid[]) returns void language sql
      as $$select pg_advisory_xact_lock(hashtextextended('${gate}', 0))$$;
      create table ${schema}.cases(id uuid primary key, status text default 'active', learning_undone_at timestamptz);
      create table ${schema}.deadlines(id uuid primary key, due_at timestamptz, case_id uuid, status text default 'active');
      create table ${schema}.versions(
        record_table text, record_id text, op text, old_row jsonb, new_row jsonb,
        at timestamptz not null default clock_timestamp());
      create table ${schema}.marks(
        source text, deadline_id uuid, due_on date, stage smallint,
        eastern_day boolean not null default true,
        marked_at timestamptz not null default now(),
        primary key(source, deadline_id, due_on));
      create function ${schema}.legacy_mark(p_id uuid) returns boolean language plpgsql as $body$
      declare v_deadline record;
      begin
        select 'casework_deadline'::text source, p_id deadline_id,
          '2026-11-11'::date due_on, 3::smallint stage into v_deadline;
        ${qualify(upsert)}
        return found;
      end; $body$;`);
    notices.length = 0;
  });

  async function deadline() {
    const id = randomUUID();
    await query(`insert into ${schema}.cases(id) values ($1)`, [id]);
    await query(`insert into ${schema}.deadlines(id,due_at,case_id) values ($1, '2026-11-10T22:00:00-05:00',$1)`, [id]);
    return id;
  }
  async function extend(id) {
    // Both instants have UTC date November 11; their Eastern days differ.
    await query(`update ${schema}.deadlines set due_at='2026-11-11T01:00:00-05:00' where id=$1`, [id]);
    return (await query(`insert into ${schema}.versions(record_table,record_id,op,old_row,new_row)
      values ('casework_deadlines',$1,'UPDATE',
        jsonb_build_object('due_at','2026-11-10T22:00:00-05:00'),
        jsonb_build_object('due_at','2026-11-11T01:00:00-05:00','updated_at',now())) returning at`, [id])).rows[0].at;
  }
  const marks = async id => (await query(`select due_on::text,stage,marked_at from ${schema}.marks where deadline_id=$1`, [id])).rows;

  for (const [startSweepFirst, preallocateTransactionId] of [[false, false], [true, false], [true, true]]) {
    it(`re-notifies once for an ambiguous legacy delivery with sweep transaction ${startSweepFirst ? 'started before' : 'waiting behind'} the extension${preallocateTransactionId ? ' and an early transaction ID' : ''}`, async () => {
      const id = await deadline();
      let waiting;
      try {
        let started;
        if (startSweepFirst) {
          await sweep.query('begin');
          started = (await sweep.query('select now() started')).rows[0].started;
          if (preallocateTransactionId) await sweep.query('select pg_current_xact_id()');
        }
        await query('begin');
        await query(`select ${schema}.lock_case_graph(array[]::uuid[],array[]::uuid[])`);
        if (!startSweepFirst) {
          await sweep.query('begin');
          started = (await sweep.query('select now() started')).rows[0].started;
        }
        waiting = sweep.query(`select ${schema}.lock_case_graph(array[]::uuid[],array[]::uuid[])`);
        const changed = await extend(id);
        expect(changed.getTime()).toBeGreaterThanOrEqual(started.getTime());
        await query('commit');
        await waiting;
        expect((await sweep.query(`select ${schema}.legacy_mark($1) sent`, [id])).rows[0].sent).toBe(true);
        await sweep.query('commit');
        expect((await marks(id))[0].marked_at.getTime()).toBe(started.getTime());
        await query(qualify(remap));
        expect(await marks(id)).toHaveLength(0);
        expect(notices).toContain('deadline notice legacy reconciliation: cleared 1 ambiguous marks and 0 obsolete UTC marks');
        expect(notices.join('\n')).not.toContain(id);
        expect((await query(`select ${schema}.legacy_mark($1) sent`, [id])).rows[0].sent).toBe(true);
        expect((await query(`select ${schema}.legacy_mark($1) sent`, [id])).rows[0].sent).toBe(false);
        const beforeReplay = await marks(id);
        await query(qualify(remap));
        expect(await marks(id)).toEqual(beforeReplay);
      } finally {
        await query('rollback');
        if (waiting) await waiting;
        await sweep.query('rollback');
      }
    });
  }

  for (const priorStage of [null, 2]) {
    it(`uses the history wall clock for a ${priorStage ? 'stage update' : 'new delivery'} written after a lock wait`, async () => {
      await query(qualify(remap));
      await query(`create function ${schema}.current_mark(p_id uuid) returns boolean language plpgsql as $body$
        declare v_deadline record;
        begin
          select 'casework_deadline'::text source, p_id deadline_id,
            '2026-11-11'::date due_on, 3::smallint stage into v_deadline;
          ${qualify(currentUpsert)}
          return found;
        end; $body$;`);
      const id = await deadline();
      if (priorStage) await query(`insert into ${schema}.marks(source,deadline_id,due_on,stage)
        values ('casework_deadline',$1,'2026-11-11',2)`, [id]);
      let waiting;
      try {
        await query('begin');
        await query(`select ${schema}.lock_case_graph(array[]::uuid[],array[]::uuid[])`);
        await sweep.query('begin');
        await sweep.query('select now()');
        waiting = sweep.query(`select ${schema}.lock_case_graph(array[]::uuid[],array[]::uuid[])`);
        await extend(id);
        await query('commit');
        await waiting;
        await sweep.query(`select ${schema}.current_mark($1)`, [id]);
        await sweep.query('commit');
        expect((await query(`select m.marked_at > v.at after_history from ${schema}.marks m
          join ${schema}.versions v on v.record_id=m.deadline_id::text where m.deadline_id=$1`, [id])).rows[0].after_history).toBe(true);
      } finally {
        await query('rollback');
        if (waiting) await waiting;
        await sweep.query('rollback');
      }
    });
  }

  it('re-notifies once for an ambiguous legacy delivery after the extension in the same transaction', async () => {
    const id = await deadline();
    try {
      await query('begin');
      await query(`select ${schema}.lock_case_graph(array[]::uuid[],array[]::uuid[])`);
      await extend(id);
      expect((await query(`select ${schema}.legacy_mark($1) sent`, [id])).rows[0].sent).toBe(true);
      await query(qualify(remap));
      expect(await marks(id)).toHaveLength(0);
      expect((await query(`select ${schema}.legacy_mark($1) sent`, [id])).rows[0].sent).toBe(true);
      expect((await query(`select ${schema}.legacy_mark($1) sent`, [id])).rows[0].sent).toBe(false);
    } finally { await query('rollback'); }
  });

  it('keeps an unambiguous valid legacy delivery that starts after history', async () => {
    const id = await deadline();
    await extend(id);
    await query(`select ${schema}.legacy_mark($1)`, [id]);
    const before = await marks(id);
    await query(qualify(remap));
    expect(await marks(id)).toEqual(before);
    expect((await query(`select ${schema}.legacy_mark($1) sent`, [id])).rows[0].sent).toBe(false);
    expect(notices).toContain('deadline notice legacy reconciliation: cleared 0 ambiguous marks and 0 obsolete UTC marks');
  });

  it('keeps an already converted Eastern key across the UTC boundary and on replay', async () => {
    const id = await deadline();
    await query(`insert into ${schema}.marks(source,deadline_id,due_on,stage)
      values ('casework_deadline',$1,'2026-11-10',3)`, [id]);
    const before = await marks(id);
    await query(qualify(remap));
    expect(await marks(id)).toEqual(before);
    await query(qualify(remap));
    expect(await marks(id)).toEqual(before);
  });

  it('converts an untouched UTC key once while retaining its original delivery time', async () => {
    const id = await deadline();
    await query(`insert into ${schema}.marks(source,deadline_id,due_on,stage,eastern_day)
      values ('casework_deadline',$1,'2026-11-11',3,false)`, [id]);
    const before = (await marks(id))[0];
    await query(qualify(remap));
    expect(await marks(id)).toEqual([{ ...before, due_on: '2026-11-10' }]);
    const converted = await marks(id);
    await query(qualify(remap));
    expect(await marks(id)).toEqual(converted);
  });

  for (const state of ['closed', 'past', 'completed-deadline']) {
    it(`retains an ambiguous legacy mark for a ${state} case or due day`, async () => {
      const id = await deadline();
      await query(`select ${schema}.legacy_mark($1)`, [id]);
      await extend(id);
      if (state === 'closed') await query(`update ${schema}.cases set status='closed' where id=$1`, [id]);
      if (state === 'completed-deadline') await query(`update ${schema}.deadlines set status='completed' where id=$1`, [id]);
      const before = await marks(id);
      const sql = state === 'past' ? remap.replace("date '2026-11-11'", "date '2026-11-12'") : remap;
      await query(qualify(sql));
      expect(await marks(id)).toEqual(before);
    });
  }

  for (const sameTransaction of [false, true]) {
    it(`retires an earlier same-UTC-date delivery when its Eastern due day changes${sameTransaction ? ' in the same transaction' : ''}`, async () => {
      const id = await deadline();
      try {
        if (sameTransaction) await query('begin');
        expect((await query(`select ${schema}.legacy_mark($1) sent`, [id])).rows[0].sent).toBe(true);
        await extend(id);
        await query(qualify(remap));
        expect(await marks(id)).toHaveLength(0);
        expect((await query(`select ${schema}.legacy_mark($1) sent`, [id])).rows[0].sent).toBe(true);
      } finally { if (sameTransaction) await query('rollback'); }
    });
  }

  it('does not refresh a stale legacy mark on a same-stage sweep', async () => {
    const id = await deadline();
    await query(`select ${schema}.legacy_mark($1)`, [id]);
    const before = await marks(id);
    await extend(id);
    expect((await query(`select ${schema}.legacy_mark($1) sent`, [id])).rows[0].sent).toBe(false);
    expect(await marks(id)).toEqual(before);
    await query(qualify(remap));
    expect(await marks(id)).toHaveLength(0);
  });
});
