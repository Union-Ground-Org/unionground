// REQ-UNION-BASE-MULTI-CHAPTER-MEMBERSHIP-20260818, finding F3 (lanes ANDROID6
// and IPHONE7, 2026-09-26): the authenticated Home rendered no chapter rail.
// ChapterRail already implements the live branch (every active membership,
// search over name and region, pinned first, current/switch labels, the calm
// single-chapter note), but only PrototypeHome mounted it, so on SAMPLE the
// switcher was unreachable and acceptance items 1 to 4 could not be
// exercised from the phone. AuthenticatedHome now carries a chapter identity
// control that opens the rail; this module decides what that control says.
//
// A single-membership account gets a calm identity, never a fake picker; an
// account with no active membership says so honestly (the rail explains that
// an administrator can add them to one).

export type ChapterIdentitySource = {
  name: string;
  region: string | null;
  selected: boolean;
};

export type ChapterIdentityPresentation = {
  title: string;
  subtitle: string;
  accessibilityLabel: string;
  accessibilityHint: string;
};

const OPEN_RAIL_HINT = 'Opens the campaign rail';

// CONTENT-UG-NATIVE-CHAPTERLESS-RESTORE-ACCESS-20261018: a member who
// was never in a chapter has nothing to "restore", and SCIM and founder
// invitations have no human inviter to name, so the organization's
// administrator is the contact. Home and the rail share this one sentence.
export const NO_CHAPTER_SUBTITLE = 'You\u2019re not in a campaign yet. Your campaign administrator can add you to one.';

export function chapterIdentityPresentation(
  memberships: readonly ChapterIdentitySource[],
  language: 'en' | 'es' = 'en',
): ChapterIdentityPresentation {
  const spanish = language === 'es';
  const hint = spanish ? 'Abre la lista de campañas' : OPEN_RAIL_HINT;
  // A nonbreaking space before each dot keeps the separator on the previous
  // line. Text can still wrap after it, including at the largest text size.
  const separator = '\u00a0· ';
  if (memberships.length === 0) {
    return {
      title: spanish ? 'Sin membresía activa en una campaña' : 'No active campaign membership',
      subtitle: spanish ? 'Aún no perteneces a una campaña. El administrador de tu organización puede agregarte a uno.' : NO_CHAPTER_SUBTITLE,
      accessibilityLabel: spanish ? 'Campaña, sin membresía activa' : 'Campaign, no active membership',
      accessibilityHint: hint,
    };
  }
  const current = memberships.find((chapter) => chapter.selected) ?? null;
  if (memberships.length === 1) {
    const only = memberships[0] ?? null;
    const name = only?.name ?? (spanish ? 'Tu campaña' : 'Your campaign');
    const region = only?.region ?? null;
    return {
      title: name,
      subtitle: [spanish ? 'Tu campaña' : 'Your campaign', ...(region ? [region] : [])].join(separator),
      accessibilityLabel: spanish ? `Campaña, ${name}, campaña actual` : `Campaign, ${name}, current campaign`,
      accessibilityHint: hint,
    };
  }
  const count = spanish ? `${memberships.length} campañas autorizados` : `${memberships.length} authorized campaigns`;
  if (!current) {
    return {
      title: spanish ? 'Elige una campaña' : 'Choose a campaign',
      subtitle: count,
      accessibilityLabel: spanish ? `Campaña, ninguno seleccionado, ${count}` : `Campaign, none selected, ${count}`,
      accessibilityHint: hint,
    };
  }
  return {
    title: current.name,
    subtitle: [spanish ? 'Campaña actual' : 'Current campaign', ...(current.region ? [current.region] : []), count].join(separator),
    accessibilityLabel: spanish ? `Campaña, ${current.name}, campaña actual, ${count}` : `Campaign, ${current.name}, current campaign, ${count}`,
    accessibilityHint: hint,
  };
}
