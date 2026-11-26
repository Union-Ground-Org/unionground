import { useEffect, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import {
  MAX_SHORTCUTS,
  normalizeShortcutKeys,
  SHORTCUT_CATALOG,
} from "../lib/navigationPreferences.js";
import { Dialog } from "./Dialog.jsx";
import { NavGlyph } from "./NavGlyphs.jsx";

function itemFor(key) {
  return SHORTCUT_CATALOG.find((item) => item.key === key) ?? null;
}

function ShortcutEditor({ keys, onChange, onClose }) {
  const { t } = useLang();
  const [announcement, setAnnouncement] = useState("");
  const chosen = keys.map(itemFor).filter(Boolean);
  const available = SHORTCUT_CATALOG.filter((item) => !keys.includes(item.key));
  const controlsRef = useRef(new Map());
  const pendingFocusRef = useRef(null);

  // The pressed control can unmount (add/remove) or become disabled (edge reorder),
  // so after each edit focus the first still-enabled control named for that shortcut.
  useEffect(() => {
    const candidates = pendingFocusRef.current;
    if (!candidates) return;
    pendingFocusRef.current = null;
    const controls = controlsRef.current;
    const target = candidates.map((id) => controls.get(id)).find((element) => element?.isConnected && !element.disabled)
      ?? [...controls.values()].find((element) => element?.isConnected && !element.disabled);
    target?.focus();
  });

  const control = (id) => (element) => {
    if (element) controlsRef.current.set(id, element);
    else controlsRef.current.delete(id);
  };

  const move = (index, delta) => {
    const to = index + delta;
    if (to < 0 || to >= keys.length) return;
    const next = [...keys];
    [next[index], next[to]] = [next[to], next[index]];
    const key = keys[index];
    const [same, opposite] = delta < 0 ? ["up", "down"] : ["down", "up"];
    pendingFocusRef.current = [`${same}:${key}`, `${opposite}:${key}`, `remove:${key}`];
    onChange(next);
    setAnnouncement(t("pinned.moved", { label: t(chosen[index].labelKey), position: to + 1, count: next.length }));
  };

  const remove = (item) => {
    pendingFocusRef.current = [`add:${item.key}`];
    onChange(keys.filter((key) => key !== item.key));
    setAnnouncement(t("pinned.removed", { label: t(item.labelKey) }));
  };

  const add = (item) => {
    pendingFocusRef.current = [`remove:${item.key}`, `up:${item.key}`];
    onChange([...keys, item.key]);
    setAnnouncement(t("pinned.added", { label: t(item.labelKey) }));
  };

  return (
    <Dialog eyebrow={t("pinned.customize")} title={t("pinned.editorTitle")} onClose={onClose}>
      <p className="pinned-editor__sub">{t("pinned.editorSub", { max: MAX_SHORTCUTS })}</p>
      <p className="visually-hidden" aria-live="polite">{announcement}</p>
      <h3 className="morehub-eyebrow">{t("pinned.chosen")}</h3>
      <ul className="pinned-editor__list">
        {chosen.map((item, index) => {
          const label = t(item.labelKey);
          return (
            <li key={item.key} className="pinned-editor__row">
              <span className="pinned-editor__icon" aria-hidden="true"><NavGlyph name={item.key} fallback={item.icon} /></span>
              <span className="pinned-editor__label">{label}</span>
              <button ref={control(`up:${item.key}`)} type="button" aria-label={t("pinned.moveUp", { label })} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
              <button ref={control(`down:${item.key}`)} type="button" aria-label={t("pinned.moveDown", { label })} disabled={index === chosen.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button ref={control(`remove:${item.key}`)} type="button" aria-label={t("pinned.remove", { label })} disabled={keys.length === 1} onClick={() => remove(item)}>×</button>
            </li>
          );
        })}
      </ul>
      <h3 className="morehub-eyebrow">{t("pinned.available")}</h3>
      {keys.length >= MAX_SHORTCUTS && <p className="pinned-editor__note">{t("pinned.full", { max: MAX_SHORTCUTS })}</p>}
      <ul className="pinned-editor__list">
        {available.map((item) => {
          const label = t(item.labelKey);
          return (
            <li key={item.key} className="pinned-editor__row">
              <span className="pinned-editor__icon" aria-hidden="true"><NavGlyph name={item.key} fallback={item.icon} /></span>
              <span className="pinned-editor__label">{label}</span>
              <button ref={control(`add:${item.key}`)} type="button" aria-label={t("pinned.add", { label })} disabled={keys.length >= MAX_SHORTCUTS} onClick={() => add(item)}>＋</button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

export function PinnedShortcuts({ keys, hasStewardRole = false, onChange, onNavigate, onAsk }) {
  const { t } = useLang();
  const [editing, setEditing] = useState(false);
  const customizeRef = useRef(null);
  const normalized = normalizeShortcutKeys(keys, hasStewardRole);

  const activate = (event, item) => {
    if (item.action === "assistant") {
      onAsk?.();
      return;
    }
    // A modified or non-primary click on the tile anchor is the browser's:
    // let it open the shortcut in a new tab or window.
    if (event && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
    if (event) event.preventDefault();
    onNavigate?.(item.viewKey ?? item.key, item.path);
  };

  return (
    <section className="pinned-shortcuts">
      <div className="pinned-shortcuts__head">
        <h3 className="morehub-eyebrow">{t("pinned.title")}</h3>
        <button ref={customizeRef} type="button" className="pinned-shortcuts__customize" onClick={() => setEditing(true)}>{t("pinned.customize")}</button>
      </div>
      <nav className="pinned-shortcuts__grid" aria-label={t("pinned.label")}>
        {normalized.map((key) => {
          const item = itemFor(key);
          // A Compass tile with no opener (the organization switched Compass
          // off) renders nothing rather than a dead button.
          if (!item || (item.action === "assistant" && !onAsk)) return null;
          const content = <><span aria-hidden="true"><NavGlyph name={item.key} fallback={item.icon} /></span><span>{t(item.labelKey)}</span></>;
          return item.action === "assistant" ? (
            <button key={item.key} type="button" className="pinned-shortcuts__tile" aria-haspopup="dialog" onClick={(event) => activate(event, item)}>{content}</button>
          ) : (
            <a key={item.key} className="pinned-shortcuts__tile" href={item.path} onClick={(event) => activate(event, item)}>{content}</a>
          );
        })}
      </nav>
      {editing && (
        <ShortcutEditor
          keys={normalized}
          onChange={(next) => onChange?.(normalizeShortcutKeys(next, hasStewardRole))}
          onClose={() => { setEditing(false); customizeRef.current?.focus(); }}
        />
      )}
    </section>
  );
}
