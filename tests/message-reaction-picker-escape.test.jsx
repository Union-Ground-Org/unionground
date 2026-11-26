import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../src/components/Dialog.jsx';
import { MessageReactionPicker } from '../src/components/MessageReactions.jsx';

afterEach(() => vi.unstubAllGlobals());

function Thread() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open thread</button>
    {open && <Dialog title="Tamarack thread" onClose={() => setOpen(false)}>
      <MessageReactionPicker aggregate={[]} onReact={() => {}} />
    </Dialog>}
  </>;
}

function openThread() {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  render(<Thread />);
  const opener = screen.getByRole('button', { name: 'Open thread' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe('reaction picker Escape inside the shared thread dialog', () => {
  it('closes the picker first, then the thread, restoring focus at each step', async () => {
    const opener = openThread();
    const trigger = screen.getByRole('button', { name: 'React' });
    trigger.focus();
    fireEvent.click(trigger);
    const choice = screen.getByRole('button', { name: 'Seen' });
    choice.focus();
    fireEvent.keyDown(choice, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Reactions' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Tamarack thread' })).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();

    fireEvent.keyDown(trigger, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
  });

  it('lets Escape on an already closed trigger dismiss the thread and restore its opener', async () => {
    const opener = openThread();
    const trigger = screen.getByRole('button', { name: 'React' });
    trigger.focus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(trigger, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
  });
});
