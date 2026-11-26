import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SharedMessageActions } from '../src/components/SharedMessageActions.jsx';
import { expectHeldWriteFocus } from './helpers/busyWriteFocus.js';
import { messageActionChoices, messageActionLabelKey, messageActionRequest } from '../src/features/messaging/actions.js';
import { MESSAGE_REACTION_KINDS } from '../src/features/messaging/index.js';
import { toggleMemberMessageReaction, toggleMemberSavedMessage, createMemberMessageReminder } from '../src/lib/memberApi.js';
import { LanguageProvider } from '../src/lib/LanguageContext.jsx';
import { catalogue, t as translate } from '../src/lib/i18n.js';
const capabilities = { canEdit: true, saved: false, reminders: [], reactions: [] };
const message = { id: 'm1', body: 'Original', reactions: [] };

it.each([
  ['channel', 'en', 'message unavailable', 'Action not confirmed. Try again.'],
  ['channel', 'es', 'message unavailable', 'Acción no confirmada. Inténtalo de nuevo.'],
  ['private', 'en', 'message unavailable', 'Action not confirmed. Try again.'],
  ['private', 'es', 'message unavailable', 'Acción no confirmada. Inténtalo de nuevo.'],
  ['channel', 'en', 'authentication required', 'Sign in and complete the second verification step to continue.'],
  ['channel', 'es', 'authentication required', 'Inicia sesión y completa el segundo paso de verificación para continuar.'],
  ['private', 'en', 'step-up required', 'Sign in with your password or passkey to do that.'],
  ['private', 'es', 'step-up required', 'Inicia sesión con tu contraseña o llave de acceso para hacer eso.'],
])('explains a shared %s reply refusal (%s, %s)', async (sourceKind, lang, refusal, expected) => {
  const rpc = vi.fn(async (name) => name === 'get_member_message_actions'
    ? { data: capabilities }
    : { error: { code: '42501', message: refusal } });
  const api = { messageAction: (...args) => messageActionRequest({ rpc }, ...args) };
  const onNotice = vi.fn();
  const onReply = vi.fn();
  const t = (key) => translate(lang, key);
  render(<LanguageProvider lang={lang}>
    <SharedMessageActions sourceKind={sourceKind} message={message} actorId="me" api={api} onNotice={onNotice} onReply={onReply} />
  </LanguageProvider>);
  fireEvent.click(await screen.findByRole('button', { name: t('inbox.reply') }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A reply' } });
  fireEvent.click(screen.getByRole('button', { name: t('inbox.sendReply') }));
  expect(rpc).toHaveBeenLastCalledWith('reply_to_member_message', { p_source_kind: sourceKind, p_message_id: 'm1', p_body: 'A reply' });
  expect(await screen.findByRole('alert')).toHaveTextContent(expected);
  expect(onNotice.mock.calls).toEqual([[expected]]);
  expect(onReply).not.toHaveBeenCalled();
});

it.each([
  ['private', 'en', 'Action not confirmed. Try again.'],
  ['private', 'es', 'Acción no confirmada. Inténtalo de nuevo.'],
  ['channel', 'en', 'Action not confirmed. Try again.'],
  ['channel', 'es', 'Acción no confirmada. Inténtalo de nuevo.'],
])('leaves an unavailable shared %s save unconfirmed (%s)', async (sourceKind, lang, expected) => {
  const rpc = vi.fn(async (name) => name === 'get_member_message_actions'
    ? { data: capabilities }
    : { error: { code: '42501', message: 'message unavailable' } });
  const api = { messageAction: (...args) => messageActionRequest({ rpc }, ...args) };
  const onNotice = vi.fn();
  const onMessageChange = vi.fn();
  render(<LanguageProvider lang={lang}>
    <SharedMessageActions sourceKind={sourceKind} message={message} actorId="me" api={api} onNotice={onNotice} onMessageChange={onMessageChange} />
  </LanguageProvider>);
  fireEvent.click(await screen.findByRole('button', { name: translate(lang, 'inbox.saveMessage') }));
  expect(rpc).toHaveBeenLastCalledWith('act_on_member_message', {
    p_source_kind: sourceKind, p_message_id: 'm1', p_action: 'save', p_value: null,
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(expected);
  expect(onNotice.mock.calls).toEqual([[expected]]);
  expect(onMessageChange).not.toHaveBeenCalled();
});

it.each([
  ['en', 'Action not confirmed. Try again.'],
  ['es', 'Acción no confirmada. Inténtalo de nuevo.'],
])('leaves a shared private edit under a preservation order unconfirmed (%s)', async (lang, expected) => {
  const rpc = vi.fn(async (name) => name === 'get_member_message_actions'
    ? { data: capabilities }
    : { error: { code: '42501', message: 'conversation is under a preservation order' } });
  const api = { messageAction: (...args) => messageActionRequest({ rpc }, ...args) };
  const onNotice = vi.fn();
  const onMessageChange = vi.fn();
  const t = (key) => translate(lang, key);
  render(<LanguageProvider lang={lang}>
    <SharedMessageActions sourceKind="private" message={message} actorId="me" api={api} onNotice={onNotice} onMessageChange={onMessageChange} />
  </LanguageProvider>);
  fireEvent.click(await screen.findByRole('button', { name: t('inbox.editMessage') }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'An edit' } });
  fireEvent.click(screen.getByRole('button', { name: t('inbox.saveEdit') }));
  expect(rpc).toHaveBeenLastCalledWith('edit_member_message', { p_message_id: 'm1', p_body: 'An edit' });
  expect(await screen.findByRole('alert')).toHaveTextContent(expected);
  expect(onNotice.mock.calls).toEqual([[expected]]);
  expect(onMessageChange).not.toHaveBeenCalled();
});

it.each([
  ['en', Object.assign(new Error('Private conflict text'), { code: 'PT409' }), 'rpcError.conflict'],
  ['es', new TypeError('Failed to fetch'), 'offline.unconfirmed'],
])('explains an uncompleted channel reply and keeps the draft (%s)', async (lang, error, key) => {
  const api = { messageAction: vi.fn(async (_kind, _id, action) => {
    if (action === 'state') return capabilities;
    throw error;
  }) };
  const onNotice = vi.fn();
  const onReply = vi.fn();
  const t = (key) => translate(lang, key);
  render(<LanguageProvider lang={lang}>
    <SharedMessageActions sourceKind="channel" message={message} actorId="me" api={api} onNotice={onNotice} onReply={onReply} />
  </LanguageProvider>);
  fireEvent.click(await screen.findByRole('button', { name: t('inbox.reply') }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this reply' } });
  fireEvent.click(screen.getByRole('button', { name: t('inbox.sendReply') }));
  expect(await screen.findByRole('alert')).toHaveTextContent(t(key));
  expect(onNotice).toHaveBeenCalledWith(t(key));
  expect(onReply).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toHaveValue('Keep this reply');
});

// Web adapters only: the native component never executes in this file
// (tests/native-message-menu.test.jsx renders it); its sharing is anchored at
// source level in the next case.
it.each(['private', 'channel'])('memberApi adapters and the shared builder send identical %s action requests', async (kind) => {
  const rpc = vi.fn().mockResolvedValue({ data: { state: capabilities, result: { confirmed: true } } });
  const client = { rpc };
  for (const [adapter, action, value] of [[toggleMemberMessageReaction, 'react', 'like'], [toggleMemberSavedMessage, 'save', undefined], [createMemberMessageReminder, 'remind', '2026-09-08T12:00:00Z']]) {
    await adapter(client, kind, 'm1', value);
    const webCall = rpc.mock.calls.at(-1);
    await messageActionRequest(client, kind, 'm1', action, value);
    expect(rpc.mock.calls.at(-1)).toEqual(webCall);
  }
});

// A native client that merely mentions messageActionChoices( while building its
// own request object would pass a substring grep; it cannot pass this without
// importing both builders by name from the shared module and calling them.
it('native and web menus import the shared builders by name and recompute no eligibility (source check)', () => {
  const nativePath = 'apps/mobile/src/components/NativeMessageActions.tsx';
  const nativeSource = readFileSync(nativePath, 'utf8');
  const sharedImport = [...nativeSource.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';$/gm)]
    .find(([, , from]) => resolve(dirname(nativePath), from) === resolve('src/features/messaging/actions.js'));
  expect(sharedImport, 'NativeMessageActions.tsx imports src/features/messaging/actions.js').toBeTruthy();
  const imported = sharedImport[1].split(',').map((name) => name.trim());
  expect(imported).toEqual(expect.arrayContaining(['messageActionChoices', 'messageActionRequest']));
  expect(nativeSource).not.toMatch(/\b(?:function|const|let|var)\s+messageAction(?:Choices|Request)\b/);
  expect(nativeSource).toMatch(/\bmessageActionRequest\(await writer.client\(\)/);
  expect(nativeSource).toMatch(/\bmessageActionChoices\(current\)/);
  const webSource = readFileSync('src/components/SharedMessageActions.jsx', 'utf8');
  expect(webSource).toMatch(/^import \{[^}]*\bmessageActionChoices\b[^}]*\} from "\.\.\/features\/messaging\/actions\.js";$/m);
  for (const source of [nativeSource, webSource]) {
    expect(source).toContain('messageActionChoices(');
    expect(source).not.toMatch(/15\s*\*\s*60|sender_id\s*===|latestMessage/);
  }
});

it('web exposes server choices and persists edit, reply, save and reminder removal', async () => {
  const changed = vi.fn(), replied = vi.fn();
  const api = { messageAction: vi.fn(async (_kind, _id, action) => action === 'state' ? capabilities
    : action === 'edit' ? { id: 'm1', body: 'Corrected', edited_at: 'now' }
    : action === 'reply' ? { id: 'reply', parent_message_id: 'm1', body: 'Response' }
    : { state: { ...capabilities, saved: true, reminders: [{ id: 'r1' }] } }) };
  render(<SharedMessageActions sourceKind="private" message={message} actorId="me" api={api} onNotice={() => {}} onMessageChange={changed} onReply={replied} />);
  await screen.findByRole('button', { name: 'Edit message' });
  for (const choice of messageActionChoices(capabilities)) expect(screen.getByRole('button', { name: choice.label })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Corrected' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ body: 'Corrected', edited_at: 'now' })));
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Response' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
  await waitFor(() => expect(replied).toHaveBeenCalledWith(expect.objectContaining({ parent_message_id: 'm1' })));
  fireEvent.click(screen.getByRole('button', { name: 'Save message' }));
  await screen.findByRole('button', { name: 'Unsave message' });
  fireEvent.click(screen.getByRole('button', { name: 'Remove reminders' }));
  await waitFor(() => expect(api.messageAction).toHaveBeenCalledWith('private', 'm1', 'unremind', null));
});

// UX-UG-SHARED-REACTIONS-RAW-ID-AND-DUP-GROUP: this menu used to print the
// contract id, so a member chose "solidarity" here and "Solidarity" in the
// non-shared menu, and Spanish never translated at all.
it.each(['en', 'es'])('names every shared reaction option in %s, never by its contract id', async (lang) => {
  const api = { messageAction: vi.fn().mockResolvedValue(capabilities) };
  render(<LanguageProvider lang={lang}><SharedMessageActions sourceKind="private" message={message} actorId="me" api={api} onNotice={() => {}} onMessageChange={() => {}} /></LanguageProvider>);
  fireEvent.click(await screen.findByRole('button', { name: translate(lang, 'inbox.react') }));
  for (const kind of ['seen', 'agreed', 'solidarity', 'care', 'grievance', 'victory']) {
    expect(screen.getByRole('button', { name: translate(lang, `inbox.reaction.${kind}`) })).toBeInTheDocument();
  }
});

it('retries capability loading, reconciles peer reactions and cancels a draft', async () => {
  const changed = vi.fn();
  const api = { messageAction: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(capabilities) };
  render(<SharedMessageActions sourceKind="private" message={{ ...message, reactions: [{ actor_id: 'peer', reaction: 'like' }, { actor_id: 'me', reaction: 'support' }] }} actorId="me" api={api} onNotice={() => {}} onMessageChange={changed} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Load message actions' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  api.messageAction.mockResolvedValue({ state: { ...capabilities, reactions: ['like'] } });
  fireEvent.click(screen.getByRole('button', { name: 'Like: 1' }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'Like: 2' })).toHaveAttribute('aria-pressed', 'true');
});

it.each([['private', 'reply'], ['private', 'edit'], ['channel', 'reply']])('%s %s preserves unsent text across equivalent snapshots', async (sourceKind, action) => {
  const api = { messageAction: vi.fn().mockResolvedValue(capabilities) };
  const props = { sourceKind, message, actorId: 'me', api, onNotice: vi.fn(), onMessageChange: vi.fn(), onReply: vi.fn() };
  const view = render(<SharedMessageActions {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: action === 'edit' ? 'Edit message' : 'Reply' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsent member response' } });
  await act(async () => view.rerender(<SharedMessageActions {...props} message={{ ...message, reactions: [] }} />));
  expect(screen.getByRole('textbox')).toHaveValue('Unsent member response');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

it.each(['id', 'actor', 'source', 'redaction', 'authorization', 'eligibility'])('resets an edit draft on a relevant %s transition', async (transition) => {
  const api = { messageAction: vi.fn().mockResolvedValue(capabilities) };
  const props = { sourceKind: 'private', message, actorId: 'me', api, onNotice: vi.fn(), onMessageChange: vi.fn() };
  const view = render(<SharedMessageActions {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsent edit' } });
  if (transition === 'authorization') api.messageAction.mockRejectedValue(Object.assign(new Error('denied'), { code: '42501' }));
  if (transition === 'eligibility') api.messageAction.mockResolvedValue({ ...capabilities, canEdit: false });
  await act(async () => view.rerender(<SharedMessageActions {...props}
    actorId={transition === 'actor' ? 'other' : 'me'} sourceKind={transition === 'source' ? 'channel' : 'private'}
    message={{ ...message, id: transition === 'id' ? 'm2' : 'm1', redacted_at: transition === 'redaction' ? 'now' : null }} />));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

it('preserves a reply during eligibility loss, transient refresh failure and unrelated actions', async () => {
  const changed = vi.fn();
  const api = { messageAction: vi.fn().mockResolvedValue(capabilities) };
  const props = { sourceKind: 'private', message, actorId: 'me', api, onNotice: vi.fn(), onMessageChange: changed };
  const view = render(<SharedMessageActions {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this reply' } });
  api.messageAction.mockResolvedValue({ ...capabilities, canEdit: false });
  await act(async () => view.rerender(<SharedMessageActions {...props} message={{ ...message }} />));
  expect(screen.queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument();
  api.messageAction.mockRejectedValueOnce(new Error('offline'));
  await act(async () => view.rerender(<SharedMessageActions {...props} message={{ ...message }} />));
  expect(screen.getByRole('textbox')).toHaveValue('Keep this reply');
  api.messageAction.mockResolvedValue({ state: { ...capabilities, saved: true } });
  fireEvent.click(screen.getByRole('button', { name: 'Save message' }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(screen.getByRole('textbox')).toHaveValue('Keep this reply');
});

it.each(['reply', 'edit'])('a pending %s survives refresh and clears only after confirmation', async (action) => {
  let finish;
  const changed = vi.fn(), replied = vi.fn();
  const api = { messageAction: vi.fn().mockResolvedValue(capabilities) };
  const props = { sourceKind: 'private', message, actorId: 'me', api, onNotice: vi.fn(), onMessageChange: changed, onReply: replied };
  const view = render(<SharedMessageActions {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: action === 'edit' ? 'Edit message' : 'Reply' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Confirmed draft' } });
  api.messageAction.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: action === 'edit' ? 'Save edit' : 'Send reply' }));
  await act(async () => view.rerender(<SharedMessageActions {...props} message={{ ...message, reactions: [{actor_id:'peer',reaction:'like'}] }} />));
  expect(screen.getByRole('textbox')).toHaveValue('Confirmed draft');
  expect(screen.getByRole('button', { name: action === 'edit' ? 'Save edit' : 'Send reply' })).toHaveAttribute("aria-disabled", "true");
  await act(async () => finish({id: action === 'edit' ? 'm1' : 'r1', body:'Confirmed draft'}));
  expect(action === 'edit' ? changed : replied).toHaveBeenCalledWith(expect.objectContaining({ body:'Confirmed draft' }));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  if (action === 'edit') expect(changed.mock.calls[0][0].reactions).toEqual([{actor_id:'peer',reaction:'like'}]);
});

it('denial retains the composer and late acknowledgements cannot cross a row boundary', async () => {
  let finish;
  const changed = vi.fn(), notice = vi.fn();
  const api = { messageAction: vi.fn().mockResolvedValue(capabilities) };
  const props = { sourceKind: 'private', message, actorId: 'me', api, onNotice: notice, onMessageChange: changed };
  const view = render(<SharedMessageActions {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }));
  api.messageAction.mockRejectedValueOnce(new Error('denied'));
  fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
  await waitFor(() => expect(notice).toHaveBeenCalledWith('Action not confirmed. Try again.'));
  expect(screen.getByRole('textbox')).toHaveValue('Original');
  api.messageAction.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
  expect(screen.getByRole('button', { name: 'Save edit' })).toHaveAttribute("aria-disabled", "true");
  view.rerender(<SharedMessageActions {...props} message={{ ...message, id: 'm2' }} />);
  await act(async () => finish({ id: 'm1', body: 'Late' }));
  expect(changed).not.toHaveBeenCalled();
});

it('keeps native English choice labels and maps each one onto a catalogue key', () => {
  const idle = messageActionChoices(capabilities);
  expect(idle).toEqual([
    { id: 'reply', label: 'Reply' },
    { id: 'edit', label: 'Edit message' },
    { id: 'react', label: 'React' },
    { id: 'save', label: 'Save message' },
    { id: 'remind', label: 'Remind me…' },
  ]);
  expect(idle.map(messageActionLabelKey)).toEqual([
    'inbox.reply',
    'inbox.editMessage',
    'inbox.react',
    'inbox.saveMessage',
    'inbox.remindMe',
  ]);
  for (const choice of idle) {
    expect(catalogue.en[messageActionLabelKey(choice)]).toBe(choice.label);
    expect(catalogue.es[messageActionLabelKey(choice)]).toBeTruthy();
  }
  const flipped = messageActionChoices({ ...capabilities, saved: true, reminders: [{}] });
  expect(flipped).toContainEqual({ id: 'save', label: 'Unsave message' });
  expect(flipped).toContainEqual({ id: 'unremind', label: 'Remove reminders' });
  expect(messageActionLabelKey(flipped.find((choice) => choice.id === 'save'))).toBe('inbox.unsaveMessage');
  expect(messageActionLabelKey(flipped.find((choice) => choice.id === 'unremind'))).toBe('inbox.removeReminders');
  expect(catalogue.en['inbox.unsaveMessage']).toBe('Unsave message');
  expect(catalogue.en['inbox.removeReminders']).toBe('Remove reminders');
});

it('renders the shared action row entirely from the Spanish catalogue under lang="es"', async () => {
  const es = catalogue.es;
  const notice = vi.fn();
  const api = { messageAction: vi.fn() };
  api.messageAction
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(async (_kind, _id, action) => action === 'state' ? capabilities
      : { state: { ...capabilities, saved: true, reminders: [{ id: 'r1' }] } });
  render(<LanguageProvider lang="es">
    <SharedMessageActions sourceKind="private" message={{ ...message, reactions: [{ actor_id: 'peer', reaction: 'care' }] }} actorId="me" api={api} onNotice={notice} onMessageChange={vi.fn()} onReply={vi.fn()} />
  </LanguageProvider>);

  // Capabilities unloaded: the load control itself resolves from the catalogue.
  expect(await screen.findByRole('button', { name: es['inbox.loadMessageActions'] })).toBeEnabled();
  expect(document.body.textContent ?? '').not.toContain('Load message actions');
  fireEvent.click(screen.getByRole('button', { name: es['inbox.loadMessageActions'] }));

  // Capabilities loaded: every choice control and both named groups resolve
  // in Spanish. A summary is named only when it has a counted reaction.
  for (const name of [es['inbox.reply'], es['inbox.editMessage'], es['inbox.saveMessage'], es['inbox.remindMe']]) {
    expect(await screen.findByRole('button', { name })).toBeEnabled();
  }
  expect(screen.getByRole('button', { name: es['inbox.react'] })).toBeEnabled();
  expect(screen.getByRole('group', { name: es['inbox.messageActions'] })).toBeInTheDocument();
  const summary = screen.getByRole('group', { name: es['inbox.reactions'] });
  expect(within(summary).getByRole('button', { name: `${es['inbox.reaction.care']}: 1`, pressed: false })).toBeEnabled();

  // The edit and reply composers carry Spanish field labels and controls.
  fireEvent.click(screen.getByRole('button', { name: es['inbox.editMessage'] }));
  expect(screen.getByRole('textbox', { name: es['inbox.editMessage'] })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: es['inbox.saveEdit'] })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: es['inbox.cancel'] }));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: es['inbox.reply'] }));
  expect(screen.getByRole('textbox', { name: es['inbox.replyToMessage'] })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: es['inbox.sendReply'] })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: es['inbox.cancel'] }));

  // A confirmed action announces success; a rejected one announces the retry
  // notice — both from the Spanish catalogue. The flipped saved/reminder
  // states keep Spanish labels too.
  fireEvent.click(screen.getByRole('button', { name: es['inbox.saveMessage'] }));
  await waitFor(() => expect(notice).toHaveBeenCalledWith(es['inbox.actionSaved']));
  expect(await screen.findByRole('button', { name: es['inbox.unsaveMessage'] })).toBeEnabled();
  expect(await screen.findByRole('button', { name: es['inbox.removeReminders'] })).toBeEnabled();
  api.messageAction.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: es['inbox.unsaveMessage'] }));
  await waitFor(() => expect(notice).toHaveBeenCalledWith(es['inbox.actionNotConfirmed']));

  // No English chrome string from this file remains on the surface. 'Cancel'
  // needs a word boundary because the canon Spanish is 'Cancelar'.
  const body = document.body.textContent ?? '';
  for (const literal of ['Load message actions', 'Save edit', 'Send reply', 'Message action saved.', 'Action not confirmed. Try again.', 'Reply', 'Edit message', 'Reply to message', 'Save message', 'Unsave message', 'Remind me…', 'Remove reminders', 'Message actions', 'Reactions', 'React']) {
    expect(body, `English literal leaked: ${literal}`).not.toContain(literal);
  }
  expect(body).not.toMatch(/\bCancel\b/);
  for (const element of document.querySelectorAll('[aria-label]')) {
    const label = element.getAttribute('aria-label');
    for (const english of ['Reactions', 'Message actions', 'React']) {
      expect(label, `English aria-label present: ${label}`).not.toBe(english);
    }
  }
});

// A11Y-UG-MESSAGE-REPLY-CANCEL-LOSES-FOCUS-20261108: cancelling Reply
// removed the focused Cancel button and left document.activeElement on BODY.
// Enter activates that button in a browser; jsdom does not, so this test
// focuses Cancel and clicks it, which is the activation Enter performs.
// tests/reply-cancel-focus-browser.test.js tabs to Cancel and presses Enter.
it('returns focus to the exact Reply control on cancel and send, and keeps a failed draft focused', async () => {
  const notices = [];
  const secondNotices = [];
  const replies = [];
  let rejectKept;
  const api = {
    messageAction: vi.fn(async (_kind, id, action, value) => {
      if (action === 'state') return capabilities;
      if (action === 'reply') {
        if (id === 'm2' && value === 'Keep this draft') await new Promise((_resolve, reject) => { rejectKept = reject; });
        return { id: `${id}-reply`, parent_message_id: id, body: value };
      }
      return { state: { ...capabilities } };
    }),
  };
  const row = (id, body) => ({ id, body, reactions: [] });
  render(<>
    <article aria-label="First message"><p>The hall opens at six.</p>
      <SharedMessageActions sourceKind="private" message={row('m1', 'The hall opens at six.')} actorId="me" api={api} onNotice={(text) => notices.push(text)} onMessageChange={vi.fn()} onReply={(sent) => replies.push(sent)} />
    </article>
    <article aria-label="Second message"><p>Bring the printed agenda.</p>
      <SharedMessageActions sourceKind="private" message={row('m2', 'Bring the printed agenda.')} actorId="me" api={api} onNotice={(text) => secondNotices.push(text)} onMessageChange={vi.fn()} onReply={vi.fn()} />
    </article>
  </>);
  const first = screen.getByRole('article', { name: 'First message' });
  const second = screen.getByRole('article', { name: 'Second message' });
  const firstReply = await within(first).findByRole('button', { name: 'Reply' });
  const secondReply = await within(second).findByRole('button', { name: 'Reply' });

  fireEvent.click(secondReply);
  fireEvent.change(within(second).getByRole('textbox'), { target: { value: 'Keep this draft' } });
  fireEvent.click(firstReply);
  fireEvent.change(within(first).getByRole('textbox'), { target: { value: 'Discard this draft' } });
  const cancel = within(first).getByRole('button', { name: 'Cancel' });
  cancel.focus();
  expect(cancel).toHaveFocus();
  fireEvent.keyDown(cancel, { key: 'Enter' });
  fireEvent.click(cancel);
  await waitFor(() => expect(firstReply).toHaveFocus());
  expect(within(first).queryByRole('textbox')).not.toBeInTheDocument();
  expect(first).not.toHaveTextContent('Discard this draft');
  expect(within(second).getByRole('textbox')).toHaveValue('Keep this draft');
  expect(second).toHaveTextContent('Bring the printed agenda.');

  fireEvent.click(firstReply);
  expect(within(first).getByRole('textbox')).toHaveValue('');
  fireEvent.change(within(first).getByRole('textbox'), { target: { value: 'Sent from the hall' } });
  fireEvent.click(within(first).getByRole('button', { name: 'Send reply' }));
  await waitFor(() => expect(replies).toEqual([expect.objectContaining({ parent_message_id: 'm1', body: 'Sent from the hall' })]));
  await waitFor(() => expect(firstReply).toHaveFocus());
  expect(within(first).queryByRole('textbox')).not.toBeInTheDocument();
  expect(within(second).getByRole('textbox')).toHaveValue('Keep this draft');

  const send = within(second).getByRole('button', { name: 'Send reply' });
  fireEvent.click(send);
  await act(async () => {});
  act(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await act(async () => { rejectKept(new Error('offline')); });
  await waitFor(() => expect(within(second).getByRole('textbox')).toHaveFocus());
  expect(within(second).getByRole('textbox')).toHaveValue('Keep this draft');
  expect(secondNotices.at(-1)).toBe('Action not confirmed. Try again.');
  expect(notices.at(-1)).toBe('Message action saved.');
  expect(within(first).queryByRole('textbox')).not.toBeInTheDocument();
  expect(firstReply).not.toHaveFocus();
});

it('keeps Send reply focused while the reply is sent, and sends it once (#8435)', async () => {
  const api = { messageAction: vi.fn().mockResolvedValue(capabilities) };
  render(<SharedMessageActions sourceKind="private" message={message} actorId="me" api={api} onNotice={vi.fn()} onMessageChange={vi.fn()} onReply={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'On my way' } });
  const before = api.messageAction.mock.calls.length;
  api.messageAction.mockImplementation(async () => ({ id: 'r1', body: 'On my way' }));
  await expectHeldWriteFocus(api.messageAction, screen.getByRole('button', { name: 'Send reply' }));
  expect(api.messageAction).toHaveBeenCalledTimes(before + 1);
});

it('sends a reaction chosen from the shared picker through the message action (#8435)', async () => {
  const api = { messageAction: vi.fn().mockResolvedValue(capabilities) };
  render(<SharedMessageActions sourceKind="private" message={message} actorId="me" api={api} onNotice={vi.fn()} onMessageChange={vi.fn()} onReply={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'React' }));
  api.messageAction.mockImplementation(async () => ({ reacted: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Care' }));
  await waitFor(() => expect(api.messageAction).toHaveBeenCalledWith('private', 'm1', 'react', 'care'));
});

it('sends a reply when the host passes no reply callback (#8435)', async () => {
  const api = { messageAction: vi.fn().mockResolvedValue(capabilities) };
  render(<SharedMessageActions sourceKind="private" message={message} actorId="me" api={api} onNotice={vi.fn()} onMessageChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Thanks' } });
  api.messageAction.mockImplementation(async () => ({ id: 'r1', body: 'Thanks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
});
