// BUG-UG-CHAPTER-NOTICE-PUBLISH-NOT-EXACTLY-ONCE-20261119 (#9220):
// a notice draft's operation key lives exactly as long as its composer, on all
// three website composers alike: leaving and coming back starts a new notice
// (a same-words notice is published, not matched to the abandoned one), and a
// retry inside the same composer keeps the key. The Steward navigation case
// and the Compass and Steward edit cases are the delta review's probes
// (R-9225b, reviewer-notice-delta.test.jsx), kept as they were written; the
// officer desk and Compass leave-and-return cases are added beside them.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/lib/LanguageContext.jsx';
import { WorkspacePages } from '../src/components/WorkspacePages.jsx';
import { StewardView } from '../src/views/StewardView.jsx';
import { CompassAnswerActions } from '../src/features/compass/CompassAnswerActions.jsx';
import { OfficerNoticeDesk } from '../src/features/notices/OfficerNoticeDesk.jsx';
import { loadNoticeAudiences, publishNoticeForAudience } from '../src/lib/noticeAudience.js';
import { allowWorkspaceNavigation } from '../src/lib/navigationGuard.js';
import { publishMemberBroadcast } from '../src/lib/memberApi.js';

afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); });
const context = { chapterId: 'chapter-a', role: 'steward' };
// deferred: the first publish commits and its (lost) answer waits for
// releaseReply. missing: the first publish meets a transient 404 from the
// API in front of the database, so nothing ran.
function backend({ deferred = false, missing = false } = {}) {
  const receipts = new Map(), effects = [], calls = [];
  let losing = !missing, refusals = missing ? 1 : 0;
  let releaseReply; const reply = new Promise(resolve => { releaseReply = resolve; });
  const client = { rpc: vi.fn(async (name, args) => {
    if (name === 'get_chapter_office_access') return { data: { chapterId: 'chapter-a', notices: true, unscopedNotices: true, scopes: [] }, error: null };
    const { p_idempotency_key: key, ...payload } = args;
    calls.push({ key, payload });
    if (refusals > 0) { refusals -= 1; return { data: null, status: 404, error: { code: 'PGRST202', message: 'Could not find the function' } }; }
    const old = key ? receipts.get(key) : null;
    if (old && JSON.stringify(old.payload) !== JSON.stringify(payload)) return { data: null, error: { code: '22023', message: 'idempotency key reused for a different request' } };
    let answer = old?.answer;
    if (!answer) {
      answer = { broadcastId: `bc-${effects.length + 1}` };
      effects.push(payload);
      if (key) receipts.set(key, { payload, answer });
    }
    if (losing) { losing = false; if (deferred) await reply; return { data: null, error: { code: '', message: 'TypeError: Failed to fetch' } }; }
    return { data: answer, error: null };
  }) };
  return { client, calls, effects, releaseReply, publish: (title, body, locale, audience, key) => publishNoticeForAudience(client, title, body, locale, audience, context, key) };
}
// app: the publisher the app gives the Steward page (App.jsx,
// publishMemberBroadcast) instead of the shared audience publisher.
function steward(options = {}) {
  const proof = backend(options), onNotice = vi.fn();
  const desk = { queue: [], threads: [], broadcasts: [], formsInbox: [], kpis: { openRequests: 0, membersCovered: 0, awaitingReply: 0, broadcasts30d: 0 } };
  const publish = options.app ? (title, body, locale, audienceScope, key) => publishMemberBroadcast(proof.client, title, body, locale, audienceScope ?? 'chapter', key) : proof.publish;
  const api = { loadDesk: vi.fn().mockResolvedValue(desk), listEmailIntakes: vi.fn().mockResolvedValue([]), publish };
  const element = (path) => {
    window.history.replaceState({}, '', path);
    return <LanguageProvider lang="en"><WorkspacePages view="steward" hat="steward" location={path} navigate={vi.fn()}><StewardView data={{ member: { id: 'actor-a', initials: 'SO', chapterId: 'chapter-a' } }} api={api} onNotice={onNotice} /></WorkspacePages></LanguageProvider>;
  };
  const draft = async (body = 'Polls open at noon.') => {
    const form = (await screen.findByRole('button', { name: 'Publish broadcast' })).closest('form');
    fireEvent.change(form.elements.title, { target: { value: 'Weekly reminder' } });
    fireEvent.change(form.elements.body, { target: { value: body } });
    fireEvent.change(form.elements.locale, { target: { value: 'en' } });
    fireEvent.submit(form);
  };
  const press = async (count) => {
    const dialog = await screen.findByTestId('broadcast-publish-confirm');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Publish in English now and write the Spanish version next' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish in English' }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledTimes(count));
  };
  return { ...proof, onNotice, element, draft, press };
}
it('a fresh steward composer after navigating to another desk page has a fresh key', async () => {
  const proof = steward();
  const { rerender } = render(proof.element('/m/steward/broadcasts'));
  await proof.draft(); await proof.press(1);
  expect(proof.effects).toHaveLength(1);
  fireEvent.click(within(screen.getByTestId('broadcast-publish-confirm')).getByRole('button', { name: 'Cancel' }));
  rerender(proof.element('/m/steward/requests'));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Publish broadcast' })).toBeNull());
  rerender(proof.element('/m/steward/broadcasts'));
  await proof.draft(); await proof.press(2);
  expect(proof.calls[1].key).not.toBe(proof.calls[0].key);
  expect(proof.effects).toHaveLength(2);
});
it('the steward retries the same draft once and can publish a confirmed same-text draft anew', async () => {
  const proof = steward();
  render(proof.element('/m/steward/broadcasts'));
  await proof.draft(); await proof.press(1); await proof.press(2);
  expect(proof.calls[1].key).toBe(proof.calls[0].key);
  expect(proof.effects).toHaveLength(1);
  await proof.draft(); await proof.press(3);
  expect(proof.calls[2].key).not.toBe(proof.calls[0].key);
  expect(proof.effects).toHaveLength(2);
});
it('Compass cancel and reopen starts a new draft, while retrying an open panel retains its key', async () => {
  const proof = backend();
  const actions = { publishBroadcast: ({ title, body, operationKey }) => proof.publish(title, body, 'en', 'chapter', operationKey) };
  render(<LanguageProvider lang="en"><CompassAnswerActions message={{ id: 'answer-a', body: 'An answer' }} actions={actions} /></LanguageProvider>);
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Draft announcement' }));
  const fill = () => {
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Weekly reminder' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Polls open at noon.' } });
  };
  open(); fill();
  fireEvent.submit(screen.getByLabelText('Title').closest('form'));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  open(); fill();
  fireEvent.submit(screen.getByLabelText('Title').closest('form'));
  await screen.findByRole('status');
  expect(proof.calls[1].key).not.toBe(proof.calls[0].key);
  expect(proof.effects).toHaveLength(2);
});
it('the Steward edit is refused with the truthful first-version message and publishes only on the next confirmation', async () => {
  const proof = steward();
  render(proof.element('/m/steward/broadcasts'));
  await proof.draft(); await proof.press(1);
  fireEvent.click(within(screen.getByTestId('broadcast-publish-confirm')).getByRole('button', { name: 'Cancel' }));
  await proof.draft('Polls open at one.'); await proof.press(2);
  expect(proof.onNotice.mock.calls[1][0]).toBe('The first version of this notice was already posted. See Your notices. Post again to send this version as a new notice.');
  expect(proof.effects).toHaveLength(1);
  expect(proof.calls[1].key).toBe(proof.calls[0].key);
  await proof.draft('Polls open at one.'); await proof.press(3);
  expect(proof.effects.map(x => x.p_body)).toEqual(['Polls open at noon.', 'Polls open at one.']);
});
it('the Compass edit is refused with the first-version message and publishes only on the next explicit submit', async () => {
  const proof = backend();
  const actions = { publishBroadcast: ({ title, body, operationKey }) => proof.publish(title, body, 'en', 'chapter', operationKey) };
  render(<LanguageProvider lang="en"><CompassAnswerActions message={{ id: 'answer-a', body: 'An answer' }} actions={actions} /></LanguageProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Draft announcement' }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Weekly reminder' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Polls open at noon.' } });
  const form = screen.getByLabelText('Title').closest('form');
  fireEvent.submit(form); await screen.findByRole('alert');
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Polls open at one.' } });
  fireEvent.submit(form);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The first version of this notice was already posted. See Your notices. Post again to send this version as a new notice.'));
  expect(proof.effects).toHaveLength(1);
  expect(proof.calls[1].key).toBe(proof.calls[0].key);
  fireEvent.submit(form); await screen.findByRole('status');
  expect(proof.effects.map(x => x.p_body)).toEqual(['Polls open at noon.', 'Polls open at one.']);
});

it('the officer desk left and opened again starts a new notice, even with the same words', async () => {
  const proof = backend();
  const onNotice = vi.fn();
  const api = {
    loadAudiences: () => loadNoticeAudiences(proof.client, { ...context, role: 'admin' }),
    publish: proof.publish,
    listMine: vi.fn().mockResolvedValue({ notices: [], hasMore: false }),
    listDrafts: vi.fn().mockResolvedValue([]),
  };
  const open = () => render(<LanguageProvider lang="en"><OfficerNoticeDesk api={api} onNotice={onNotice} /></LanguageProvider>);
  const post = async (count) => {
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Weekly reminder' } });
    fireEvent.change(screen.getByLabelText('Notice'), { target: { value: 'Polls open at noon.' } });
    const button = screen.getByRole('button', { name: 'Post notice' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(onNotice).toHaveBeenCalledTimes(count));
  };
  open(); await post(1);
  cleanup();
  open(); await post(2);
  expect(proof.calls[1].key).not.toBe(proof.calls[0].key);
  expect(proof.effects).toHaveLength(2);
});
it('Compass left and opened again starts a new draft, even with the same words', async () => {
  const proof = backend();
  const actions = { publishBroadcast: ({ title, body, operationKey }) => proof.publish(title, body, 'en', 'chapter', operationKey) };
  const view = () => render(<LanguageProvider lang="en"><CompassAnswerActions message={{ id: 'answer-a', body: 'An answer' }} actions={actions} /></LanguageProvider>);
  const send = async (role) => {
    fireEvent.click(screen.getByRole('button', { name: 'Draft announcement' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Weekly reminder' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Polls open at noon.' } });
    fireEvent.submit(screen.getByLabelText('Title').closest('form'));
    await screen.findByRole(role);
  };
  view(); await send('alert');
  cleanup();
  view(); await send('status');
  expect(proof.calls[1].key).not.toBe(proof.calls[0].key);
  expect(proof.effects).toHaveLength(2);
});

// BUG-UG-STEWARD-BROADCAST-LEFT-DURING-PUBLISH-POSTS-TWICE-20261119
// (#9253): leaving the Broadcasts page while a publish waits for its answer.
// The first case is the R-9225c reviewer's probe (reviewer-notice-inflight),
// kept as written, plus the message the page gives for the lost answer.
const UNCONFIRMED = 'We could not confirm this broadcast was published. Publish the same broadcast again to finish: it will not be posted twice.';
const HOLD = 'This broadcast is still being published. Wait for its result before you leave this page.';
it('keeps the attempted operation when its form leaves while the committed reply is pending', async () => {
  const proof = steward({ deferred: true });
  const { rerender } = render(proof.element('/m/steward/broadcasts'));
  await proof.draft();
  const dialog = screen.getByTestId('broadcast-publish-confirm');
  fireEvent.click(within(dialog).getByRole('radio', { name: 'Publish in English now and write the Spanish version next' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Publish in English' }));
  await waitFor(() => expect(proof.effects).toHaveLength(1));
  rerender(proof.element('/m/steward/requests'));
  rerender(proof.element('/m/steward/broadcasts'));
  proof.releaseReply();
  await waitFor(() => expect(proof.onNotice).toHaveBeenCalledTimes(1));
  // The page does not say the notice was not published: it may have been.
  expect(proof.onNotice.mock.calls[0][0]).toBe(UNCONFIRMED);
  const stale = screen.queryByTestId('broadcast-publish-confirm');
  if (stale) fireEvent.click(within(stale).getByRole('button', { name: 'Cancel' }));
  await proof.draft(); await proof.press(2);
  expect(proof.effects).toHaveLength(1);
  expect(proof.calls[1].key).toBe(proof.calls[0].key);
  expect(proof.onNotice.mock.calls[1][0]).toBe('Broadcast published. Now write the Spanish version: the composer is set to Spanish.');
  // Once nothing is running, leaving ends the draft as before (#9225).
  rerender(proof.element('/m/steward/requests'));
  rerender(proof.element('/m/steward/broadcasts'));
  await proof.draft(); await proof.press(3);
  expect(proof.calls[2].key).not.toBe(proof.calls[0].key);
  expect(proof.effects).toHaveLength(2);
});
it('holds leaving the Steward desk and closing the tab only while a broadcast is being published', async () => {
  const proof = steward({ deferred: true });
  render(proof.element('/m/steward/broadcasts'));
  await proof.draft();
  const dialog = screen.getByTestId('broadcast-publish-confirm');
  fireEvent.click(within(dialog).getByRole('radio', { name: 'Publish in English now and write the Spanish version next' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Publish in English' }));
  await waitFor(() => expect(proof.effects).toHaveLength(1));
  // Every in-app move (a link, a desk switch, Back) asks this guard first.
  expect(allowWorkspaceNavigation('/m/messages')).toBe(false);
  expect(proof.onNotice).toHaveBeenLastCalledWith(HOLD);
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  proof.releaseReply();
  await waitFor(() => expect(proof.onNotice).toHaveBeenLastCalledWith(UNCONFIRMED));
  const notices = proof.onNotice.mock.calls.length;
  expect(allowWorkspaceNavigation('/m/messages')).toBe(true);
  const after = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
  expect(proof.onNotice.mock.calls).toHaveLength(notices);
});
// With 20261119180000 applied on both databases, a 404 to
// the keyed call is a failure like any other: the page shows its failure line,
// sends nothing without the key, and the next press reuses the draft's key.
it.each([
  ['shared', { missing: true }, 'Notice was not published'],
  ['app', { app: true, missing: true }, 'Publish broadcast: Could not find the function'],
])('shows the failure line after a 404 through the %s publisher and posts once with the same key', async (_publisher, options, line) => {
  const proof = steward(options);
  render(proof.element('/m/steward/broadcasts'));
  await proof.draft(); await proof.press(1);
  expect(proof.onNotice.mock.calls[0][0]).toBe(line);
  expect(proof.effects).toHaveLength(0);
  await proof.press(2);
  expect(proof.onNotice.mock.calls[1][0]).toBe('Broadcast published. Now write the Spanish version: the composer is set to Spanish.');
  expect(proof.calls).toHaveLength(2);
  expect(proof.calls.every((call) => Boolean(call.key))).toBe(true);
  expect(new Set(proof.calls.map((call) => call.key)).size).toBe(1);
  expect(proof.effects).toHaveLength(1);
});
it('still names a failure the server answered', async () => {
  const proof = steward();
  const answer = proof.client.rpc.getMockImplementation();
  proof.client.rpc.mockImplementation(async (name, args) => name.startsWith('publish_') ? { data: null, error: { code: 'P0001', message: 'limit reached' } } : answer(name, args));
  render(proof.element('/m/steward/broadcasts'));
  await proof.draft(); await proof.press(1);
  expect(proof.onNotice.mock.calls[0][0]).toBe('Notice was not published');
  expect(proof.effects).toHaveLength(0);
});
it('gives the same truthful lines through the publisher the app wires to the Steward page', async () => {
  const proof = steward({ app: true });
  render(proof.element('/m/steward/broadcasts'));
  await proof.draft(); await proof.press(1);
  expect(proof.onNotice.mock.calls[0][0]).toBe(UNCONFIRMED);
  expect(proof.effects).toHaveLength(1);
});
