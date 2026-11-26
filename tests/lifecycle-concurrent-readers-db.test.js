// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { connectLocal } from './helpers/local-lifecycle-contention.mjs';
import { runReaderScenario } from './helpers/local-lifecycle-readers.mjs';

const url = process.env.SUPABASE_DB_URL;
const live = url ? describe : describe.skip;

live('concurrent lifecycle read admission', () => {
  it.each([
    'get_organization_analytics_workspace',
    'get_organization_analytics_snapshot',
    'get_organization_coordination_extensions',
  ])('admits four authenticated %s readers while excluding account deletion', async rpc => {
    const report = await runReaderScenario(url, { rpc });
    expect(report.reads.map(read => read.code)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(report.writerBlocked).toBe(true);
    expect(report.writerRecovered).toBe(true);
  }, 60000);

  it('never waits on contended reader-to-writer upgrades, and keeps writer reentrancy', async () => {
    const readers = await Promise.all([connectLocal(url, 'upgrade-a'), connectLocal(url, 'upgrade-b')]);
    try {
      for (const reader of readers) {
        await reader.query('begin');
        await reader.query('select private.lock_case_graph_read()');
      }
      const attempts = await Promise.all(readers.map(async reader => {
        try {
          await reader.query('select private.lock_case_graph(array[]::uuid[],array[]::uuid[])');
          return 'ok';
        } catch (error) { return error.code; }
      }));
      expect(attempts).toContain('40001');
      expect(attempts.every(code => code === '40001' || code === 'ok')).toBe(true);
      await Promise.all(readers.map(reader => reader.query('rollback')));
      await readers[0].query('begin');
      await readers[0].query('select private.lock_case_graph(array[]::uuid[],array[]::uuid[])');
      await readers[0].query('select private.lock_case_graph_read()');
      await readers[0].query('select private.lock_case_graph(array[]::uuid[],array[]::uuid[])');
    } finally {
      await Promise.all(readers.map(reader => reader.query('rollback')));
      await Promise.all(readers.map(reader => reader.end()));
    }
  });

  it('retains read-committed isolation, caller timeouts and private helper ACLs', async () => {
    const holder = await connectLocal(url, 'read-timeout-holder');
    const reader = await connectLocal(url, 'read-timeout');
    try {
      for (const timeout of ['0', '100ms', '6s']) {
        await reader.query(`set lock_timeout='${timeout}'`);
        await reader.query('begin');
        await reader.query('select private.lock_case_graph_read()');
        expect((await reader.query('show lock_timeout')).rows[0].lock_timeout).toBe(timeout);
        await reader.query('rollback');
      }
      await holder.query('begin');
      await holder.query('select private.lock_case_graph(array[]::uuid[],array[]::uuid[])');
      await reader.query("set lock_timeout='100ms'");
      await expect(reader.query('select private.lock_case_graph_read()')).rejects.toMatchObject({ code: '55P03' });
      expect((await reader.query('show lock_timeout')).rows[0].lock_timeout).toBe('100ms');
      await holder.query('rollback');
      await reader.query('begin isolation level repeatable read');
      await expect(reader.query('select private.lock_case_graph_read()')).rejects.toMatchObject({ code: '40001' });
      await reader.query('rollback');
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const privileges = await reader.query(`select has_function_privilege($1, 'private.lock_case_graph_read()', 'execute') read_gate,
          has_function_privilege($1, 'private.lifecycle_read_admitted()', 'execute') read_state`, [role]);
        expect(privileges.rows[0]).toEqual({ read_gate: false, read_state: false });
      }
    } finally {
      await Promise.all([holder.query('rollback'), reader.query('rollback')]);
      await Promise.all([holder.end(), reader.end()]);
    }
  });
});
