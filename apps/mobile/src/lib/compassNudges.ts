// REQ-UG-COMPASS-CONTEXTUAL-NUDGES-20261001, native half. The phone
// Compass panel is the member assistant, so it shows the member's own
// retaliation-flag nudge (old de7df4b57c^ lib/claude/contextual-nudges.ts).
// Choosing it only fills the composer with a product-authored starter
// question.
import { isFeatureEnabled, type OrganizationSwitchConfiguration } from './featureSwitches';

export type CompassNudge = { id: 'retaliation-flag'; label: string; prompt: string; urgent: boolean };

export function contextualNudgesEnabled(configuration: OrganizationSwitchConfiguration): boolean {
  return Boolean(configuration)
    && isFeatureEnabled(configuration, 'features.ai_assistant.enabled', true)
    && isFeatureEnabled(configuration, 'features.ai_assistant.contextual_nudges', false);
}

export function memberNudgesFrom(payload: unknown): CompassNudge[] {
  if (!payload || typeof payload !== 'object' || (payload as { enabled?: unknown }).enabled !== true) return [];
  const rows: unknown = (payload as { member?: unknown }).member;
  const list: readonly unknown[] = Array.isArray(rows) ? (rows as readonly unknown[]) : [];
  return list.flatMap((row) => {
    const record = row && typeof row === 'object' ? row as { id?: unknown; count?: unknown } : null;
    if (record?.id !== 'retaliation-flag' || typeof record.count !== 'number' || record.count < 1) return [];
    return [{
      id: 'retaliation-flag' as const,
      label: 'Open retaliation report',
      prompt: 'I reported retaliation at work. What should I do while it is reviewed?',
      urgent: true,
    }];
  });
}
