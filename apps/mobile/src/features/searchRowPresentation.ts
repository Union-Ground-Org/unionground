export type SearchRowItem = {
  id: string;
  title: string;
  body: string;
  href?: string;
};

export type SearchRowPresentation =
  | {
      kind: 'pressable';
      href: string;
      accessibilityRole: 'button';
      accessibilityLabel: string;
    }
  | {
      kind: 'static';
      accessibilityRole: undefined;
      accessibilityLabel: string;
    };

function staticVoiceOverLabel(item: SearchRowItem): string {
  return item.body ? `${item.title}. ${item.body}` : item.title;
}

/** Decide whether a search result is a real destination or a static reading. */
export function presentSearchRow(item: SearchRowItem): SearchRowPresentation {
  if (item.href) {
    return {
      kind: 'pressable',
      href: item.href,
      accessibilityRole: 'button',
      accessibilityLabel: item.title,
    };
  }
  return {
    kind: 'static',
    accessibilityRole: undefined,
    accessibilityLabel: staticVoiceOverLabel(item),
  };
}

/** Push only when the row actually has a destination. Hrefless rows no-op. */
export function pressSearchRow(
  row: SearchRowPresentation,
  push: (href: string) => void,
): void {
  if (row.kind !== 'pressable') return;
  push(row.href);
}
