// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fnBody, loadMigrationSql, stripComments } from './helpers/migration.js';
const sql = stripComments(loadMigrationSql('share_case_destinations'));
const body = fnBody(sql, 'public.list_share_case_destinations');
describe('bounded share case destination reader', () => {
  it('hoists caller authority and bounds minimal output without replacing visibility with active-only scope', () => {
    expect(sql).toContain("security definer set search_path = ''");
    expect(body).toContain('with actor_scope as materialized');
    expect(body).toContain("array(select private.staff_visible_chapter_scope('coordinator'))");
    expect(body).toContain('where c.user_id = v_actor');
    expect(body).toContain('c.steward_user_id = v_actor');
    expect(body).toContain('where (select s.mfa_satisfied from actor_scope s)');
    expect(body).toContain('least(greatest(coalesce(p_limit,100),1),100)');
    expect(body).toContain('order by c.updated_at desc, c.id');
    expect(body).not.toContain('staff_can_see_user(');
    expect(body).not.toMatch(/status\s*=/);
    expect(sql).toContain('revoke all on function public.list_share_case_destinations(integer) from public, anon, authenticated, service_role');
    expect(sql).toContain('grant execute on function public.list_share_case_destinations(integer) to authenticated');
  });
});
