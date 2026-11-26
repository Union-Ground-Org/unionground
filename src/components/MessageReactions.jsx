import { createElement, useEffect, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { MESSAGE_REACTION_CHOICES } from "../features/messaging/reactions.js";
import { REACTION_ARTWORK } from "../features/messaging/reactionArtwork.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { FlowValue } from "./FlowValue.jsx";

function MessageReactionIcon({ kind, glyph }) {
  const art = REACTION_ARTWORK[kind];
  if (!art) return <span aria-hidden="true">{glyph}</span>;
  return <svg className="message-reaction-icon" viewBox={art.viewBox} width="28" height="28" aria-hidden="true" focusable="false">
    {art.shapes.map(({ tag, attrs }, index) => createElement(tag, {
      key: index,
      ...attrs,
      ...(attrs.fill ? { fill: art.palette[attrs.fill] ?? attrs.fill } : {}),
      ...(attrs.stroke ? { stroke: art.palette[attrs.stroke] ?? attrs.stroke } : {}),
    }))}
  </svg>;
}

function ReactionButton({ entry, busy, onReact, showCount = false }) {
  const { t } = useLang();
  const button = useRef(null);
  const animation = useRef(null);
  const reduced = useRef(true);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => {
      reduced.current = media?.matches ?? true;
      if (reduced.current) animation.current?.cancel();
    };
    update();
    media?.addEventListener?.("change", update);
    return () => { media?.removeEventListener?.("change", update); animation.current?.cancel(); };
  }, []);
  function animate(frames, duration) {
    animation.current?.cancel();
    if (reduced.current || !button.current?.animate) return;
    animation.current = button.current.animate(frames, { duration, easing: "ease-out", fill: "forwards" });
  }
  return <BusyButton ref={button} type="button" className="message-reaction-button"
    aria-label={showCount ? `${t(entry.labelKey)}: ${entry.count}` : t(entry.labelKey)}
    aria-pressed={Boolean(entry.mine)} pending={busy}
    onPointerDown={() => animate([{ transform: "scale(1)" }, { transform: "scale(.85)" }], 80)}
    onPointerCancel={() => animation.current?.cancel()}
    onPointerLeave={() => animation.current?.cancel()}
    onClick={() => {
      animate([{ transform: "scale(.85)" }, { transform: "scale(1.15)", offset: .45 }, { transform: "scale(1)" }], 240);
      onReact(entry.kind);
    }}>
    <MessageReactionIcon kind={entry.kind} glyph={entry.glyph} />
    {!showCount && <span>{t(entry.labelKey)}</span>}
    {showCount && <> <span aria-hidden="true"><FlowValue value={entry.count} /></span></>}
  </BusyButton>;
}

export function MessageReactionSummary({ aggregate, busy, onReact }) {
  const { t } = useLang();
  const visible = aggregate.filter((entry) => entry.count > 0);
  return <div className="inbox-reactions message-reaction-summary"
    role={visible.length ? "group" : undefined} aria-label={visible.length ? t("inbox.reactions") : undefined}>
    {visible.map((entry) => <ReactionButton key={entry.kind} entry={entry} busy={busy} onReact={onReact} showCount />)}
  </div>;
}

export function MessageReactionPicker({ aggregate, busy, onReact }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  return <div className="message-reaction-picker" onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <BusyButton ref={trigger} type="button" aria-label={t("inbox.react")} aria-expanded={open} pending={busy} onClick={() => setOpen(!open)}>{t("inbox.react")}</BusyButton>
    {open && <div className="message-reaction-choices" role="group" aria-label={t("inbox.reactions")}>
      {MESSAGE_REACTION_CHOICES.map((choice) => <ReactionButton key={choice.kind}
        entry={{ ...choice, mine: aggregate.some((entry) => entry.kind === choice.kind && entry.mine) }} busy={busy}
        onReact={onReact} />)}
    </div>}
  </div>;
}
