// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connectLocal, runContentionScenario } from './helpers/local-lifecycle-contention.mjs';
import { runnerTimeout } from '../scripts/lib/runner-timeout.mjs';

const url = process.env.SUPABASE_DB_URL;
const live = url ? describe : describe.skip;

live('bounded lifecycle admission on the complete local schema', () => {
  it('bounds 30 task writes across two organizations and recovers after release', async () => {
    const report = await runContentionScenario(url);
    expect(report.blocked).toHaveLength(30);
    expect(report.recovered).toHaveLength(30);
  }, 60000);

  it('retains stricter caller timeouts and restores settings on success and caught failure', async () => {
    const holder = await connectLocal(url, 'strict-holder');
    const client = await connectLocal(url, 'strict-writer');
    try {
      for (const setting of ['0', '100ms', '6s']) {
        await client.query(`set lock_timeout='${setting}'`);
        await client.query('begin');
        await client.query('select private.lock_message_lifecycle()');
        expect((await client.query('show lock_timeout')).rows[0].lock_timeout).toBe(setting);
        await client.query('rollback');
      }
      await holder.query('begin');
      await holder.query('select private.lock_message_lifecycle()');
      await client.query("set lock_timeout='100ms'");
      const start = performance.now();
      await expect(client.query('select private.lock_message_lifecycle()')).rejects.toMatchObject({ code: '55P03' });
      expect(performance.now() - start).toBeGreaterThanOrEqual(75);
      // Still far below the 6 s lock_timeout restored next, so the 100 ms limit is what applied.
      expect(performance.now() - start).toBeLessThan(runnerTimeout(1500));
      await client.query("set lock_timeout='6s'");
      await client.query(`do $$ begin
        perform private.lock_message_lifecycle();
        raise exception 'unexpected admission';
      exception when lock_not_available then
        if current_setting('lock_timeout') <> '6s' then raise exception 'leaked timeout'; end if;
      end $$`);
      expect((await client.query('show lock_timeout')).rows[0].lock_timeout).toBe('6s');
    } finally {
      await Promise.all([holder.query('rollback'), client.query('rollback')]);
      await Promise.all([holder.end(), client.end()]);
    }
  }, 20000);

  it('keeps transaction ownership after helper return and preserves lifecycle-before-case ordering', async () => {
    const holder = await connectLocal(url, 'order-holder');
    const client = await connectLocal(url, 'order-writer');
    try {
      await holder.query('begin');
      await holder.query('select private.lock_message_lifecycle()');
      await client.query('begin');
      await client.query("set local lock_timeout='100ms'");
      await client.query('savepoint before_gate');
      await expect(client.query('select private.lock_case_graph(array[]::uuid[],array[]::uuid[])')).rejects.toMatchObject({ code: '55P03' });
      await client.query('rollback to before_gate');
      const locks = await client.query("select count(*)::int n from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted");
      expect(locks.rows[0].n).toBe(0);
      await holder.query('rollback');
      await client.query('select private.lock_case_graph(array[]::uuid[],array[]::uuid[])');
      expect((await client.query("select count(*)::int n from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted")).rows[0].n).toBe(2);
      // Reentrant acquisition must succeed even while the transaction owns it.
      await client.query('select private.lock_message_lifecycle()');
    } finally {
      await Promise.all([holder.query('rollback'), client.query('rollback')]);
      await Promise.all([holder.end(), client.end()]);
    }
  });

  it('retains the read-committed requirement', async () => {
    const client = await connectLocal(url, 'isolation');
    try {
      await client.query('begin isolation level repeatable read');
      await expect(client.query('select private.lock_message_lifecycle()')).rejects.toMatchObject({ code: '40001' });
    } finally { await client.query('rollback'); await client.end(); }
  });

  it('aborts a blocked Auth deletion atomically and permits retry after release', async () => {
    const holder = await connectLocal(url, 'deletion-holder');
    const client = await connectLocal(url, 'deletion');
    const user = randomUUID();
    try {
      await client.query('insert into auth.users(id,email) values($1,$2)', [user, `${user}@example.invalid`]);
      await holder.query('begin');
      await holder.query('select private.lock_case_graph(array[]::uuid[],array[]::uuid[])');
      await expect(client.query('delete from auth.users where id=$1', [user])).rejects.toMatchObject({ code: '55P03' });
      expect((await client.query('select id from auth.users where id=$1', [user])).rowCount).toBe(1);
      expect((await client.query('select id from public.member_profiles where id=$1', [user])).rowCount).toBe(1);
      await holder.query('rollback');
      await client.query('delete from auth.users where id=$1', [user]);
      expect((await client.query('select id from public.member_profiles where id=$1', [user])).rowCount).toBe(0);
    } finally {
      await holder.query('rollback');
      try { await client.query('delete from auth.users where id=$1', [user]); }
      finally { await Promise.all([holder.end(), client.end()]); }
    }
  }, 15000);
});
