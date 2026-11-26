// UX-UG-NATIVE-STAFF-DESKS-POLISH-BATCH-20261111 (#8302): the Home
// desk card speaks the saved member language on both phones, for every role,
// while the role check and the desk it opens stay the same.
import { createElement as h, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const state = vi.hoisted(() => ({ platform: 'ios', language: 'en' as 'en' | 'es', role: 'steward', push: [] as string[] }));
type Props = { children?: ReactNode; accessibilityLabel?: string; accessibilityHint?: string; onPress?: () => void };
vi.mock('react-native', () => {
  const Host = ({ children, accessibilityLabel, accessibilityHint, onPress }: Props) => {
    onPress?.();
    return h('div', { 'aria-label': accessibilityLabel, 'data-hint': accessibilityHint }, children);
  };
  return {
    Platform: { get OS() { return state.platform; } }, StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    View: Host, Text: Host, Pressable: (props: Props & { style?: unknown }) => Host(props),
  };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: (href: string) => { state.push.push(href); } }) }));
vi.mock('../../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('../../theme/ThemeProvider', async () => {
  const { resolveTheme } = await import('../../theme/tokens');
  return { useTheme: () => resolveTheme() };
});
vi.mock('../../state/AppProvider', () => ({
  useApp: () => ({
    memberLanguage: state.language, mode: 'authenticated', sessionRestricted: false, chosenStaffRole: null,
    authorizedRoles: [state.role], chapterRoles: [state.role], organizationRoles: [state.role],
  }),
}));
import { StaffDeskHomeCard } from './StaffDeskHomeCard';

const SPANISH: Record<string, { eyebrow: string; title: string; line: string }> = {
  steward: { eyebrow: 'ÁREA DE COMITÉ', title: 'Área del comité', line: 'Sus asuntos asignados, solicitudes de trabajadores, citas y formularios por revisar.' },
  coordinator: { eyebrow: 'ÁREA DE LÍDER DE LA CAMPAÑA', title: 'Cola de asuntos', line: 'Los asuntos de la campaña y sus plazos.' },
  advisor: { eyebrow: 'ÁREA DE ASESOR', title: 'Salud de la campaña', line: 'Participación, carga de trabajo y riesgo en todo la campaña.' },
  admin: { eyebrow: 'ÁREA DE ADMINISTRADOR', title: 'Administración del espacio de trabajo', line: 'Vea los servicios conectados de su campaña y su configuración.' },
  vp: { eyebrow: 'ÁREA DE PRESIDENTE', title: 'Resumen de la campaña', line: 'Tendencia, asuntos que requieren atención, lista de liderazgo y agenda.' },
};

describe.each(['ios', 'android'])('Home staff desk card on %s', (platform) => {
  it.each(Object.keys(SPANISH))('words the %s desk in Spanish and still opens that desk', (role) => {
    Object.assign(state, { platform, language: 'es', role, push: [] });
    const html = renderToStaticMarkup(h(StaffDeskHomeCard));
    const copy = SPANISH[role]!;
    for (const text of [copy.eyebrow, copy.title, copy.line, 'Abre su área.']) expect(html).toContain(text);
    expect(html).toContain(`aria-label="${copy.eyebrow}. ${copy.title}. ${copy.line}"`);
    expect(html).not.toContain(' DESK');
    expect(state.push).toEqual([`/feature/${role}`]);
  });

  it('keeps the English card for an English worker', () => {
    Object.assign(state, { platform, language: 'en', role: 'steward', push: [] });
    const html = renderToStaticMarkup(h(StaffDeskHomeCard));
    for (const text of ['COMMITTEE DESK', 'Committee desk', 'Your caseload, worker requests, one-on-ones and forms to review.', 'Opens your desk.']) expect(html).toContain(text);
  });
});
