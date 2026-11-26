import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SharedMessageActions } from '../src/components/SharedMessageActions.jsx';
import { LanguageProvider } from '../src/lib/LanguageContext.jsx';

const cases = [['private', 'edit'], ['private', 'reply'], ['channel', 'reply']];
const capabilities = { canEdit: true, saved: false, reminders: [], reactions: [] };

async function pendingComposer(sourceKind, action) {
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const api = { messageAction: vi.fn((_kind, _id, verb) => verb === 'state' ? Promise.resolve(capabilities) : pending) };
  const onMessageChange = vi.fn(), onReply = vi.fn(), onNotice = vi.fn();
  render(<LanguageProvider lang="en"><SharedMessageActions
    sourceKind={sourceKind} message={{ id: 'm1', body: 'Original', reactions: [] }} actorId="me"
    api={api} onMessageChange={onMessageChange} onReply={onReply} onNotice={onNotice}
  /></LanguageProvider>);
  fireEvent.click(await screen.findByRole('button', { name: action === 'edit' ? 'Edit message' : 'Reply' }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Submitted text' } });
  fireEvent.click(screen.getByRole('button', { name: action === 'edit' ? 'Save edit' : 'Send reply' }));
  expect(api.messageAction).toHaveBeenLastCalledWith(sourceKind, 'm1', action, 'Submitted text');
  const response = { id: action === 'edit' ? 'm1' : 'reply-1', body: 'Submitted text' };
  return { input, resolve, reject, api, response, onMessageChange, onReply, onNotice };
}

it.each(cases)('keeps later unsent text when an earlier %s %s succeeds', async (sourceKind, action) => {
  const pending = await pendingComposer(sourceKind, action);
  expect(pending.input).toBeEnabled();
  fireEvent.change(pending.input, { target: { value: 'Later unsent words' } });
  await act(async () => { pending.resolve(pending.response); });
  expect(screen.getByRole('textbox')).toHaveValue('Later unsent words');
  expect(screen.getByRole('button', { name: action === 'edit' ? 'Save edit' : 'Send reply' })).toBeEnabled();
  expect(action === 'edit' ? pending.onMessageChange : pending.onReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(pending.response));
  expect(pending.api.messageAction).toHaveBeenCalledTimes(2);
});

it.each(cases)('closes an unchanged draft when the %s %s succeeds', async (sourceKind, action) => {
  const pending = await pendingComposer(sourceKind, action);
  await act(async () => { pending.resolve(pending.response); });
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(action === 'edit' ? pending.onMessageChange : pending.onReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(pending.response));
});

it.each(cases)('keeps a later draft when the %s %s fails transiently', async (sourceKind, action) => {
  const pending = await pendingComposer(sourceKind, action);
  fireEvent.change(pending.input, { target: { value: 'Later unsent words' } });
  await act(async () => { pending.reject(new Error('offline')); });
  expect(screen.getByRole('textbox')).toHaveValue('Later unsent words');
  expect(pending.onMessageChange).not.toHaveBeenCalled();
  expect(pending.onReply).not.toHaveBeenCalled();
  expect(pending.onNotice).toHaveBeenCalled();
});
