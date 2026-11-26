import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BE_HEARD_READERS, BE_HEARD_RETENTION, BE_HEARD_URGENT_ROUTE, INCIDENT_NOTES_READERS, INCIDENT_NOTES_RETENTION, NOT_FOR_EMERGENCIES, STEWARD_ALERT_CONFIRMATION } from './sensitiveInputDisclosure';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

// REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103, audit
// MOB-STEWARD-07, MOB-COORDINATOR-06, MOB-ADVISOR-06/-07, MOB-VP-06/-07.
describe('sensitive input disclosure', () => {
  it('names the readers the intake policy allows for Be heard', () => {
    const policy = read('../../../../supabase/migrations/20260812092000_intake_triage_conversion.sql');
    expect(policy).toContain("reporter_id = (select auth.uid())");
    expect(policy).toContain("public.member_has_role(array['steward', 'coordinator'])");
    // Gate round 1 on #6996: admin is deliberately not an intake reader, and no
    // later migration changes the read policy, so the sentence stays exact.
    expect(policy).toContain('Admin by itself is not an intake desk role.');
    const migrations = readdirSync(fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url))).filter((name) => name.endsWith('.sql')).sort();
    const readers = migrations.filter((name) => /policy\s+member_intake_reports_read\b/i.test(read(`../../../../supabase/migrations/${name}`)));
    expect(readers).toEqual(['20260727211853_full_product_completion.sql', '20260812092000_intake_triage_conversion.sql']);
    expect(BE_HEARD_READERS).toBe('Who can read these reports: you, and the committee members and campaign leads of your campaign.');
    expect(BE_HEARD_URGENT_ROUTE).toContain('call 911');
    expect(BE_HEARD_URGENT_ROUTE).toContain('message the committee from Messages');
  });

  it('names the staff who read an alerted checklist, from the workspace RPC', () => {
    const staff = read('../../../../supabase/migrations/20260829030000_member_support_programs.sql');
    expect(staff).toContain("array['steward', 'coordinator', 'advisor', 'admin', 'vp']");
    const workspace = read('../../../../supabase/migrations/20261003040000_member_pin_signin.sql');
    expect(workspace).toContain("and (c.member_user_id = caller or (staff and c.status = 'alerted'))");
    expect(INCIDENT_NOTES_READERS).toContain('Only you can read saved notes.');
    expect(INCIDENT_NOTES_READERS).toContain('committee members, campaign leads, advisors, admins and campaign chair');
    expect(NOT_FOR_EMERGENCIES).toBe('This is not an emergency service. If anyone is in danger, call 911.');
  });

  it('shows the readers before the notes field and confirms before an alert is sent', () => {
    const screen = read('../features/MemberSupportScreen.tsx');
    const notes = screen.indexOf('<TextInput accessibilityLabel="Private incident notes"');
    expect(screen.lastIndexOf('<Body muted>{INCIDENT_NOTES_READERS}</Body>', notes)).toBeGreaterThan(0);
    expect(screen).toContain('Alert.alert(STEWARD_ALERT_CONFIRMATION.title, STEWARD_ALERT_CONFIRMATION.body, [');
    expect(screen).toContain("{ text: STEWARD_ALERT_CONFIRMATION.confirmLabel, style: 'destructive', onPress: sendAlert },");
    expect(STEWARD_ALERT_CONFIRMATION.body).toContain('this checklist and your notes');
    // The live Be heard screen (#8630) names the readers before the message field.
    const beHeard = read('../features/LiveFeatureScreens.tsx');
    const beHeardScreen = beHeard.slice(beHeard.indexOf('export function LiveBeHeardScreen('), beHeard.indexOf('// ---------------------------------------------------------------- Search'));
    const card = beHeardScreen.indexOf('<Card><Body>{BE_HEARD_READERS}</Body><Body muted>{BE_HEARD_RETENTION}</Body><Body muted>{BE_HEARD_URGENT_ROUTE}</Body></Card>');
    expect(card).toBeGreaterThan(0);
    expect(card).toBeLessThan(beHeardScreen.indexOf('accessibilityLabel="Your message"'));
  });
});

// REQ-UG-BE-HEARD-AND-INCIDENT-NOTE-RETENTION-SENTENCES-20261104:
// each retention sentence states what the schema does today, with no period.
describe('sensitive input retention', () => {
  const migrationsDir = '../../../../supabase/migrations/';
  const migrations = readdirSync(fileURLToPath(new URL(migrationsDir, import.meta.url))).filter((name) => name.endsWith('.sql')).sort();
  const mentioning = (pattern: RegExp) => migrations.filter((name) => pattern.test(read(`${migrationsDir}${name}`)));

  it('says Be heard reports are deleted with the account, as the reporter key cascades', () => {
    expect(read(`${migrationsDir}20260727211853_full_product_completion.sql`)).toContain('reporter_id uuid not null references auth.users(id) on delete cascade,');
    // A case opened from a report carries the reporter as its member and
    // cascades too, so the sentence cannot promise the case outlives the account.
    expect(read(`${migrationsDir}20260720191847_fresh_member_workflows.sql`)).toContain('user_id uuid not null references auth.users(id) on delete cascade,');
    // No later migration re-points either key; one that does must revisit the copy.
    expect(mentioning(/reporter_id_fkey|alter\s+column\s+reporter_id/i)).toEqual([]);
    expect(mentioning(/member_cases_user_id_fkey/i)).toEqual([]);
    expect(read('../../../../api/account-lifecycle.js')).toContain('should_soft_delete=false');
    expect(BE_HEARD_RETENTION).toBe('Reports you send are kept until you delete your account, which deletes them.');
  });

  it('says incident notes stay until the worker deletes them or the account', () => {
    expect(read(`${migrationsDir}20260829030000_member_support_programs.sql`)).toContain('member_user_id uuid not null references auth.users(id) on delete cascade,');
    expect(mentioning(/member_emergency_checklists_member_user_id_fkey/i)).toEqual([]);
    expect(INCIDENT_NOTES_RETENTION).toBe('Saved notes are kept until you delete them or delete your account.');
  });

  // This edition's legal documents are non-operative previews with no
  // retention schedule, so the sentences carry no time period of their own.
  it('states no time period', () => {
    for (const sentence of [BE_HEARD_RETENTION, INCIDENT_NOTES_RETENTION]) {
      expect(sentence).not.toMatch(/\d|day|week|month|year/i);
      expect(sentence).toContain('delete your account');
    }
  });

  it('shows each retention sentence under its reader statement', () => {
    const screen = read('../features/MemberSupportScreen.tsx');
    const notes = screen.indexOf('<TextInput accessibilityLabel="Private incident notes"');
    const readers = screen.indexOf('<Body muted>{INCIDENT_NOTES_READERS}</Body>');
    const retention = screen.indexOf('<Body muted>{INCIDENT_NOTES_RETENTION}</Body>');
    expect(readers).toBeGreaterThan(0);
    expect(retention).toBeGreaterThan(readers);
    expect(retention).toBeLessThan(notes);
    expect(read('../features/LiveFeatureScreens.tsx')).toContain('<Body>{BE_HEARD_READERS}</Body><Body muted>{BE_HEARD_RETENTION}</Body>');
  });
});
