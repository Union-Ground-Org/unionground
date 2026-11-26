// Issue intelligence on the phone (REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001).
// Member banner only: the server returns the member-safe projection (family
// and thread key), decides whether the feature is on and enforces the privacy
// floor. Copy restored from the old app's lib/issue-threads/privacy.ts and
// output.ts. Native is English-only (owner ruling).

export type IssueFamily = 'contract_rights_confusion' | 'retaliation_protected_activity_pressure';

export type MemberIssueSignal = {
  family: IssueFamily;
  threadKey: string;
};

export type IssueGuidanceLink = {
  kind: string;
  title: string;
  description: string;
  route: string;
};

export type IssueSignalCopy = {
  headline: string;
  reason: string;
  whatItIs: string;
  whyItMatters: string;
  guidance: IssueGuidanceLink[];
};

const FAMILY_ORDER: IssueFamily[] = ['retaliation_protected_activity_pressure', 'contract_rights_confusion'];
const THREAD_KEYS: Record<IssueFamily, string> = {
  retaliation_protected_activity_pressure: 'retaliation-protected-activity-pressure',
  contract_rights_confusion: 'contract-rights-confusion',
};

function isIssueFamily(value: unknown): value is IssueFamily {
  return value === 'contract_rights_confusion' || value === 'retaliation_protected_activity_pressure';
}

// Strict reader: anything unexpected is dropped, and only the family survives,
// so staff detail can never reach the member banner.
export function normalizeMemberIssueSignals(payload: unknown): MemberIssueSignal[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const input = payload as Record<string, unknown>;
  const rawSignals: unknown = input.signals;
  if (input.enabled !== true || !Array.isArray(rawSignals)) return [];
  const list: readonly unknown[] = rawSignals;
  const families = new Set<IssueFamily>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const family: unknown = (raw as Record<string, unknown>).family;
    if (isIssueFamily(family)) families.add(family);
  }
  return FAMILY_ORDER.filter((family) => families.has(family)).map((family) => ({ family, threadKey: THREAD_KEYS[family] }));
}

const COPY: Record<IssueFamily, IssueSignalCopy> = {
  contract_rights_confusion: {
    headline: 'Questions about organizing rights are coming up often.',
    reason: 'This may be a good time to review your rights, available guidance, and next steps.',
    whatItIs: 'You may need clearer guidance about your rights, protections, or the workplace process involved in this concern.',
    whyItMatters: 'Reviewing the right explanation and next-step guidance can make it easier to decide what to do next.',
    guidance: [
      { kind: 'rights_explainer', title: 'Organizing Rights', description: 'Plain-language explainers for the most common organizing rights and protections.', route: '/feature/rights' },
      { kind: 'faq', title: 'Q&A: active discussions', description: 'See what other workers are asking and how these questions are being answered.', route: '/feature/qa' },
      { kind: 'checklist', title: 'What to do next', description: 'Step-by-step help for writing down what happened and finding qualified help.', route: '/feature/member-support' },
    ],
  },
  retaliation_protected_activity_pressure: {
    headline: 'You may be dealing with protected-activity pressure.',
    reason: 'Several recent signals suggest it may help to review support options and next steps.',
    whatItIs: 'You may be dealing with pressure, discipline concerns, or other treatment connected to a protected workplace concern.',
    whyItMatters: 'Reviewing your rights, documenting what happened, and choosing a safe next step can help you decide what support you need.',
    guidance: [
      { kind: 'rights_explainer', title: 'Organizing Rights', description: 'Review core protections around protected activity, discipline, and organizing together.', route: '/feature/rights' },
      { kind: 'report_path', title: 'Report what happened', description: 'Open your issue to write down what happened so the committee can follow up quickly.', route: '/feature/cases' },
      { kind: 'checklist', title: 'Emergency checklist', description: 'If a manager asks about the campaign, write down what happened and talk with an organizer.', route: '/feature/member-support' },
      { kind: 'form', title: 'Helpful forms', description: 'Open common forms that help you capture facts, timelines, and follow-up needs.', route: '/feature/forms' },
    ],
  },
};

export function issueSignalCopy(signal: MemberIssueSignal): IssueSignalCopy {
  return COPY[signal.family];
}
