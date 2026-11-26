import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CaseMacroEditor } from '../src/components/CaseMacroEditor.jsx';
import { LanguageProvider } from '../src/lib/LanguageContext.jsx';

async function startSave() {
  let resolve, reject;
  const pending = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  const macro = { id: 'macro-1', name: 'Original macro', active: true, actions: [{ kind: 'add_note', body: 'Original body' }] };
  const api = { listMacros: vi.fn(async () => [macro]), saveMacro: vi.fn(() => pending) };
  const onNotice = vi.fn();
  render(<LanguageProvider lang="en"><CaseMacroEditor api={api} onNotice={onNotice} /></LanguageProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save macro' }));
  return { resolve, reject, api, onNotice };
}

it('retains edits made while the prior macro save is pending', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const macro = { id: 'macro-1', name: 'Original macro', active: true, actions: [{ kind: 'add_note', body: 'Original body' }] };
  const api = { listMacros: vi.fn(async () => [macro]), saveMacro: vi.fn(() => pending) };
  render(<LanguageProvider lang="en"><CaseMacroEditor api={api} /></LanguageProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save macro' }));
  expect(api.saveMacro).toHaveBeenCalledWith(expect.objectContaining({ name: 'Original macro' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A later unsaved edit' } });
  expect(screen.getByDisplayValue('A later unsaved edit')).toBeInTheDocument();
  await act(async () => { finish({}); });
  expect(screen.queryByDisplayValue('A later unsaved edit')).toBeInTheDocument();
});

it('retains action edits made while the earlier payload is being saved', async () => {
  const { resolve, api } = await startSave();
  fireEvent.change(screen.getByDisplayValue('Original body'), { target: { value: 'Later unsaved note' } });
  await act(async () => { resolve({}); });
  expect(screen.getByDisplayValue('Later unsaved note')).toBeInTheDocument();
  expect(api.saveMacro).toHaveBeenCalledTimes(1);
  expect(api.saveMacro).toHaveBeenCalledWith(expect.objectContaining({ actions: [{ kind: 'add_note', body: 'Original body' }] }));
});

it('keeps a replacement draft when a cancelled save succeeds', async () => {
  const { resolve, onNotice, api } = await startSave();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'New macro' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Replacement draft' } });
  await act(async () => { resolve({}); });
  expect(screen.getByDisplayValue('Replacement draft')).toBeInTheDocument();
  expect(onNotice).not.toHaveBeenCalled();
  expect(api.listMacros).toHaveBeenCalledTimes(2);
  expect(api.saveMacro).toHaveBeenCalledTimes(1);
});

it('does not attach a cancelled save refusal to a replacement draft', async () => {
  const { reject, onNotice } = await startSave();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'New macro' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Replacement draft' } });
  await act(async () => { reject(new Error('private backend refusal')); });
  expect(screen.getByDisplayValue('Replacement draft')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(onNotice).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Save macro' })).not.toBeDisabled();
});

it('closes an unchanged submitted draft after success and refreshes the list', async () => {
  const { resolve, api, onNotice } = await startSave();
  const submit = screen.getByRole('button', { name: 'Saving…' });
  expect(submit).toBeEnabled();
  expect(submit).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(submit);
  expect(api.saveMacro).toHaveBeenCalledTimes(1);
  await act(async () => { resolve({}); });
  expect(screen.getByRole('button', { name: 'New macro' })).toBeInTheDocument();
  expect(screen.queryByLabelText('Name')).toBeNull();
  expect(api.listMacros).toHaveBeenCalledTimes(2);
  expect(onNotice).toHaveBeenCalledWith('Macro saved.');
});

it('keeps an edited original draft and reports its save refusal', async () => {
  const { reject } = await startSave();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Still unsaved' } });
  await act(async () => { reject(new Error('private backend refusal')); });
  expect(screen.getByDisplayValue('Still unsaved')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('The macro was not saved.');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private backend refusal');
});

it('keeps a late refusal off the list after cancellation without a replacement', async () => {
  const { reject } = await startSave();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => { reject(new Error('cancelled save refused')); });
  expect(screen.getByRole('button', { name: 'New macro' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});
