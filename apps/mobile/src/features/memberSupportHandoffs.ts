const HANDOFF_INITIATOR_HATS = Object.freeze([
  'steward',
  'coordinator',
  'admin',
  'vp',
]);

const HANDOFF_OVERSIGHT_HATS = Object.freeze([
  'coordinator',
  'advisor',
  'admin',
  'vp',
]);

export type MemberHandoffStatus = 'pending' | 'acknowledged' | 'declined' | 'cancelled';

export type MemberHandoff = {
  id: string;
  memberId: string;
  memberName: string;
  initiatedBy?: string | null;
  fromStewardId?: string | null;
  fromStewardName: string;
  toStewardId?: string | null;
  toStewardName: string;
  direction: 'incoming' | 'outgoing' | 'overseen';
  status: MemberHandoffStatus;
  note: string;
  canAcknowledge: boolean;
  canDecline: boolean;
  canCancel: boolean;
  createdAt: string | null;
};

export type HandoffPerson = { userId: string; displayName: string };

export type PreviewHandoffDirectoryPerson = {
  userId: string;
  label: string;
  chapterId: string | null;
  roles?: readonly string[];
  switchablePreviewHat?: boolean;
};

type PreviewHandoffActions = {
  status: string;
  direction?: MemberHandoff['direction'];
  initiatedBy?: string | null;
  fromStewardId?: string | null;
  toStewardId?: string | null;
  canAcknowledge: boolean;
  canDecline: boolean;
  canCancel: boolean;
};

let previewHandoffStore: MemberHandoff[] | null = null;

function cloneHandoffs(items: readonly MemberHandoff[]): MemberHandoff[] {
  return items.map((item) => ({ ...item }));
}

export function readPreviewHandoffs(seed: readonly MemberHandoff[]): MemberHandoff[] {
  if (previewHandoffStore === null) previewHandoffStore = cloneHandoffs(seed);
  return cloneHandoffs(previewHandoffStore);
}

export function updatePreviewHandoffs(
  seed: readonly MemberHandoff[],
  update: (current: MemberHandoff[]) => readonly MemberHandoff[],
): MemberHandoff[] {
  previewHandoffStore = cloneHandoffs(update(readPreviewHandoffs(seed)));
  return cloneHandoffs(previewHandoffStore);
}

export function resetPreviewHandoffs(): void {
  previewHandoffStore = null;
}

export function searchPreviewHandoffPeople(
  kind: 'member' | 'steward',
  query: string,
  directory: readonly PreviewHandoffDirectoryPerson[],
): HandoffPerson[] {
  const normalized = query.trim().toLocaleLowerCase();
  return directory
    .filter((person) => kind === 'member' || (
      person.roles?.includes('steward') && person.switchablePreviewHat === true
    ))
    .filter((person) => person.label.toLocaleLowerCase().includes(normalized))
    .map((person) => ({ userId: person.userId, displayName: person.label }));
}

export function canInitiateMemberHandoff(
  organizationRoles: readonly string[],
): boolean {
  return organizationRoles.some((role) => HANDOFF_INITIATOR_HATS.includes(role));
}

export function scopePreviewHandoffActions<T extends PreviewHandoffActions>(
  items: readonly T[],
  viewerUserId: string | null,
  selectedHat: string,
): T[] {
  const canOversee = HANDOFF_OVERSIGHT_HATS.includes(selectedHat);
  return items.filter((item) => Boolean(
    canOversee
      || (viewerUserId && (
        item.initiatedBy === viewerUserId
        || item.toStewardId === viewerUserId
        || item.fromStewardId === viewerUserId
      )),
  )).map((item) => {
    const pending = item.status === 'pending';
    const receivingSteward = Boolean(viewerUserId && item.toStewardId === viewerUserId);
    const initiatingViewer = Boolean(viewerUserId && item.initiatedBy === viewerUserId);
    const outgoingViewer = Boolean(viewerUserId && (
      item.initiatedBy === viewerUserId || item.fromStewardId === viewerUserId
    ));
    return {
      ...item,
      direction: receivingSteward ? 'incoming' : outgoingViewer ? 'outgoing' : 'overseen',
      canAcknowledge: pending && receivingSteward,
      canDecline: pending && receivingSteward,
      canCancel: pending && (initiatingViewer || canOversee),
    };
  });
}
