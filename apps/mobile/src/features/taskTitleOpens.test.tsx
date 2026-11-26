// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { stubPlainRequire } from '../testing/plainRequire';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import type { LivedInTask } from '../services/livedIn';

// BUG-UG-NATIVE-CASE-ROWS-AND-TASK-TITLES-DO-NOT-OPEN-20261111
// (#8233), executed on the shared stand-in (#8319): a task title in the task
// list was plain text, so pressing it opened nothing.
const load = vi.hoisted(() => ({ tasks: vi.fn() }));
// The survey card and unit editors import the shared draft hook, whose attempt keys come from expo-crypto (#9240 pull request D).
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key' }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({ setOptions: () => {} }) }));
vi.mock('../lib/screenBack', () => ({ useScreenBackInterceptor: () => {} }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ session: null, mode: 'authenticated', organizationID: null, chapterMemberships: [], sessionRestricted: false, captureAuthenticatedSessionGuard: () => () => true, authorizedRoles: ['member'], dashboard: null, sampleHat: null, liveSampleBackend: false }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('./TaskDocumentHandoffProvider', () => ({ useTaskDocumentHandoff: () => ({ active: false, pending: null }) }));
vi.mock('./WorkFilterPresetsCard', () => ({ WorkFilterButton: () => null, WorkFilterPresetsCard: () => null }));
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('./RightsResumeReading', () => ({ ContinueReadingCard: () => null, RightsReadingSections: () => null, rightsBookmarks: {}, useRightsBookmark: () => null, useRightsReadingScope: () => null }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowActions: () => null }));
vi.mock('../components/AskCompassButton', () => ({ AskCompassButton: () => null }));
vi.mock('../components/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
vi.mock('../components/QuarterlySurveyGate', () => ({ QuarterlySurveyGate: () => null }));
vi.mock('./ContextualPulseCard', () => ({ ContextualPulseCard: () => null, useNativeContextualPulse: () => null }));
vi.mock('./learning/LearningContentManager', () => ({ LearningContentManager: () => null }));
vi.mock('./learning/LearningLibrarySection', () => ({ LearningLibrarySection: () => null }));
vi.mock('./CaseRowTopicCards', () => ({ ChapterCaseRowTopicCard: () => null }));
vi.mock('../lib/connectedWorkflows', () => ({ connectedWorkflowApi: () => null }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(), select: vi.fn() } }));
vi.mock('../services/supabase', () => ({ loadMobileMemberReportCard: vi.fn() }));
vi.mock('../services/memberSurveys', () => ({ loadMobileMemberSurveys: vi.fn(), saveMobileSurveySession: vi.fn(), submitMobileSurveySession: vi.fn() }));
vi.mock('../services/nativeCalendarExport', () => ({ calendarExportWasSaved: () => false, exportToDeviceCalendar: vi.fn(), isCalendarExportAvailable: () => false }));
// The Mobile CI job installs only apps/mobile; this report-card helper reaches
// root web modules whose shared package is installed only at the repository
// root. It is not on the task list's path.
vi.mock('../lib/mi1AnalyticsShared', () => ({ normalizeMemberReportCard: () => null }));
vi.mock('../services/livedIn', () => ({ loadMobileTasksHistory: load.tasks }));

import { LiveLivedInScreen } from './LiveLivedInScreens';

const task: LivedInTask = {
  id: 'task-1', identifier: 'TASK-1', title: 'Prepare the campaign agenda', description: '',
  status: 'open', priority: 'normal', workstream: 'Campaign work', assignee: 'Unassigned',
  startDate: null, dueDate: null, progress: 0, blocked: false, milestone: false,
};

// The screen reads its configuration with a plain require when it opens.
afterAll(stubPlainRequire({ '../lib/config': { mobileConfig: { supabaseUrl: '' } } }));

let screen: Rendered | null = null;
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

describe.each(['ios', 'android'] as const)('task list on %s', (os) => {
  it('opens a task when its title is pressed', async () => {
    setPlatform(os);
    load.tasks.mockResolvedValue([task]);
    const onOpenTask = vi.fn();
    screen = await render(h(LiveLivedInScreen, { featureKey: 'tasks', onOpenTask }));
    await act(async () => { await Promise.resolve(); });
    await press(getExposed(screen.container, 'Prepare the campaign agenda, TASK-1'));
    expect(onOpenTask).toHaveBeenCalledWith('task-1');
  });
});
