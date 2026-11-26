import { createElement, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// A11Y-UG-NATIVE-STAFF-CASE-QUEUE-ROWS-SPEAK-ONLY-THE-REFERENCE-20261109:
// a staff case queue row was announced only as "Open GR-2026-81524". The
// mobile lane has no React Native renderer, so the native host is replaced by
// a plain element that carries the accessibility props it receives. That a
// row in the staff and member case lists opens its case when pressed is
// executed on the shared stand-in in src/features/caseRowOpens.screen.test.tsx.

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as {
  renderToStaticMarkup: (element: ReactNode) => string;
};

type HostProps = { children?: ReactNode; accessibilityRole?: string; accessibilityLabel?: string; accessibilityHint?: string };

vi.mock('react-native', () => ({
  Pressable: ({ children, accessibilityRole, accessibilityLabel, accessibilityHint }: HostProps) => createElement(
    'button',
    { 'data-role': accessibilityRole, 'aria-label': accessibilityLabel, 'data-hint': accessibilityHint },
    typeof children === 'function' ? null : children,
  ),
}));

const { CaseRowPressable } = await import('./CaseRowPressable');

function attribute(markup: string, name: string): string | undefined {
  return markup.match(new RegExp(`${name}="([^"]*)"`))?.[1]?.replaceAll('&amp;', '&');
}

describe('issue queue row', () => {
  it('is named by its visible reference, status, issue line and updated time', () => {
    const markup = renderToStaticMarkup(createElement(CaseRowPressable, {
      reference: 'GR-2026-81524',
      visible: ['Active', 'Discipline · Arbitration', 'Updated Nov 9, 2026 · 8:05 AM ET'],
      onPress: () => undefined,
    }));
    expect(attribute(markup, 'aria-label')).toBe('GR-2026-81524, Active, Discipline · Arbitration, Updated Nov 9, 2026 · 8:05 AM ET');
    expect(attribute(markup, 'data-role')).toBe('button');
    expect(attribute(markup, 'data-hint')).toBe('Opens the issue.');
  });

  it('starts with the visible reference and skips parts a row does not show', () => {
    const markup = renderToStaticMarkup(createElement(CaseRowPressable, {
      reference: 'GR-2026-41960',
      visible: ['Pay · Step 1', null, '  '],
      onPress: () => undefined,
    }));
    expect(attribute(markup, 'aria-label')).toBe('GR-2026-41960, Pay · Step 1');
  });
});
