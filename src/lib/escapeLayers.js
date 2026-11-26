// One Escape press must reach exactly one surface. Several overlays can be
// mounted at once (a Dialog above the rail-shell Compass panel, the command
// palette over a page, the Tasks shortcuts sheet beside the assistant), and
// each used to install its own window keydown listener, so a single press
// closed every layer at once — including the non-modal Compass panel and its
// unsent draft. This module keeps a single shared window listener and a
// module-level stack of Escape owners instead:
//
// - A layer registers with registerEscapeLayer(handler, { modal }) and gets
//   back an unregister function. Registration order is the stacking order.
// - The most recently registered MODAL layer wins the key. Non-modal layers
//   only receive Escape when no modal layer is registered at all.
// - The winner's handler runs, then the shared listener preventDefaults.
//   A handler may return false to decline the key (e.g. a dialog mid-close),
//   in which case nothing is prevented and no other layer is consulted —
//   matching the old bespoke listeners' "swallow the key" behavior.
// - Unregistering is by layer identity, never by pop, so independent mount
//   flags (App mounts the assistant and dialogs from separate state) can
//   unmount in any order without corrupting the stack.
// - A non-modal winner also yields to any open aria-modal surface that still
//   owns its Escape through its own listener (TaskModal, WorkstreamSettings,
//   the task delete confirm): the shared listener was usually installed first
//   by the panel, so it would otherwise run before them and close the panel.
//   Nothing is prevented, so that surface's listener answers the key.
//
// This file is framework-free on purpose: the surfaces that register are the
// owners of their own close semantics (Dialog's beforeClose guard, the panel's
// draft preservation, the palette's focus restore).

const layers = [];
let nextLayerId = 0;
let sharedListenerInstalled = false;

function sharedKeyDown(event) {
  if (event.key !== "Escape") return;
  let winner = null;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    if (layers[index].modal) {
      winner = layers[index];
      break;
    }
    if (!winner) winner = layers[index];
  }
  if (!winner) return;
  if (!winner.modal && typeof document !== "undefined" && document.querySelector('[aria-modal="true"]')) return;
  if (winner.handler(event) === false) return;
  event.preventDefault();
}

function ensureSharedListener() {
  if (sharedListenerInstalled || typeof window === "undefined") return;
  window.addEventListener("keydown", sharedKeyDown);
  sharedListenerInstalled = true;
}

function releaseSharedListener() {
  if (!sharedListenerInstalled || layers.length > 0 || typeof window === "undefined") return;
  window.removeEventListener("keydown", sharedKeyDown);
  sharedListenerInstalled = false;
}

/**
 * Register an Escape owner. Returns an unregister function (idempotent).
 * @param {(event: KeyboardEvent) => void | false} handler return false to
 *   decline the key entirely (no preventDefault, no fallback layer).
 * @param {{ modal?: boolean }} options modal layers outrank non-modal ones.
 */
export function registerEscapeLayer(handler, { modal = false } = {}) {
  const layer = { id: ++nextLayerId, handler, modal: Boolean(modal) };
  layers.push(layer);
  ensureSharedListener();
  return () => {
    const index = layers.indexOf(layer);
    if (index === -1) return;
    layers.splice(index, 1);
    releaseSharedListener();
  };
}

/**
 * True while a modal surface owns the keyboard: a registered modal layer, or
 * any open aria-modal surface that still keeps its own listener. Non-modal
 * layers (the desktop Compass panel) do not count, so shortcuts beside them
 * keep working. Used by the desktop rail's Ctrl/Cmd+digit listener.
 */
export function hasOpenModalLayer() {
  if (layers.some((layer) => layer.modal)) return true;
  return typeof document !== "undefined" && Boolean(document.querySelector('[aria-modal="true"]'));
}

/** Test-only snapshot of the live stack (newest last). */
export function escapeLayersSnapshot() {
  return layers.map((layer) => ({ id: layer.id, modal: layer.modal }));
}
