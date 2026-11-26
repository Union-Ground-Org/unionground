import { useEffect, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { dateTimeFormat } from "../lib/i18n.js";
import { channelPollIsClosed } from "../features/messaging/channelPollsApi.js";
import { messageActionFailureKey } from "../features/messaging/messageActionFailure.js";

const plural = (key, count) => `${key}.${count === 1 ? "one" : "many"}`;
const CLOSES_FORMAT = Object.freeze({ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// One chapter channel poll inside the thread dialog. An open poll offers one
// button per option; pressing the member's current choice takes the vote back,
// as on the phone app. A closed poll shows the results only. The server
// decides eligibility and refuses a vote after closing; its answer is the tally
// shown next.
export function ChannelPollCard({ poll, onVote }) {
  const { t, lang } = useLang();
  const [current, setCurrent] = useState(poll);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [failure, setFailure] = useState(null);
  // A reload of the thread's polls brings a fresh tally (other members'
  // votes, a changed closing time); it replaces what this card holds.
  const pollKey = JSON.stringify(poll);
  useEffect(() => { setCurrent(JSON.parse(pollKey)); }, [pollKey]);
  // Close the card when the poll's time runs out while it is on screen.
  const [clock, setClock] = useState(0);
  const closesAtMs = current.closesAt ? new Date(current.closesAt).getTime() : Number.NaN;
  useEffect(() => {
    const wait = closesAtMs - Date.now();
    if (Number.isNaN(wait) || wait <= 0) return undefined;
    // setTimeout holds at most about 24.8 days; each clock tick re-arms a later close.
    const timer = window.setTimeout(() => setClock((tick) => tick + 1), Math.min(wait + 50, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [closesAtMs, clock]);
  const failureKey = failure?.pollId === current.pollId ? failure.key : null;
  const refusedAsClosed = failureKey === "channelPoll.closed";
  const closed = refusedAsClosed || channelPollIsClosed(current);
  const withheld = current.total === null || current.options.some((option) => option.votes === null);
  const total = withheld ? null : current.options.reduce((sum, option) => sum + option.votes, 0);
  const share = (votes) => (total > 0 ? Math.round((votes / total) * 100) : 0);
  function vote(optionId) {
    return runBusyWrite(busyWriteRef, "vote", () => voteNow(optionId));
  }

  async function voteNow(optionId) {
    if (busy || closed) return;
    const pollId = current.pollId;
    setBusy(true);
    setFailure(null);
    try {
      const next = await onVote(pollId, current.mine === optionId ? null : optionId);
      if (next) setCurrent((previous) => previous.pollId === pollId ? { ...previous, ...next } : previous);
    } catch (error) {
      const key = error?.reason === "poll_closed" ? "channelPoll.closed"
        : messageActionFailureKey(error, "inbox.actionNotConfirmed");
      setFailure({ pollId, key });
    } finally {
      setBusy(false);
    }
  }
  const closesLabel = current.closesAt ? dateTimeFormat(lang, CLOSES_FORMAT).format(new Date(current.closesAt)) : "";
  return (
    <section className="channel-poll" aria-label={t("channelPoll.aria", { question: current.question })}>
      <strong className="channel-poll__question">{current.question}</strong>
      <div className="channel-poll__options">
        {current.options.map((option) => {
          const text = withheld ? option.label : `${option.label} · ${t(plural("channelPoll.votes", option.votes), { count: option.votes, percent: share(option.votes) })}`;
          return closed
            ? <p key={option.id} className={`channel-poll__option channel-poll__option--result${current.mine === option.id ? " channel-poll__option--mine" : ""}`}>{text}</p>
            : <BusyButton key={option.id} type="button" className="channel-poll__option" aria-pressed={current.mine === option.id} pending={busy} onClick={() => vote(option.id)}>{text}</BusyButton>;
        })}
      </div>
      <small className="channel-poll__meta">
        {closed
          ? <>{!refusedAsClosed && `${t("channelPoll.closed")} `}{withheld ? t("channelPoll.withheld") : t(plural("channelPoll.inTotal", total), { count: total })}</>
          : `${withheld ? t("channelPoll.withheld") : t(plural("channelPoll.soFar", total), { count: total })} ${closesLabel ? t("channelPoll.openUntil", { when: closesLabel }) : t("channelPoll.open")}`}
        {!closed && current.mine ? ` ${t("channelPoll.changeHint")}` : ""}
      </small>
      {failureKey && <p className="form-error" role="alert">{t(failureKey)}</p>}
    </section>
  );
}
