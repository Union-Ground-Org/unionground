import { prepareBusyWrite } from "../../lib/busyWrite.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Mail, Megaphone } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { localeFor } from "../../lib/i18n.js";
import { isFeatureEnabled } from "../../lib/featureSwitches.js";
import {
  HOME_TAKEOVER_RPC,
  HOME_TAKEOVER_SWITCH,
  hideReadTakeoverItems,
  homeTakeoverFromSnapshot,
  homeTakeoverSignature,
  normalizeHomeTakeover,
} from "./takeover.js";
import "./homeTakeover.css";

const EMPTY = Object.freeze({ enabled: false, message: null, broadcast: null });

// REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001: the old override
// slot. The newest unread steward message and the newest unread broadcast sit
// above everything else on member Home until the member opens them or marks
// them read; the next unread item then takes the slot.
//
// Live accounts read get_member_home_takeover(), which enforces the
// organization switch on the server. Fixture sessions (SAMPLE/PREVIEW) derive
// the same items from the snapshot they already hold. `transport` is App's
// learningContent wiring: the per-session captured-client factory and session.
export function HomeTakeover({
  data,
  transport = null,
  onOpenConversation,
  onOpenBroadcast,
  onMarkConversationRead,
  onMarkBroadcastRead,
}) {
  const switchOn = isFeatureEnabled(data?.organizationConfiguration, HOME_TAKEOVER_SWITCH, true);
  const preview = transport?.preview === true;
  const accessToken = typeof transport?.session?.access_token === "string" ? transport.session.access_token : null;
  const createSessionClient = typeof transport?.createSessionClient === "function" ? transport.createSessionClient : null;
  const signature = homeTakeoverSignature(data);
  const [live, setLive] = useState(EMPTY);
  const [dismissed, setDismissed] = useState(() => new Set());
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (preview || !switchOn || !accessToken || !createSessionClient) {
      setLive(EMPTY);
      return undefined;
    }
    let active = true;
    let client;
    try { client = createSessionClient({ access_token: accessToken }); } catch { client = null; }
    if (!client || typeof client.rpc !== "function") return undefined;
    Promise.resolve(client.rpc(HOME_TAKEOVER_RPC))
      .then((result) => {
        if (!active) return;
        // A refused or failed read renders nothing: Home stays usable and the
        // feed still lists every broadcast.
        setLive(result?.error ? EMPTY : normalizeHomeTakeover(result?.data));
      })
      .catch(() => { if (active) setLive(EMPTY); });
    return () => { active = false; };
  }, [preview, switchOn, accessToken, createSessionClient, signature, reloadKey]);

  const takeover = useMemo(() => {
    if (!switchOn) return EMPTY;
    const source = preview ? homeTakeoverFromSnapshot(data) : live;
    const visible = hideReadTakeoverItems(source, data);
    return {
      enabled: visible.enabled,
      message: visible.message && !dismissed.has(`m:${visible.message.id}`) ? visible.message : null,
      broadcast: visible.broadcast && !dismissed.has(`b:${visible.broadcast.id}`) ? visible.broadcast : null,
    };
  }, [switchOn, preview, data, live, dismissed]);

  if (!takeover.message && !takeover.broadcast) return null;

  const markedRead = (key) => {
    setDismissed((current) => new Set(current).add(key));
    setReloadKey((value) => value + 1);
  };

  return (
    <HomeTakeoverRegion
      takeover={takeover}
      onOpenConversation={onOpenConversation}
      onOpenBroadcast={onOpenBroadcast}
      onMarkConversationRead={onMarkConversationRead}
      onMarkBroadcastRead={onMarkBroadcastRead}
      onMarkedRead={markedRead}
    />
  );
}

function HomeTakeoverRegion({ takeover, onOpenConversation, onOpenBroadcast, onMarkConversationRead, onMarkBroadcastRead, onMarkedRead }) {
  const { t } = useLang();
  return (
    <section className="home-takeover" aria-label={t("homeTakeover.region")}>
      {takeover.message ? (
        <TakeoverCard
          kind="message"
          key={`m:${takeover.message.id}`}
          eyebrow={t("homeTakeover.messageEyebrow")}
          title={takeover.message.senderName
            ? t("homeTakeover.messageFrom", { name: takeover.message.senderName })
            : t("homeTakeover.messageFromSteward")}
          body={takeover.message.body}
          truncated={takeover.message.truncated}
          at={takeover.message.createdAt}
          openLabel={t("homeTakeover.openConversation")}
          onOpen={onOpenConversation ? () => onOpenConversation(takeover.message.conversationId) : null}
          onMarkRead={onMarkConversationRead ? () => onMarkConversationRead(takeover.message.conversationId) : null}
          onMarkedRead={() => onMarkedRead(`m:${takeover.message.id}`)}
        />
      ) : null}
      {takeover.broadcast ? (
        <TakeoverCard
          kind="broadcast"
          key={`b:${takeover.broadcast.id}`}
          eyebrow={takeover.broadcast.audience === "chapter" ? t("homeTakeover.broadcastEyebrowChapter") : t("homeTakeover.broadcastEyebrow")}
          title={takeover.broadcast.title}
          byline={takeover.broadcast.sender}
          body={takeover.broadcast.body}
          truncated={takeover.broadcast.truncated}
          at={takeover.broadcast.publishedAt}
          openLabel={t("homeTakeover.openBroadcast")}
          onOpen={onOpenBroadcast ? () => onOpenBroadcast(takeover.broadcast.id) : null}
          onMarkRead={onMarkBroadcastRead ? () => onMarkBroadcastRead(takeover.broadcast.id) : null}
          onMarkedRead={() => onMarkedRead(`b:${takeover.broadcast.id}`)}
        />
      ) : null}
    </section>
  );
}

function TakeoverCard({ kind, eyebrow, title, byline = null, body, truncated, at, openLabel, onOpen, onMarkRead, onMarkedRead }) {
  const busyWriteRef = useRef(new Set());
  const { t, lang } = useLang();
  const titleId = useId();
  const [state, setState] = useState("idle");
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const when = new Date(at).toLocaleDateString(localeFor(lang), { month: "short", day: "numeric" });
  const Icon = kind === "message" ? Mail : Megaphone;

  async function markRead() {
    return prepareBusyWrite(busyWriteRef, "markRead:145", () => {
      if (!onMarkRead) return;
      return async (releaseBusyWrite) => {
      try {
      setState("busy");
      try {
        await onMarkRead();
        if (!mounted.current) { return; }
        setState("idle");
        onMarkedRead();
      } catch {
        if (mounted.current) setState("failed");
      }

      } finally { releaseBusyWrite(); }
    };
    });
  }

  return (
    <article className={`home-takeover__card home-takeover__card--${kind}`} aria-labelledby={titleId}>
      <header className="home-takeover__head">
        <span className="home-takeover__icon" aria-hidden="true"><Icon size={17} /></span>
        <span className="home-takeover__eyebrow">{eyebrow}</span>
        <span className="home-takeover__when">{when}</span>
      </header>
      <h2 id={titleId} className="home-takeover__title">{title}</h2>
      {byline ? <p className="home-takeover__byline">{byline}</p> : null}
      {body ? <p className="home-takeover__body">{truncated ? `${body.trimEnd()}…` : body}</p> : null}
      <div className="home-takeover__actions">
        {onOpen ? (
          <button type="button" className="home-takeover__open" onClick={onOpen}>{openLabel}</button>
        ) : null}
        {onMarkRead ? (
          <BusyButton type="button" className="home-takeover__read" onClick={markRead} pending={state === "busy"} aria-busy={state === "busy"}>
            {state === "busy" ? t("homeTakeover.marking") : t("homeTakeover.markRead")}
          </BusyButton>
        ) : null}
      </div>
      {state === "failed" ? <p className="home-takeover__error" role="alert">{t("homeTakeover.markFailed")}</p> : null}
    </article>
  );
}
