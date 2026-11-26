import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { taskKey } from '../../../../src/lib/kanban.js';
import { nativeTaskConversationRoute, nativeTaskRoute } from './connectedWorkflowRoutes';
import { notificationDestination } from './notificationKinds';
import { appRouteFromRouterPath } from './routes';
import { countMessageFilters, filterMessageInbox, type MessageInboxItem } from './messageInbox';
import {
  TASK_DISCUSSION_MESSAGE_LIMIT,
  countWithTaskDiscussions,
  taskDiscussionScope,
  buildTaskDiscussions,
  filterTaskDiscussions,
  nativeTaskReference,
  taskDiscussionsFromRows,
  type TaskDiscussionEmbeddedRow,
  type TaskDiscussionMessageRow,
} from './taskDiscussions';

// BUG-UG-NATIVE-CASE-ROWS-AND-TASK-TITLES-DO-NOT-OPEN-20261111.
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const me = '1c4e7a90-3b2d-4f6e-8a1c-5d9b0e7f2a36';
const coordinator = '7f3a1b2c-9d8e-4c5f-a6b7-0e1d2c3b4a59';
const fleetTask = '5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10';
const harrowTask = '9e2f4a61-0c8d-4b7e-8f13-6a5d2c1b0e94';
const goneTask = '2d5f8b1e-6c3a-4e9d-b7f0-1a4c8e2d6b93';

const message = (task: string, minute: number, from: string, body = `note ${minute}`): TaskDiscussionMessageRow => ({
  task_id: task,
  body,
  created_at: `2026-11-11T14:${String(minute).padStart(2, '0')}:00.000Z`,
  sender_id: from,
});

describe('task references match the web', () => {
  it('names a task by campaign and number the way the web does', () => {
    expect(nativeTaskReference('fleet-maintenance', 6)).toBe('FLEET-MAINTENANCE-6');
    expect(nativeTaskReference('harrow-bay-north', '34')).toBe('HARROW-BAY-NORTH-34');
    expect(nativeTaskReference('fleet-maintenance', 6)).toBe(taskKey({ taskNumber: 6 }, 'fleet-maintenance'));
  });

  it('shows TASK when either half is missing, never UG- or a broken key', () => {
    for (const [chapter, number] of [[null, 6], ['', 6], ['fleet', null], ['fleet', 0], ['fleet', 'x'], ['fleet', 1.5]] as const) {
      expect(nativeTaskReference(chapter, number)).toBe('TASK');
    }
  });

  it('every phone task label goes through the shared reference', () => {
    const livedIn = source('../services/livedIn.ts');
    const share = source('../services/secureShareIntake.ts');
    expect(livedIn).toContain('identifier: nativeTaskReference(task.chapter_id, task.task_number)');
    expect(share).toContain('label: nativeTaskReference(row.chapter_id, row.task_number)');
    expect(`${livedIn}\n${share}`).not.toMatch(/`UG-\$\{/);
  });
});

describe('task discussions in Messages', () => {
  const tasks = [
    { id: fleetTask, title: 'Fleet bay rota', chapter_id: 'fleet-maintenance', task_number: 6 },
    { id: harrowTask, title: 'Harrow Bay posting', chapter_id: 'harrow-bay', task_number: 34 },
  ];

  it('lists one row per task the person wrote or received, newest first, without a staff role', () => {
    const messages = [
      message(harrowTask, 9, coordinator, 'Could you   check\nthe posting?'),
      message(fleetTask, 5, me, 'On it'),
      message(fleetTask, 3, coordinator),
      message(goneTask, 12, coordinator, 'removed task'),
    ];
    expect(buildTaskDiscussions(messages, tasks, me)).toEqual([
      { taskID: harrowTask, title: 'Harrow Bay posting', reference: 'HARROW-BAY-34', latestAt: '2026-11-11T14:09:00.000Z', latestPreview: 'Could you check the posting?', latestFromYou: false },
      { taskID: fleetTask, title: 'Fleet bay rota', reference: 'FLEET-MAINTENANCE-6', latestAt: '2026-11-11T14:05:00.000Z', latestPreview: 'On it', latestFromYou: true },
    ]);
  });

  it('reads messages with their task embedded and drops a deleted task row by row (gate G6-8264-2)', () => {
    const embedded = (task: string, minute: number, deleted: string | null, title = 'Harrow Bay posting'): TaskDiscussionEmbeddedRow => ({
      ...message(task, minute, coordinator),
      chapter_tasks: { id: task, title, chapter_id: 'harrow-bay', task_number: 34, deleted_at: deleted },
    });
    const rows = [
      embedded(goneTask, 30, '2026-11-11T15:00:00.000Z', 'Removed task'),
      { ...embedded(fleetTask, 20, null, 'Fleet bay rota'), chapter_tasks: [{ id: fleetTask, title: 'Fleet bay rota', chapter_id: 'fleet-maintenance', task_number: 6, deleted_at: null }] },
      { ...message(harrowTask, 25, coordinator), chapter_tasks: null },
    ];
    expect(taskDiscussionsFromRows(rows, me).map((item) => [item.taskID, item.reference])).toEqual([[fleetTask, 'FLEET-MAINTENANCE-6']]);
  });

  it('reads the web\'s 1,000-message window, after excluding deleted and unreadable tasks in the query', () => {
    expect(TASK_DISCUSSION_MESSAGE_LIMIT).toBe(1000);
    const loader = source('../services/livedIn.ts').split('export async function loadMyTaskDiscussions')[1]?.split('\n}\n')[0] ?? '';
    expect(loader).toContain(".select('task_id,body,created_at,sender_id,chapter_tasks!inner(id,title,chapter_id,task_number,deleted_at)')");
    // The deleted-task filter is part of the query, so it applies before the limit.
    expect(loader.indexOf(".is('chapter_tasks.deleted_at', null)")).toBeGreaterThan(-1);
    expect(loader.indexOf(".is('chapter_tasks.deleted_at', null)")).toBeLessThan(loader.indexOf('.limit(TASK_DISCUSSION_MESSAGE_LIMIT)'));
    expect(loader).not.toContain(".from('chapter_tasks')");
  });

  it('search finds a task discussion by title or reference', () => {
    const items = buildTaskDiscussions([message(harrowTask, 9, coordinator), message(fleetTask, 5, me)], tasks, me);
    expect(filterTaskDiscussions(items, 'posting').map((item) => item.taskID)).toEqual([harrowTask]);
    expect(filterTaskDiscussions(items, 'fleet-maintenance-6').map((item) => item.taskID)).toEqual([fleetTask]);
    expect(filterTaskDiscussions(items, '  ')).toHaveLength(2);
    expect(filterTaskDiscussions(items, 'grievance')).toEqual([]);
  });

  // One search rule for the Messages tab. A task
  // titled like a channel is found by the same unaccented word, and by its
  // latest message as a direct or channel row is by its preview.
  it('search folds accents and reads the latest message, as the inbox search does', () => {
    const items = buildTaskDiscussions([message(harrowTask, 9, coordinator), message(fleetTask, 5, me)], tasks, me)
      .map((item) => item.taskID === harrowTask ? { ...item, title: 'Comité meeting', latestPreview: 'Bring the Señal flyers' } : item);
    expect(filterTaskDiscussions(items, 'comite').map((item) => item.taskID)).toEqual([harrowTask]);
    expect(filterTaskDiscussions(items, 'COMITÉ').map((item) => item.taskID)).toEqual([harrowTask]);
    expect(filterTaskDiscussions(items, 'senal flyers').map((item) => item.taskID)).toEqual([harrowTask]);
    const channelRow: MessageInboxItem = { key: 'channel:c', id: 'c', kind: 'channel', title: 'Comité meeting', meta: '', preview: '', initials: null, unread: 0, timestamp: 0, fallbackTime: '', pinned: false };
    const inbox = filterMessageInbox([channelRow], 'all', 'comite');
    expect(inbox).toHaveLength(1);
  });

  it('a task notification clears the Messages filter and search once', () => {
    const messages = source('../../app/messages.tsx');
    expect(messages).toContain("const { show } = useLocalSearchParams<{ show?: string }>();");
    expect(messages).toMatch(/if \(show !== 'tasks'\) return;\s+setFilter\('all'\);\s+setQuery\(''\);\s+router\.setParams\(\{ show: undefined \}\);/);
  });

  it('each row opens the task conversation screen, which checks access itself', () => {
    expect(nativeTaskConversationRoute(fleetTask)).toBe(`/task-conversation/${fleetTask}`);
    expect(appRouteFromRouterPath(`/task-conversation/${fleetTask}`)).toEqual({ kind: 'taskConversation', id: fleetTask });
    const section = source('../components/TaskDiscussionsSection.tsx');
    expect(section).toContain('const href = nativeTaskConversationRoute(item.taskID);');
    expect(section).toContain('accessibilityRole="button"');
    const messages = source('../../app/messages.tsx');
    expect(messages).toContain('const taskDiscussions = useTaskDiscussions(');
    expect(messages).toMatch(/const taskSection = mode === 'authenticated' && filter === 'all'\s+\? <TaskDiscussionsSection items=\{shownTaskDiscussions\} failed=\{taskDiscussions.failed\} \/> : null;/);
    expect(messages).toContain('{!hasStewardDirectGroup ? taskSection : null}');
    expect(messages).toContain('{hasStewardDirectGroup ? taskSection : null}');
    expect(messages).toContain('setTaskDiscussionsReload((value) => value + 1);');
  });

  it('reads only the person\'s own task messages', () => {
    const loader = source('../services/livedIn.ts').split('export async function loadMyTaskDiscussions')[1]?.split('\n}\n')[0] ?? '';
    expect(loader).toContain(".or(`sender_id.eq.${userID},recipient_id.eq.${userID}`)");
  });

  it('scopes the list to the person, organization and selected campaign, and to nothing while the workspace reloads (gate G6-8264 FINAL P1)', () => {
    expect(taskDiscussionScope('user-one', 'org-one', 'tamarack-eastgate')).not.toBe(taskDiscussionScope('user-one', 'org-one', 'tamarack-harrow-bay'));
    expect(taskDiscussionScope('user-one', 'org-one', 'tamarack-eastgate')).not.toBe(taskDiscussionScope('user-two', 'org-one', 'tamarack-eastgate'));
    expect(taskDiscussionScope('user-one', 'org-one', null)).toBeNull();
    expect(taskDiscussionScope(undefined, 'org-one', 'tamarack-eastgate')).toBeNull();
    const messages = source('../../app/messages.tsx');
    expect(messages).toContain("mode === 'authenticated' ? taskDiscussionScope(session?.user.id, organizationID, dashboard?.member?.chapterID) : null,");
  });

  it('counts task discussions in the All filter and its spoken count (gate G6-8264 FINAL P2)', () => {
    const inbox: MessageInboxItem[] = [
      { key: 'd1', id: 'd1', kind: 'direct', title: 'Alex', meta: '', preview: '', initials: null, unread: 1, timestamp: 0, fallbackTime: '' },
      { key: 'c1', id: 'c1', kind: 'channel', title: 'General', meta: '', preview: '', initials: null, unread: 0, timestamp: 0, fallbackTime: '' },
    ];
    const counts = countWithTaskDiscussions(countMessageFilters(inbox), 3);
    expect(counts.all).toBe(5);
    expect(counts.direct).toBe(1);
    expect(counts.channel).toBe(1);
    expect(counts.unread).toBe(countMessageFilters(inbox).unread);
    const messages = source('../../app/messages.tsx');
    expect(messages).toContain('() => countWithTaskDiscussions(countMessageFilters(inboxItems), taskDiscussions.items.length),');
    // The badge text and the chip's accessibility value both read filterCounts.
    expect(messages).toContain('accessibilityValue={{ text: copy.filterCount(key, copy.filters[key], filterCounts[key], selected) }}');
  });

  it('counts task matches in the Messages search result and shows no empty state over them (gate G6-8264-3)', () => {
    const messages = source('../../app/messages.tsx');
    expect(messages).toContain("() => (filter === 'all' ? filterTaskDiscussions(taskDiscussions.items, query, locale) : []),");
    expect(messages).toContain('const resultCount = visibleItems.length + shownTaskDiscussions.length;');
    expect(messages).toContain('{copy.resultCount(resultCount)}</Text>');
    // The count is announced after the worker's own filter or search change
    // only (useResultCountAnnouncement.test.ts covers the behaviour).
    expect(messages).toContain('useResultCountAnnouncement(JSON.stringify([filter, query]), copy.resultCount(resultCount))');
    expect(messages).toContain('<Text accessibilityLiveRegion={resultCountLiveRegion}');
    expect(messages).toContain(') : shownTaskDiscussions.length > 0 ? null : (');
    expect(messages).not.toContain('copy.resultCount(visibleItems.length)');
  });
});

describe('task notifications and task titles open what they name', () => {
  it('a task-message notification opens Messages, where its discussion is listed', () => {
    expect(notificationDestination('tasks', 'task.message')).toBe('/messages?show=tasks');
    // Other task notices (assigned, deleted, watched) still open My work.
    expect(notificationDestination('tasks', 'task.assigned')).toBe('/work');
    expect(notificationDestination('tasks')).toBe('/work');
    const service = source('../services/supabase.ts');
    expect(service.match(/\.select\('id,title,body,kind,copy_key,peer_conversation_id,read_at,created_at'\)/g)).toHaveLength(2);
  });

  it('a task title in the task list opens that task, and is plain text on the task itself', () => {
    expect(nativeTaskRoute(fleetTask)).toBe(`/feature/tasks?source=${fleetTask}`);
    const screen = source('../features/LiveLivedInScreens.tsx');
    expect(screen).toContain('onOpen={sourceID || !onOpenTask ? undefined : () => onOpenTask(task.id)}');
    expect(screen).toContain('accessibilityHint="Opens this task."');
    const feature = source('../features/FeatureScreen.tsx');
    expect(feature).toContain('const openTask = (taskID: string) => { const href = nativeTaskRoute(taskID); if (href) router.push(href as never); };');
    expect(feature).toContain('<LiveLivedInScreen key={partnerScope} featureKey={featureKey} sourceID={sourceID} onOpenTask={openTask} />');
  });

  it('staff Issue work and Issue queue rows open the issue', () => {
    // #8630: each desk has its own live screen, and every issue card there opens the issue.
    const feature = source('../features/FeatureScreen.tsx');
    expect(feature).toContain("if (featureKey === 'steward') return <LiveCaseworkDeskScreen key={partnerScope} />;");
    expect(feature).toContain("if (featureKey === 'coordinator') return <LiveCaseQueueScreen key={partnerScope} />;");
    const live = source('../features/LiveFeatureScreens.tsx');
    expect(live).toContain('<CaseRowPressable reference={item.reference} visible={[item.status, item.title, item.meta]} onPress={() => { void haptics.select(); onOpen(item.id); }}>');
    expect(live).toContain('cases.map((item) => <ChapterCaseCard key={item.id} item={item} onOpen={(id) => router.push(`/issue/${id}` as never)} />)');
    expect(live).toContain('const open = (id: string) => router.push(`/issue/${id}` as never);');
  });
});
