import { useMemo, useRef } from 'react';

// Opening earlier history adds rows above the reader. The scroll position
// moves by the added height, so the message on screen stays on screen. The
// loading state above the messages changes the height before the rows
// arrive: the position follows that too, and the anchor lasts while the read
// is loading, through the layout that lands it (or shows its failure). A new
// latest message is not above the reader: the screen's own rule for it applies.

export type PrependLayout = 'moved' | 'pending' | 'unchanged' | 'changed';

export type PrependAnchor = {
  /** The reader's scroll position changed. */
  scrolled(y: number): void;
  /** Show earlier was pressed while `newest` was the latest row shown. */
  mark(newest: string | null): void;
  /**
   * The content height is now `height`. 'moved' when the anchor moved the
   * reader, 'pending' while it waits unchanged; otherwise whether the height
   * changed, for the screen's own rules.
   */
  laidOut(height: number, now: { newest: string | null; loading: boolean; scrollTo: (y: number) => void }): PrependLayout;
};

type AnchorState = { y: number; height: number; anchor: { y: number; height: number; newest: string | null } | null };

export function usePrependAnchor(): PrependAnchor {
  const state = useRef<AnchorState>({ y: 0, height: 0, anchor: null });
  return useMemo(() => ({
    scrolled(y: number) {
      state.current.y = y;
    },
    mark(newest: string | null) {
      const current = state.current;
      current.anchor = { y: current.y, height: current.height, newest };
    },
    laidOut(height: number, { newest, loading, scrollTo }: { newest: string | null; loading: boolean; scrollTo: (y: number) => void }): PrependLayout {
      const current = state.current;
      const previousHeight = current.height;
      current.height = height;
      let anchor = current.anchor;
      if (anchor && newest !== anchor.newest) anchor = current.anchor = null;
      if (anchor && height !== anchor.height) {
        const y = Math.max(0, anchor.y + height - anchor.height);
        current.anchor = loading ? { ...anchor, y, height } : null;
        scrollTo(y);
        return 'moved';
      }
      if (anchor) return 'pending';
      return height === previousHeight ? 'unchanged' : 'changed';
    },
  }), []);
}
