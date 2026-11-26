// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripComments } from './helpers/migration.js';

const sql = stripComments(readFileSync(new URL('../supabase/migrations/20260907140000_native_message_actions.sql', import.meta.url), 'utf8'));
describe('native message actions server contract', () => {
  it('wraps changes in a transaction and enters the lifecycle gate before RPC work', () => {
    expect(sql.trim()).toMatch(/^begin;/);
    expect(sql.trim()).toMatch(/commit;$/);
    for (const name of ['get_member_message_actions', 'edit_member_message', 'act_on_member_message', 'reply_to_member_message']) {
      expect(sql).toMatch(new RegExp(`create function public\\.${name}\\([\\s\\S]*?set search_path = '' as \\$function\\$\\s*begin\\s*perform private\\.lock_message_lifecycle\\(\\);`));
      expect(sql).toContain(`grant execute on function public.${name}`);
    }
  });
  it('requires attributed latest ownership, a time window and no preservation order', () => {
    expect(sql).toContain('message.sender_id = caller');
    expect(sql).toContain("interval '15 minutes'");
    expect(sql).toContain('(later.created_at, later.id) > (message.created_at, message.id)');
    expect(sql).toContain('private.member_message_under_legal_hold(message.conversation_id) is false');
    expect(sql).toContain("(state->>'canEdit')::boolean is not true");
    expect(sql).not.toMatch(/grant update/);
    expect(sql).not.toMatch(/update public\.chapter_thread_posts/);
  });
  it('validates parents within the same source and refuses unsupported boundaries', () => {
    expect(sql).toContain('parent_target is distinct from target');
    expect(sql).toContain("p_source_kind not in ('private', 'channel')");
    expect(sql).toContain('before insert on public.member_messages');
    expect(sql).toContain('before insert on public.chapter_thread_posts');
  });
  it('replaces the dispatched copy and audits without copying message content', () => {
    expect(sql).toContain('update public.member_scheduled_messages set body = clean where sent_message_id = p_message_id');
    expect(sql).toContain("private.message_action_audit('private', p_message_id, 'edited')");
    const audit = sql.split('create function private.message_action_audit')[1].split('$function$;')[0];
    expect(audit).not.toMatch(/\bbody\b/);
  });
});

// BUG-UG-STEWARD-MESSAGE-REPLY-DISCLOSES-PERSONAL-NAME-20260921
const pseudonymSql = stripComments(readFileSync(new URL('../supabase/migrations/20260924190200_steward_message_reply_pseudonym.sql', import.meta.url), 'utf8'));
const stewardReplySql = stripComments(readFileSync(new URL('../supabase/migrations/20260723040000_chapter_model_foundation.sql', import.meta.url), 'utf8'));
describe('steward per-message reply pseudonym', () => {
  const reply = pseudonymSql.split('create or replace function public.reply_to_member_message(')[1].split('$function$;')[0];
  const insert = reply.split('insert into public.member_messages(')[1].split('returning id into new_id')[0];
  it('re-emits only reply_to_member_message behind the case-graph and lifecycle gates with its grants', () => {
    expect(pseudonymSql.trim()).toMatch(/^begin;/);
    expect(pseudonymSql.trim()).toMatch(/commit;$/);
    expect(pseudonymSql.match(/create (or replace )?function/g)).toHaveLength(1);
    expect(reply).toMatch(/set search_path = '' as \$function\$\s*begin\s*perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\s*begin\s*perform private\.lock_message_lifecycle\(\);/);
    expect(reply).toContain('perform public.get_member_message_actions(p_source_kind, p_message_id);');
    expect(pseudonymSql).toContain('revoke all on function public.reply_to_member_message(text, uuid, text) from public, anon, authenticated, service_role;');
    expect(pseudonymSql).toContain('grant execute on function public.reply_to_member_message(text, uuid, text) to authenticated;');
  });
  it('stamps the same steward pseudonym as send_steward_reply and never a profile name or Member on steward rows', () => {
    const composer = stewardReplySql.split('create or replace function public.send_steward_reply(')[1].split('$$;')[0];
    expect(composer).toContain("values (convo.id, convo.user_id, 'steward', 'Chapter steward', clean_body)");
    expect(insert).toContain("case when kind = 'steward' then 'Chapter steward'");
    const memberBranch = insert.split("case when kind = 'steward' then 'Chapter steward'")[1].split(' end,')[0];
    expect(memberBranch).toMatch(/^\s*else coalesce\(\(select nullif\(full_name, ''\) from public\.member_profiles where id = caller\), 'Member'\)$/);
  });
});
