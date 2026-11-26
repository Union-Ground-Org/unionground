export type StaffDeskHat = 'steward' | 'coordinator' | 'advisor' | 'admin' | 'vp';
export const STAFF_DESK_HATS: readonly StaffDeskHat[] = ['steward', 'coordinator', 'advisor', 'admin', 'vp'];

export function deskPathForHat(hat: string): string {
  return `/feature/${hat}`;
}

export function isSameDeskSection(section: { key: string; href: string }, hat: string): boolean {
  return section.href === deskPathForHat(hat)
    && section.key !== hat
    && section.key.startsWith(`${hat}-`);
}

export function sameDeskSections<T extends { key: string; href: string }>(
  hat: string,
  functions: readonly T[],
): T[] {
  return functions.filter((item) => isSameDeskSection(item, hat));
}
