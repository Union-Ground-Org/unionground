import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20260902050000_g4_native_staff_authorization_depth.sql'),
  'utf8',
).toLowerCase();

function body(name) {
  const marker = `function ${name.toLowerCase()}`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('$function$;', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('G4 native staff tenant and health authorization repairs', () => {
  it('fans handshake notifications only to active target-chapter and target-organization staff', () => {
    const notify = body('private.notify_handshake_staff');
    expect(notify).toContain('public.member_role_chapters');
    expect(notify).toContain('public.member_chapter_memberships');
    expect(notify).toContain("membership.status = 'active'");
    expect(notify).toContain('role_chapter_scope.organization_id is null');
    expect(notify).toContain("role_organization.status = 'active'");
    expect(notify).toContain('public.organization_role_grants');
    expect(notify).toContain('public.organization_memberships');
    expect(notify).toContain('public.organizations');
    expect(notify).toContain("organization.status = 'active'");
    expect(notify).toContain('role_grant.organization_id = chapter.organization_id');
    expect(notify).not.toContain('public.member_roles');
    expect(notify).not.toContain('chapter_id is null');
  });

  it('gives organization-wide leadership its chapters without widening another organization', () => {
    const currentOrganization = body('private.current_mobile_staff_organization');
    const staffScope = body('public.get_my_mobile_staff_scope');
    const predicate = body('private.can_manage_chapter_health');
    expect(currentOrganization).toContain('private.current_member_organization()');
    expect(currentOrganization).toContain('when private.current_member_chapter() is not null');
    expect(currentOrganization).not.toContain('select coalesce(');
    expect(currentOrganization).toContain('when pg_catalog.count(*) = 1');
    expect(currentOrganization).toContain("organization.status = 'active'");
    expect(staffScope).toContain('private.current_mobile_staff_organization()');
    expect(staffScope).toContain('private.current_member_chapter()');
    expect(staffScope).toContain('private.staff_mfa_required()');
    expect(staffScope).toContain('public.organization_role_grants');
    expect(staffScope).toContain('public.organization_memberships');
    expect(staffScope).toContain('public.member_role_chapters');
    expect(staffScope).toContain('public.member_chapter_memberships');
    expect(staffScope).toContain("membership.status = 'active'");
    expect(staffScope).toContain('chapter.organization_id is null and selected_organization_id is null');
    expect(staffScope).toContain("organization.status = 'active'");
    expect(staffScope).toContain("'organizationid', selected_organization_id");
    expect(staffScope).toContain("'chapterroles', chapter_roles");
    expect(staffScope).toContain('pg_catalog.jsonb_array_length(roles) > 0');
    expect(staffScope).toContain('pg_catalog.jsonb_array_length(chapter_roles) > 0');
    expect(staffScope).toContain("'staffauthorized', false");
    expect(predicate).toContain('chapter.id = p_chapter_id');
    expect(predicate).toContain("private.member_has_chapter_role(chapter.id, array['advisor','admin','vp'])");
    expect(predicate).toContain('chapter.organization_id = private.current_mobile_staff_organization()');
    expect(predicate).toContain('public.organization_role_grants');
    expect(predicate).toContain("role_grant.role in ('advisor','admin','vp')");
    expect(source).toContain('using (private.can_manage_chapter_health(chapter_id))');
    const portfolio = body('public.get_chapter_health_portfolio');
    const record = body('public.record_chapter_health_snapshot');
    const coaching = body('public.add_chapter_health_coaching');
    expect(portfolio).toContain('where private.mfa_satisfied()');
    expect(portfolio).toContain('and private.can_manage_chapter_health(chapter.id)');
    expect(record).toContain('not private.mfa_satisfied()');
    expect(record).toContain('not private.can_manage_chapter_health(p_chapter_id)');
    expect(coaching).toContain('not private.mfa_satisfied()');
    expect(coaching).toContain('not private.can_manage_chapter_health(p_chapter_id)');
  });

  it('returns dated and attributed coaching while keeping the ten-member threshold', () => {
    const portfolio = body('public.get_chapter_health_portfolio');
    expect(portfolio).toContain("'databasedate', current_date");
    expect(portfolio).toContain("coalesce(latest.member_count, 0) < 10");
    expect(portfolio).toContain("coalesce(latest.member_count, 0) >= 10");
    expect(portfolio).toContain("'authorname'");
    expect(portfolio).toContain('left join public.member_profiles profile on profile.id = coaching.author_id');
    expect(portfolio).toContain("'createdat', coaching.created_at");
  });

  it('does not rank protected cohorts by hidden scores and preserves snapshot attribution', () => {
    const record = body('public.record_chapter_health_snapshot');
    const portfolio = body('public.get_chapter_health_portfolio');
    expect(source).toContain('add column if not exists updated_by uuid');
    expect(record).toContain('updated_by = caller, updated_at = pg_catalog.clock_timestamp()');
    expect(record).not.toContain('created_by = caller, created_at = pg_catalog.clock_timestamp()');
    expect(portfolio).toContain("case when coalesce(latest.member_count, 0) >= 10 then latest.score else null end nulls last");
    expect(portfolio).toContain("'recordedby'");
    expect(portfolio).toContain("'revisedby'");
  });
});
