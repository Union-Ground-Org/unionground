import { nativeHomeAttentionCopy, nativeCaseDeadlineCopy } from './nativeHomeCopy';
import { caseDeadlinePhrase } from '../../../../src/lib/caseNextDeadline.js';
import { type WhatMattersItem } from './whatMattersShared';
import { type NativeLanguage } from './nativeUiCopy';

// Where a member answers the surveys open to them on the phone.
export const MEMBER_SURVEYS_HREF = '/feature/voting';

export type WhatMattersCopy = { reason: string; line: string; meta: string | null; action: string | null; href: string | null };

export function whatMattersCopy(item: WhatMattersItem, language: NativeLanguage = 'en'): WhatMattersCopy {
  const catalogue: Record<string, string> = { ...nativeHomeAttentionCopy[language], ...nativeCaseDeadlineCopy[language] };
  const tr = (key: string, values: Record<string, unknown> = {}) => (catalogue[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
  const shortDate = (value: string | null, taskDate = false) => {
    if (!value) return '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(language === 'es' ? 'es-US' : 'en-US', { month: 'short', day: 'numeric', year: taskDate && date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }).format(date) : '';
  };
  const deadlineOn = (date: string | null, key = 'whatMatters.deadlineOn') => date ? tr(key, { date: shortDate(date, key === 'whatMatters.taskDueOn') }) : null;
  const stepOn = (value: { deadline: string | null; deadlineLabel?: string }) => value.deadline ? tr('whatMatters.stepDeadlineOn', { label: value.deadlineLabel || tr('caseSignals.deadline.stepFallback'), date: shortDate(value.deadline) }) : null;
  const caseName = (value: { reference: string | null; title: string }) => value.reference ?? (value.title || tr('whatMatters.yourCase'));
  switch (item.kind) {
    case 'filing_deadline': {
      if (item.deadlineKind === 'step' && item.deadline) return {
        reason: tr(item.days < 0 ? 'whatMatters.reasonStepPassed' : 'whatMatters.reasonStep'),
        line: tr('whatMatters.lineStep', { case: caseName(item.case), deadline: caseDeadlinePhrase(tr, { kind: 'step', label: item.deadlineLabel ?? null, days: item.days, dueOn: item.deadline }, language) }),
        meta: [item.case.step, stepOn(item)].filter(Boolean).join(' · ') || null,
        action: tr('whatMatters.actionReviewCase'), href: `/issue/${item.action.caseId}`,
      };
      const when = tr(item.days < 0 ? Math.abs(item.days) === 1 ? 'whatMatters.daysOverdueOne' : 'whatMatters.daysOverdue' : item.days === 0 ? 'whatMatters.dueToday' : item.days === 1 ? 'whatMatters.dueTomorrow' : 'whatMatters.dueInDays', { count: Math.abs(item.days) });
      // BUG-UG-NATIVE-OVERDUE-FILING-DEADLINE-READS-COMING-UP-20261120:
      // a deadline already behind the member is passed, not coming up (the
      // native half of #7398, which fixed only the web card).
      return { reason: tr(item.days < 0 ? 'whatMatters.reasonFilingPassed' : 'whatMatters.reasonFiling'), line: tr('whatMatters.lineFiling', { when, case: caseName(item.case) }), meta: [item.case.step, deadlineOn(item.deadline)].filter(Boolean).join(' · ') || null, action: tr('whatMatters.actionReviewCase'), href: `/issue/${item.action.caseId}` };
    }
    case 'case_in_progress':
      return { reason: tr('whatMatters.reasonCase'), line: tr('whatMatters.lineCase', { case: item.case.reference ?? (item.case.title || (language === 'es' ? 'Su caso' : 'Your issue')) }), meta: [item.case.step, item.deadlineKind === 'step' ? stepOn(item) : deadlineOn(item.deadline)].filter(Boolean).join(' · ') || null, action: tr('whatMatters.actionReviewCase'), href: `/issue/${item.action.caseId}` };
    case 'assigned_task': {
      const when = tr(item.days < 0 ? Math.abs(item.days) === 1 ? 'whatMatters.daysOverdueOne' : 'whatMatters.daysOverdue' : item.days === 0 ? 'whatMatters.dueToday' : item.days === 1 ? 'whatMatters.dueTomorrow' : 'whatMatters.dueInDays', { count: Math.abs(item.days) });
      return {
        reason: tr(item.days < 0 ? 'whatMatters.reasonTaskOverdue' : 'whatMatters.reasonTask'),
        line: tr('whatMatters.lineTask', { task: item.task.title, when }),
        meta: deadlineOn(item.deadline, 'whatMatters.taskDueOn'),
        action: tr('whatMatters.actionTask'),
        // The task and its conversation with the person who assigned it.
        href: `/task-conversation/${item.action.taskId}`,
      };
    }
    case 'open_vote':
      return { reason: tr('whatMatters.reasonVote'), line: item.ballot.title, meta: deadlineOn(item.ballot.closesAt, 'whatMatters.closesOn'), action: tr('whatMatters.actionVote'), href: '/feature/voting' };
    case 'rsvp':
      return { reason: tr('whatMatters.reasonRsvp'), line: item.event.title, meta: shortDate(item.event.startsAt), action: tr('whatMatters.actionRsvp'), href: '/feature/events' };
    case 'open_survey':
      return {
        reason: tr('whatMatters.reasonSurvey'),
        line: item.survey.title,
        meta: deadlineOn(item.survey.closesAt, 'whatMatters.closesOn'),
        action: tr('whatMatters.actionSurvey'),
        // The survey questions render under Voting (LiveSurveyHistory); a
        // signed-in /feature/voice is Be heard, which has no survey list
        // (BUG-UG-OPEN-SURVEY-UNREACHABLE-FROM-HOME-AND-PHONE-20261111).
        href: MEMBER_SURVEYS_HREF,
      };
    case 'unread_notice':
      return { reason: tr(item.unread === 1 ? 'whatMatters.reasonNoticeOne' : 'whatMatters.reasonNotice', { count: item.unread }), line: item.notice.title, meta: null, action: tr('whatMatters.actionNotice'), href: '/messages' };
    default:
      return { reason: language === 'es' ? tr('whatMatters.reasonCaughtUp') : 'You’re caught up', line: tr('whatMatters.lineCaughtUp'), meta: null, action: null, href: null };
  }
}
