// @vitest-environment node
// #8809: finishing a form attachment removal answers another member's live
// attachment exactly as it answers an id that does not exist, for every
// member role, and still finishes the caller's own removal and its retry.
// Every write rolls back with the proof transaction. The forms carry no
// answers at all, so no form content can reach a log or this fixture.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadMigrationSql } from './helpers/migration.js';
import { sourceTransactionProblem } from '../scripts/hosted-migration-apply-runner.mjs';
import { as, expectRefusal, member, rpc, verifiedOrg, withClient } from './helpers/openSignupOrganization.js';

describe('form file removal answers migration', () => {
  it('uses the real transaction guard', () => {
    expect(sourceTransactionProblem(loadMigrationSql('form_file_removal_answers_alike'))).toBeNull();
  });
});

const live = process.env.SUPABASE_DB_URL ? it : it.skip;

live('answers another member\'s attachment as a missing one for every role, and still finishes the owner\'s removal', async () => {
  await withClient(async (c) => {
    const a = await verifiedOrg(c);
    const other = await verifiedOrg(c);
    const owner = await member(c, { org: a.org, chapter: a.chapter });

    // Fixture only: a draft form with one attachment the owner asked to
    // remove and one still attached, installed past the form triggers.
    await c.query('set local session_replication_role = replica');
    const form = randomUUID();
    await c.query("insert into public.member_forms(id,user_id,template_key,status,answers) values ($1,$2,'grievance','draft','{}'::jsonb)", [form, owner.user]);
    const file = async (pending) => (await c.query(
      `insert into public.member_form_files(form_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at,deletion_requested_at,deletion_requested_by)
       values ($1,$2,'statement.pdf','application/pdf',1024,$3,now(),$4,$5) returning id`,
      [form, `${form}/${randomUUID()}.pdf`, owner.user, pending ? new Date() : null, pending ? owner.user : null])).rows[0].id;
    const pendingFile = await file(true), liveFile = await file(false);
    await c.query('set local session_replication_role = origin');

    const finalize = (who, id) => as(c, who).then(() => rpc(c, 'public.finalize_member_form_file_removal($1)', [id]));
    const remaining = async () => (await c.query('select count(*)::int n from public.member_form_files where form_id=$1', [form])).rows[0].n;

    // Every member role in the same chapter, and an administrator of another
    // organization: the owner's two files answer exactly as a missing id
    // (only the id they were given differs), and nothing is removed.
    const callers = [await member(c, { org: a.org, chapter: a.chapter }), other.admin];
    for (const role of ['steward', 'coordinator', 'advisor', 'admin', 'vp']) callers.push(await member(c, { org: a.org, chapter: a.chapter, role }));
    for (const caller of callers) {
      const missing = randomUUID();
      const answers = [];
      for (const id of [missing, pendingFile, liveFile]) {
        const answer = await finalize(caller, id).then((value) => ({ value }), (error) => ({ code: error.code, message: error.message }));
        answers.push(answer.value ? { ...answer.value, id: answer.value.id === id ? 'given' : answer.value.id } : answer);
      }
      expect(answers).toEqual([{ deleted: true, id: 'given' }, { deleted: true, id: 'given' }, { deleted: true, id: 'given' }]);
    }
    expect(await remaining()).toBe(2);

    // The owner keeps every check: an attachment not asked to be removed is
    // refused, the pending one is removed (no bytes are stored), and a retry
    // after that answers as before.
    await expectRefusal(finalize(owner, liveFile), '22023', 'file unavailable');
    expect(await finalize(owner, pendingFile)).toEqual({ deleted: true, id: pendingFile });
    expect(await finalize(owner, pendingFile)).toEqual({ deleted: true, id: pendingFile });
    expect(await remaining()).toBe(1);
  });
});
