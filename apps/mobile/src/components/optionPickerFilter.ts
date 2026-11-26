// Pure filtering/bounding logic for the OptionPicker primitive. Kept free of
// react-native imports so the behaviour — search matching, selection pinning,
// collision-safe member detail, and the hard cap on mounted option rows — is
// unit-testable in plain vitest.
export type OptionPickerChoice = {
  id: string;
  label: string;
  detail?: string | null;
};

export type RelationshipMemberNode = {
  id: string;
  label: string;
  roleLabel?: string | null;
  chapterId?: string | null;
};

// Hard ceiling on option rows the picker mounts at once. Organization
// snapshots can carry up to 5,000 relationship nodes; rendering every member
// as a control inside Screen's non-virtualized ScrollView (the picker is
// instantiated twice on the Neuro Map write card) would synchronously mount
// ~10,000 controls, so large rosters are searched and bounded instead.
export const OPTION_PICKER_MAX_VISIBLE = 50;

export function optionPickerSearchNeedle(query: string, optionCount: number): string {
  return optionCount > OPTION_PICKER_MAX_VISIBLE ? query : '';
}

function memberDetail(
  node: RelationshipMemberNode,
  chapterNameById: ReadonlyMap<string, string>,
): string | null {
  const chapter = node.chapterId
    ? (chapterNameById.get(node.chapterId) || node.chapterId)
    : null;
  const parts = [node.roleLabel, chapter].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' · ') : null;
}

// Role + chapter (chart label, else the snapshot chapter id) plus a stable
// ordinal when that pair still collides. Two active profiles may share
// full_name, role_line, and chapter_id, and a chapter chart node is optional
// user-authored data, so the ordinal is the guaranteed non-secret discriminator.
export function buildMemberPickerOptions(
  nodes: readonly RelationshipMemberNode[],
  chapterNameById: ReadonlyMap<string, string>,
): OptionPickerChoice[] {
  const drafted = nodes.map((node) => ({
    id: node.id,
    label: node.label,
    baseDetail: memberDetail(node, chapterNameById),
  }));
  const groups = new Map<string, string[]>();
  for (const row of drafted) {
    const key = `${row.label}\0${row.baseDetail ?? ''}`;
    const ids = groups.get(key);
    if (ids) ids.push(row.id);
    else groups.set(key, [row.id]);
  }
  const ordinalById = new Map<string, string>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const sorted = [...ids].sort();
    sorted.forEach((id, index) => {
      ordinalById.set(id, `${index + 1} of ${sorted.length}`);
    });
  }
  return drafted.map((row) => {
    const ordinal = ordinalById.get(row.id);
    const detail = [row.baseDetail, ordinal].filter(Boolean).join(' · ') || null;
    return { id: row.id, label: row.label, detail };
  });
}

export function filterOptionPickerOptions(
  options: readonly OptionPickerChoice[],
  needle: string,
  selectedId: string,
): { visible: OptionPickerChoice[]; total: number } {
  const query = needle.trim().toLowerCase();
  const matches = query
    ? options.filter((option) => `${option.label} ${option.detail ?? ''}`.toLowerCase().includes(query))
    : options.slice();
  const selected = selectedId ? options.find((option) => option.id === selectedId) : undefined;
  const selectedMatchIndex = selected ? matches.findIndex((option) => option.id === selected.id) : -1;
  // Pin the current selection at the front whenever it would fall outside the
  // mounted slice — including when it matches the query but sits past the cap
  // (search-then-clear of member-99 in a 100-row roster) and when it does not
  // match the query at all.
  let ranked = matches;
  if (selected && (selectedMatchIndex === -1 || selectedMatchIndex >= OPTION_PICKER_MAX_VISIBLE)) {
    ranked = [selected, ...matches.filter((option) => option.id !== selected.id)];
  }
  return { visible: ranked.slice(0, OPTION_PICKER_MAX_VISIBLE), total: ranked.length };
}
