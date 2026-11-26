# Member support donor provenance

CR-079 through CR-083 use the approved donor commit
`donor-baseline-20260721` as behavior evidence only.

Screened donor paths:

- `app/dashboard/accommodation/actions.ts`
- `app/dashboard/mentorship/actions.ts`
- `app/dashboard/onboarding/actions.ts`
- `app/m/rights/RightsScreen.tsx`
- `lib/union-ground/accommodation.ts`
- `lib/union-ground/hr-contact.ts`
- `lib/union-ground/onboarding.ts`
- `lib/union-ground/rights.ts`
- the donor migrations that mention `emergency_checklists`,
  `accommodation_requests`, `onboarding_progress`, or `mentorship_pairs`

Behavior retained and adapted:

- member-owned emergency checklist progress plus an explicit urgent-alert
  transition;
- structured accommodation intake, member withdrawal, staff lifecycle, and
  bounded aggregate counts;
- a configured HR directory plus structured contact history;
- organization-defined onboarding steps, a member-owned plan, ordered
  completion, and staff oversight;
- mentorship pair lifecycle, participant notes, goals, and outcomes.

Rejected donor material:

- agency identifiers as tenant authority or any caller-supplied organization
  scope;
- service-role reads for user-facing aggregates;
- legacy Next.js server actions, route structure, dependencies, credentials,
  project identifiers, and migration history;
- hard-coded organization identities, contacts, or affiliation copy;
- seeded tenants, users, onboarding assignments, or provider credentials in
  production;
- protected record content copied into notifications, messages, tasks, logs,
  exports, or audit metadata;
- raw colors and fixed organization-specific visual labels.

The current implementation derives organization and user identity from the
authenticated session, keeps production valid with zero organizations, uses
the same RPC/RLS paths on SaaS and SAMPLE origins, and seeds realistic fictional
records only through the SAMPLE-only backend seed.
