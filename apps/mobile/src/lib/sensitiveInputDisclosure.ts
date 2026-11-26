// REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103 (audit
// MOB-STEWARD-07, MOB-COORDINATOR-06, MOB-ADVISOR-06/-07, MOB-VP-06/-07): Be
// heard, private incident notes and "Alert a steward now" named no reader and
// no urgent route. Each sentence states who can read the record, taken from
// the policy or RPC that serves it.
//
// REQ-UG-BE-HEARD-AND-INCIDENT-NOTE-RETENTION-SENTENCES-20261104
// (owner, Nov 4, 2026: say what is true today, with no time limit): one
// retention sentence under each reader statement, matching the retention
// schedule's "private workflows ... removed ... when account deletion
// completes". No timer removes either record.

// member_intake_reports_read (20260812092000_intake_triage_conversion.sql):
// the reporter, plus stewards and coordinators of the reporter's chapter.
export const BE_HEARD_READERS = 'Who can read these reports: you, and the committee members and campaign leads of your campaign.';

// member_intake_reports.reporter_id is NOT NULL and references auth.users on
// delete cascade (20260727211853_full_product_completion.sql), and account
// deletion removes the auth user, so deleting the account deletes the reports.
// A case opened from a report carries the reporter in member_cases.user_id,
// which cascades the same way, so no sentence says the case outlives the account.
export const BE_HEARD_RETENTION = 'Reports you send are kept until you delete your account, which deletes them.';

// get_member_support_workspace returns a checklist to its member, and to
// staff (private.member_support_is_staff: steward, coordinator, advisor,
// admin, president) only while its status is alerted.
export const INCIDENT_NOTES_READERS = 'Only you can read saved notes. If you alert a committee member, your organization’s committee members, campaign leads, advisors, admins and campaign chair can read this checklist and these notes until the alert is resolved.';

// member_emergency_checklists.member_user_id references auth.users on delete
// cascade (20260829030000_member_support_programs.sql); the member can clear
// the notes field and save at any time.
export const INCIDENT_NOTES_RETENTION = 'Saved notes are kept until you delete them or delete your account.';

export const NOT_FOR_EMERGENCIES = 'This is not an emergency service. If anyone is in danger, call 911.';

export const BE_HEARD_URGENT_ROUTE = `${NOT_FOR_EMERGENCIES} For an urgent problem at work, message the committee from Messages.`;

export type SensitiveConfirmation = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
};

export const STEWARD_ALERT_CONFIRMATION: SensitiveConfirmation = {
  title: 'Alert a committee member now?',
  body: 'Your organization’s committee members, campaign leads, advisors, admins and campaign chair will see an urgent committee member request with this checklist and your notes. If anyone is in danger, call 911 first.',
  confirmLabel: 'Send alert',
  cancelLabel: 'Not yet',
};
