import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const mobile = fileURLToPath(new URL('../../', import.meta.url));
// Member entry surfaces: adding an untranslated visible literal here must fail
// even if nobody adds its key to the catalogue. Content from the backend is
// deliberately excluded: member names and chapter-authored text are not UI.
const surfaces: Record<string, readonly string[]> = {
  'app/(tabs)/home.tsx': ['AuthenticatedHome'],
  'app/(tabs)/_layout.tsx': ['TabLayout'],
  'app/(tabs)/account.tsx': ['AccountScreen', 'AccountScreenContent', 'ThemeSection'],
  // #8305: the rights screen's bookmark (saved place) subflow.
  'src/features/RightsResumeReading.tsx': ['ContinueReadingCard', 'RightsReadingSections'],
  'src/components/LanguageSettingsCard.tsx': ['LanguageSettingsCard'],
  'src/features/DataSettingsCard.tsx': ['DataSettingsCard'],
  'src/features/HapticPreferencesCard.tsx': ['HapticPreferencesCard'],
  'src/features/HomeWidgetSharingCard.tsx': ['HomeWidgetSharingCard'],
  'src/features/NativeSignOut.tsx': ['NativeSignOut'],
  'src/features/home/WhatMattersNow.tsx': ['WhatMattersNowPending', 'WhatMattersNowSection'],
  'src/features/home/WelcomeBack.tsx': ['WelcomeBackView'],
  'src/features/WorkScreen.tsx': ['WorkScreen', 'CaseBoard'],
  'src/components/ReminderPicker.tsx': ['ReminderPicker'],
  'src/components/FunctionDeck.tsx': ['FunctionDeck'],
  'src/components/AskCompassButton.tsx': ['AskCompassButton'],
  'src/features/FeatureScreen.tsx': ['RightsFeature'],
  'src/features/LiveLivedInScreens.tsx': ['LiveRightsScreen'],
  // The shared staff desk (#8302): the Home desk card and Work's quick capture.
  'src/features/home/StaffDeskHomeCard.tsx': ['StaffDeskHomeCard'],
  'src/components/StaffQuickCapture.tsx': ['StaffQuickCapture', 'StaffQuickCaptureContent'],
  // #9459 M1-21: the saved-work check failure those editors share.
  'src/components/SavedWorkCheckFailed.tsx': ['SavedWorkCheckFailed'],
  // Account's security and settings panels (#8303).
  'src/features/NativeSessionsCard.tsx': ['NativeSessionsCard'],
  'src/features/PasswordChangeCard.tsx': ['PasswordChangeCard'],
  'src/features/PendingPasswordResetCard.tsx': ['PendingPasswordResetCard'],
  'src/features/NativeAccountDeletion.tsx': ['NativeAccountDeletion'],
  // #9084: Account's phone number and who sees it.
  'src/features/ProfilePhoneCard.tsx': ['ProfilePhoneCard'],
  'src/components/CustomNavLinksCard.tsx': ['CustomNavLinksCard'],
  // #9099 part 1: the Events desk's Schedule a meeting form.
  'src/features/ScheduleMeetingCard.tsx': ['ScheduleMeetingCard'],
  // #9099 part 2: the shared notice composer and the Chapter notices screen.
  'src/features/NoticeComposer.tsx': ['NoticeComposer'],
  'src/features/ChapterNoticesScreen.tsx': ['ChapterNoticesScreen'],
  // #9099 part 3: Campaigns' Write a draft form.
  'src/features/CampaignDraftCard.tsx': ['CampaignDraftCard'],
  // #9099 part 4: the invitation desk.
  'src/features/ChapterInvitationsScreen.tsx': ['ChapterInvitationsScreen'],
  // #8304: deeper conversation and channel actions and their secondary panels.
  'src/components/NativeMessageActions.tsx': ['NativeMessageActions'],
  'src/components/MessageReplies.tsx': ['MessageReplies', 'ReplyCountControl', 'ParentMessageControl'],
  'src/components/MessageReactions.tsx': ['AddReactionChip', 'MessageReactionPicker'],
  'src/components/ChannelControls.tsx': ['ChannelSettingsPanel', 'MentionPickerPanel'],
  'app/conversation/[id].tsx': ['ConversationContent'],
  'app/channel/[id].tsx': ['ChannelContent'],
};
const copyProps = new Set(['title', 'screenName', 'body', 'label', 'placeholder', 'accessibilityLabel', 'accessibilityHint']);
const approvedLiterals = new Set(['Union Ground', 'English', 'Español', '✦ Learning Spark']);

describe('native worker entry i18n coverage', () => {
  it('places language selection before profile editing and device settings', () => {
    const account = readFileSync(`${mobile}app/(tabs)/account.tsx`, 'utf8');
    const language = account.indexOf('<LanguageSettingsCard ');
    expect(language).toBeGreaterThan(0);
    for (const later of ['<ThemeSection />', '<DataSettingsCard />', '{editingProfile && dashboard ?']) expect(language).toBeLessThan(account.indexOf(later));
  });
  it.each(Object.entries(surfaces))('%s has no untranslated JSX copy', (path, functions) => {
    const source = readFileSync(`${mobile}${path}`, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const gaps: string[] = [];
    function visit(node: ts.Node, active = false) {
      if (ts.isFunctionDeclaration(node)) active = Boolean(node.name && functions.includes(node.name.text));
      if (active) {
        const text = ts.isJsxText(node) ? node.text.trim()
          : ts.isJsxAttribute(node) && copyProps.has(node.name.getText(ast)) && node.initializer && ts.isStringLiteral(node.initializer)
            ? node.initializer.text : '';
        if (/[A-Za-z]/.test(text) && !approvedLiterals.has(text)) gaps.push(`${ast.getLineAndCharacterOfPosition(node.pos).line + 1}: ${text}`);
      }
      ts.forEachChild(node, (child) => visit(child, active));
    }
    visit(ast);
    expect(gaps, `Move app-owned copy into the en/es catalogue:\n${gaps.join('\n')}`).toEqual([]);
  });
});
