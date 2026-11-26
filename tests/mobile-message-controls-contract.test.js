// @vitest-environment node
//
// BUG-UG-NATIVE-MESSAGE-INERT-CONTROLS-20260904.
//
// This is a STANDING class check, not a point fix for the three controls the
// record named. The same defect — a visible affordance with no handler — already
// regressed once as BUG-UNION-GROUND-NATIVE-OWNER-CORRECTION-20260824, so the
// guard scans every Pressable in the messaging screens and requires role, label
// and handler (or an explicit disabled/expanded state) on each, and it fails on
// any bare View that renders a control-shaped glyph.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");

const SCREENS = [
  "apps/mobile/app/channel/[id].tsx",
  "apps/mobile/app/conversation/[id].tsx",
];

// UX-UG-MOBILE-CHANNEL-SEND-GLYPH-PROMISES-VOICE-NOTE-20260920. A third
// composer sends a message: the Messages screen opens a new conversation from
// its own send control. Union Ground's five-tab dock has no Messages tab, so
// the screen lives at app/messages.tsx. The class scans above stay on the two message threads, but
// a send button that promises a capability its screen does not have is the same
// defect wherever it renders, so the send-control guards cover all three.
const COMPOSER_SCREENS = [
  ...SCREENS,
  "apps/mobile/app/messages.tsx",
];

// Icon names that read as an action rather than as decoration. A glyph from this
// list outside a Pressable is the exact defect: it looks tappable and is not.
const ACTION_GLYPHS = [
  "add", "attach", "camera", "chevron-forward", "create", "ellipsis-horizontal",
  "paper-plane", "pencil", "share", "trash",
];

// Split a source file into JSX elements of one tag, balanced enough for a
// contract scan: from `<Tag` to the matching `>` that closes the opening tag.
function openingTags(source, tag) {
  const results = [];
  const marker = `<${tag}`;
  let index = source.indexOf(marker);
  while (index !== -1) {
    let depth = 0;
    let cursor = index + marker.length;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === ">" && depth === 0) break;
      cursor += 1;
    }
    results.push(source.slice(index, cursor + 1));
    index = source.indexOf(marker, cursor);
  }
  return results;
}

// Index of the last match of a global pattern, or -1. String.lastIndexOf only
// takes a literal, and "styles.send" is a prefix of "styles.sender".
function lastMatchIndex(source, pattern) {
  let last = -1;
  for (const match of source.matchAll(pattern)) last = match.index;
  return last;
}

// The glyphs a send control renders: every <Ionicons name=…> whose nearest
// preceding landmark is the send button's style rather than the end of some
// other control.
function sendControlGlyphs(source) {
  return [...source.matchAll(/<Ionicons\s+name=(\{[^}]*\}|"[^"]*")/g)]
    .filter((match) => {
      const before = source.slice(Math.max(0, match.index - 700), match.index);
      return lastMatchIndex(before, /styles\.send\b/g) > before.lastIndexOf("</Pressable>");
    })
    .map((match) => match[1]);
}

// `name="add"` and `name={pickerOpen ? 'close' : 'happy-outline'}` are both
// shapes the screens render, so the scan has to read an expression's quoted
// sub-literals as names too — a glyph hidden behind a ternary is still a glyph.
const ICON_NAME = /name=(?:(["'`])((?:(?!\1).)*?)\1|\{([^{}]*)\})/g;
const QUOTED_LITERAL = /(["'`])((?:(?!\1).)*?)\1/g;

// How far back a glyph's enclosing markup is looked for. Wide enough to clear a
// multi-line opening tag, narrow enough that an unrelated control on an earlier
// screen section cannot vouch for it.
const LOOKBEHIND = 600;

// A glyph sits inside a control only when the nearest thing opened before it is
// a Pressable that has not closed again. A `</Pressable>` in between means the
// control already ended and the glyph is standing on its own.
function enclosingControl(source, index) {
  const before = source.slice(Math.max(0, index - LOOKBEHIND), index);
  const opened = before.lastIndexOf("<Pressable");
  if (opened === -1) return false;
  return opened > before.lastIndexOf("<View") && opened > before.lastIndexOf("</Pressable>");
}

// The one scan both the self-tests below and the live per-screen checks run, so
// a regression in it fails a self-test instead of quietly passing every screen.
function actionGlyphsOutsideControls(source, glyphs = ACTION_GLYPHS) {
  const offenders = [];
  for (const match of source.matchAll(ICON_NAME)) {
    const names = match[1] === undefined
      ? [...match[3].matchAll(QUOTED_LITERAL)].map((quoted) => quoted[2])
      : [match[2]];
    const glyph = glyphs.find((candidate) => names.some((name) => name.startsWith(candidate)));
    if (!glyph || enclosingControl(source, match.index)) continue;
    offenders.push({ glyph, index: match.index });
  }
  return offenders;
}

// The other half of the contract, hoisted for the same reason: a Pressable owes
// a role, a label and a handler, and the self-test has to run this exact check.
const CONTROL_CONTRACT = ["accessibilityRole=", "accessibilityLabel=", "onPress="];

function controlsMissingContract(source) {
  return openingTags(source, "Pressable")
    .map((element, position) => ({
      element,
      position,
      missing: CONTROL_CONTRACT.filter((attribute) => !element.includes(attribute)),
    }))
    .filter((control) => control.missing.length > 0);
}

// A guard that cannot fail is not a guard. These run the same scanners over
// synthetic sources carrying the exact defects this record describes.
describe("the scanners actually detect the defect", () => {
  const offending = `
    <View style={[styles.plus, { backgroundColor: theme.muted }]}>
      <Ionicons name="add" size={20} color={theme.mutedForeground} />
    </View>
  `;
  const wired = `
    <Pressable accessibilityRole="button" accessibilityLabel="Attach a file" onPress={attach}>
      <Ionicons name="add" size={20} color={theme.mutedForeground} />
    </Pressable>
  `;
  // The control this glyph might have belonged to has already closed above it,
  // so nothing is tappable here — the scan used to read the stale `<Pressable`
  // as an enclosure and let it through.
  const afterAClosedControl = `
    <Pressable accessibilityRole="button" accessibilityLabel="Attach a file" onPress={attach}>
      <Text>Attach</Text>
    </Pressable>
    <Ionicons name="trash" size={20} color={theme.mutedForeground} />
  `;
  // The name arrives as an expression, the shape the screens already use. The
  // quoted-literal-only scan could not see it at all.
  const expressionNamed = `
    <View style={styles.row}>
      <Ionicons name={busy ? 'hourglass' : 'paper-plane'} size={20} color={theme.mutedForeground} />
    </View>
  `;
  const expressionNamedInAControl = `
    <Pressable accessibilityRole="button" accessibilityLabel="Send" onPress={send}>
      <Ionicons name={busy ? 'hourglass' : 'paper-plane'} size={20} color={theme.mutedForeground} />
    </Pressable>
  `;

  const glyphs = (source) => actionGlyphsOutsideControls(source).map((offender) => offender.glyph);

  it("flags an action glyph inside a plain View", () => {
    expect(glyphs(offending)).toEqual(["add"]);
  });

  it("accepts the same glyph inside a labelled control", () => {
    expect(glyphs(wired)).toEqual([]);
  });

  it("flags an action glyph that follows an already-closed control", () => {
    expect(glyphs(afterAClosedControl)).toEqual(["trash"]);
  });

  it("flags an action glyph whose name is an expression, not a quoted literal", () => {
    expect(glyphs(expressionNamed)).toEqual(["paper-plane"]);
  });

  it("holds an expression-named glyph to the same enclosure check", () => {
    expect(glyphs(expressionNamedInAControl)).toEqual([]);
  });

  it("flags a Pressable missing any of role, label or handler", () => {
    const missing = [
      '<Pressable accessibilityLabel="x" onPress={go}>',
      '<Pressable accessibilityRole="button" onPress={go}>',
      '<Pressable accessibilityRole="button" accessibilityLabel="x">',
    ];
    for (const element of missing) {
      expect(controlsMissingContract(element).map((control) => control.missing), element)
        .toHaveLength(1);
    }
    expect(controlsMissingContract(
      '<Pressable accessibilityRole="button" accessibilityLabel="x" onPress={go}>',
    )).toEqual([]);
  });

  it("flags a send control that swaps its glyph with its state", () => {
    const conditional = `
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send message"
        onPress={() => { void send(); }}
        style={[styles.send, { backgroundColor: theme.muted }]}
      >
        <Ionicons name={!sending && draft.trim() ? 'arrow-up' : 'mic-outline'} size={20} />
      </Pressable>
    `;
    const glyphs = sendControlGlyphs(conditional);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]).not.toBe('"arrow-up"');
    expect(glyphs[0]).toContain("mic-outline");
  });

  it("accepts a send control that keeps one glyph", () => {
    const stable = `
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send message"
        onPress={() => { void send(); }}
        style={[styles.send, { backgroundColor: theme.muted }]}
      >
        <Ionicons name="arrow-up" size={20} color={theme.mutedForeground} />
      </Pressable>
    `;
    expect(sendControlGlyphs(stable)).toEqual(['"arrow-up"']);
  });

  it("does not mistake a sender row's glyph for the send control", () => {
    const sender = `
      <View style={styles.senderRow}>
        <Ionicons name="chevron-forward" size={14} color={theme.mutedForeground} />
      </View>
    `;
    expect(sendControlGlyphs(sender)).toEqual([]);
  });

  it("parses a multi-line Pressable opening tag as one element", () => {
    const source = `
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={\`React to \${message.author}\`}
        onPress={() => { toggle(); }}
      >
        <Text>x</Text>
      </Pressable>
    `;
    const [element] = openingTags(source, "Pressable");
    expect(element).toContain("accessibilityRole=");
    expect(element).toContain("accessibilityLabel=");
    expect(element).toContain("onPress=");
    expect(element).not.toContain("<Text>");
  });
});

describe("every visible native messaging control is honest", () => {
  for (const path of SCREENS) {
    const source = read(path);

    it(`${path}: every Pressable has a role, a label and a handler`, () => {
      expect(openingTags(source, "Pressable").length, `${path} has no Pressable — the scan has rotted`)
        .toBeGreaterThan(0);
      const incomplete = controlsMissingContract(source).map(
        (control) => `${path} Pressable #${control.position + 1} has no ${control.missing.join(", ")}`,
      );
      expect(incomplete).toEqual([]);
    });

    it(`${path}: every disabled control explains its state`, () => {
      for (const element of openingTags(source, "Pressable")) {
        if (!element.includes("disabled=")) continue;
        // A control that can be disabled must announce it, or a screen reader
        // user gets no feedback from a press that does nothing.
        expect(element, `a disabled control in ${path} has no accessibilityState`)
          .toContain("accessibilityState=");
        expect(element).toMatch(/accessibilityState=\{\{[^}]*disabled/);
      }
    });

    it(`${path}: no action-shaped glyph sits outside a control`, () => {
      // The original defect: <View style={styles.plus}><Ionicons name="add" …
      const offenders = actionGlyphsOutsideControls(source).map(
        (offender) => `${offender.glyph} at ${offender.index}`,
      );
      expect(
        offenders,
        `${path} renders an action glyph outside a control — wire it or remove it`,
      ).toEqual([]);
    });
  }

  it("the channel composer no longer carries the inert add affordance", () => {
    const channel = read("apps/mobile/app/channel/[id].tsx");
    expect(channel).not.toContain("styles.plus");
    expect(channel).not.toMatch(/<View style=\{\[styles\.plus[\s\S]{0,200}Ionicons name="add"/);
    expect(channel).toContain("BUG-UG-NATIVE-MESSAGE-INERT-CONTROLS-20260904");
  });

  it("the reply count is status text, not a link-coloured non-control", () => {
    const channel = read("apps/mobile/app/channel/[id].tsx");
    expect(channel).toContain('accessibilityRole="text"');
    expect(channel).toContain("Replies are not openable from this screen yet.");
    expect(channel).toContain("style={[styles.threadHint, { color: theme.mutedForeground }]}");
    expect(channel).not.toContain("styles.threadHint, { color: theme.primary }");
  });

  it("attachment data cannot render as a live capability", () => {
    // This edition's phone keeps its offline preview: a seeded sample
    // attachment card renders only in preview mode and says it is not a
    // stored file.
    const channel = read("apps/mobile/app/channel/[id].tsx");
    const uses = channel.split("\n").filter((line) => line.includes("message.attachment"));
    expect(uses.length).toBeGreaterThan(0);
    expect(channel).toContain("{mode === 'preview' && message.attachment ? (");
    expect(channel).toContain("Not a stored file.");
    // The live store must never populate the field in the first place.
    expect(read("apps/mobile/src/data/liveChannels.ts")).not.toContain("attachment");
  });

  // Same defect class as the inert add affordance, seen from the other side: the
  // glyph promised a capability the screen does not have. The app really does
  // record voice notes (src/components/QuickActionsDrawer.tsx wires 'mic-outline'
  // to startRecording/stopRecording), so a microphone on a messaging composer
  // reads as that same feature — while these screens only ever send text.
  it("no messaging composer offers a voice-capture glyph it cannot honour", () => {
    for (const path of COMPOSER_SCREENS) {
      const source = read(path);
      expect(source, `${path} renders a mic glyph but has no voice-capture handler`)
        .not.toMatch(/name=[^\n]*\bmic\b/);
      expect(source, `${path} has no recording handler to justify a mic glyph`)
        .not.toContain("startRecording");
    }
  });

  it("the send control keeps one glyph in every state, like its sibling", () => {
    // conversation/[id].tsx and messages.tsx have always rendered a
    // static arrow-up and only mute the colour when disabled. No composer may
    // swap its glyph for a different affordance in the exact state where
    // pressing it does nothing.
    for (const path of COMPOSER_SCREENS) {
      const glyphs = sendControlGlyphs(read(path));
      expect(glyphs.length, `${path}: no send-control glyph found — the scan has rotted`)
        .toBeGreaterThan(0);
      for (const glyph of glyphs) {
        expect(glyph, `${path}: the send glyph is conditional, not one stable affordance`)
          .toBe('"arrow-up"');
      }
    }
  });

  it("keeps every control at or above the platform touch-target floor", () => {
    const channel = read("apps/mobile/app/channel/[id].tsx");
    // Reaction chips and the add-reaction chip share one full-height target
    // in MessageReactions; the picker's choices stay on the channel screen.
    const reactions = read("apps/mobile/src/components/MessageReactions.tsx");
    for (const [source, style] of [[channel, "reactionChoice:"], [reactions, "chipTarget:"], [reactions, "button:"]]) {
      const line = source.split("\n").find((entry) => entry.trim().startsWith(style));
      expect(line, `${style} style missing`).toBeTruthy();
      expect(line, `${style} does not meet the touch-target floor`).toContain("minimumTouchTarget");
    }
    expect(channel).toContain("<AddReactionChip");
  });
});

// BUG-UG-MOBILE-CHANNEL-REPLIES-TARGET-THREAD-ID-AND-RESOLVED-THREAD-COMPOSE-20260926.
// The replies page was handed the channel row id (a chapter_threads id) while
// get_member_message_replies takes the chapter_spaces id, and a resolved thread
// still offered Reply and a composer whose refusal read as a transport failure.
describe("channel replies target the space and a closed thread has no composer", () => {
  it("the replies page receives the chapter space id, never the thread row id", () => {
    const channel = read("apps/mobile/app/channel/[id].tsx");
    expect(channel).toContain("targetID={channel.spaceID ?? channelID}");
    expect(channel).not.toContain("targetID={channelID}");
    const live = read("apps/mobile/src/data/liveChannels.ts");
    expect(live).toContain("spaceID: space.id");
    expect(live).toContain("closed: thread.status != null && thread.status !== 'open'");
  });

  it("a closed thread shows the closed notice instead of the composer and refuses Reply with it", () => {
    const channel = read("apps/mobile/app/channel/[id].tsx");
    expect(channel).toContain("const closed = channel?.closed === true;");
    expect(channel).toContain("{closed ? <Notice>{channelActionNotice(copy, 'closed')}</Notice> : <>");
    expect(channel).toContain("if (closed) { setSendError(channelActionNotice(copy, 'closed')); return; }");
    expect(channel).toContain("replyTo && isWriteRefusal(error) ? await liveChannelStore.threadClosed(channel.id) : false");
    expect(channel).toContain("closedNow ? 'closed' : 'send'");
    expect(channel).not.toContain("isWriteRefusal(error) ? 'closed'");
    expect(read("apps/mobile/src/data/liveChannels.ts")).toContain("const closed = Boolean(row && row.status != null && row.status !== 'open');");
    expect(channel).not.toContain("onCompose={() => { setReplyTo(message.id); setDraft(''); }}");
    const copy = read("apps/mobile/src/lib/messageInboxCopy.ts");
    expect(copy).toContain("closed: 'This thread is closed to new posts and replies.'");
    expect(copy).toContain("closed: 'Este hilo está cerrado a nuevas publicaciones y respuestas.'");
  });
});
