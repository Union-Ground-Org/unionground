// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029.
//
// Guide 1 on screen, "Getting the organization started": a card at the top of
// a staff hat's home for people with an organization-wide role, from
// orgStartGuide(payload).view. "Continue setup" opens the seven milestones in
// place (one open at a time); each says what has to exist, who can do it and
// opens the real screen. Nothing here is a dialog and nothing moves focus;
// a milestone that finishes is announced once, politely.
import { useEffect, useId, useRef, useState } from "react";
import { Check, Lock } from "lucide-react";
import { celebrate, celebrateOnce } from "../../lib/celebrate.js";
import { useLang } from "../../lib/LanguageContext.jsx";
import { renderGuideCopy } from "./memberAdapter.js";
import { newlyDoneMilestones } from "./orgStart.js";
import { OrgStartGuideCard } from "./OrgStartGuideCard.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

const ROLE_KEYS = { admin: "guideEngine.role.admin", vp: "guideEngine.role.vpOrg", coordinator: "guideEngine.role.coordinator", advisor: "guideEngine.role.advisor", steward: "guideEngine.role.steward" };

function Announcer({ text }) {
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (!text) return undefined;
    const timer = window.setTimeout(() => setSaid(text), 50);
    return () => window.clearTimeout(timer);
  }, [text]);
  return <span className="sr-only" role="status" aria-live="polite">{said}</span>;
}

function StateLabel({ milestone, r }) {
  if (milestone.state === "done") return <span className="org-start__state org-start__state--done"><Check aria-hidden="true" size={16} />{r({ key: "guideEngine.orgPage.state.done" })}</span>;
  if (milestone.state === "needsAdmin") return <span className="org-start__state"><Lock aria-hidden="true" size={16} />{r({ key: "guideEngine.orgPage.state.needsAdmin" })}</span>;
  return <span className={`org-start__state${milestone.state === "next" ? " org-start__state--next" : ""}`}>{r({ key: milestone.state === "next" ? "guideEngine.orgPage.state.next" : "guideEngine.orgPage.state.notYet" })}</span>;
}

function ContactsForm({ view, onSave, r }) {
  const id = useId();
  const [backup, setBackup] = useState(view.contacts.backupUserId ?? "");
  const [spokes, setSpokes] = useState(() => new Set(view.contacts.spokespersonUserIds));
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // Record 8435: the contacts save is locked synchronously, before busy commits.
  const busyWriteRef = useRef(new Set());
  const toggle = (userId) => setSpokes((current) => {
    const next = new Set(current);
    if (next.has(userId)) next.delete(userId); else next.add(userId);
    return next;
  });
  const submit = (event) => {
    event.preventDefault();
    return runBusyWrite(busyWriteRef, "contacts", () => submitNow());
  };
  const submitNow = async () => {
    setBusy(true);
    setStatus("");
    try {
      await onSave({ backupUserId: backup || null, spokespersonUserIds: [...spokes] });
      setStatus(r({ key: "guideEngine.orgPage.contacts.saved" }));
    } catch {
      setStatus(r({ key: "guideEngine.orgPage.contacts.failed" }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="org-start__contacts" onSubmit={submit}>
      <label htmlFor={`${id}-backup`}>{r({ key: "guideEngine.orgPage.contacts.backup" })}</label>
      <select id={`${id}-backup`} value={backup} onChange={(event) => setBackup(event.target.value)}>
        <option value="">{r({ key: "guideEngine.orgPage.contacts.noBackup" })}</option>
        {view.people.map((person) => <option key={person.userId} value={person.userId}>{person.name}</option>)}
      </select>
      {view.peoplePartial && <p className="org-start__partial">{r(view.peoplePartial)}</p>}
      <fieldset className="org-start__members">
        <legend>{r({ key: "guideEngine.orgPage.contacts.spokespeople" })}</legend>
        {view.membersPartial && <p className="org-start__partial">{r(view.membersPartial)}</p>}
        {view.members.map((person) => (
          <label key={person.userId} className="org-start__check">
            <input type="checkbox" checked={spokes.has(person.userId)} onChange={() => toggle(person.userId)} />
            {person.name}
          </label>
        ))}
      </fieldset>
      <BusyButton type="submit" className="member-guide-card__primary" pending={busy}>{r({ key: "guideEngine.setup.save" })}</BusyButton>
      <p className="org-start__status" role="status">{status}</p>
    </form>
  );
}

function Milestone({ milestone, view, open, onToggle, onOpen, onReviewSwitches, onSaveContacts, r }) {
  const id = useId();
  const [reviewStatus, setReviewStatus] = useState("");
  const title = r(milestone.title);
  const switchesOpen = milestone.checks.some((check) => check.id === "switchesReviewed" && !check.done);
  return (
    <li className={`org-start__milestone${open ? " is-open" : ""}`}>
      <h3 className="org-start__milestone-heading">
        <button type="button" className="org-start__milestone-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle}>
          <span className="org-start__number" aria-hidden="true">{milestone.number}</span>
          <span className="org-start__milestone-name">
            <strong>{title}</strong>
            <span className="org-start__fact">{r(milestone.fact)}</span>
          </span>
          <StateLabel milestone={milestone} r={r} />
        </button>
      </h3>
      {open && (
        <div id={`${id}-body`} className="org-start__milestone-body">
          <p><strong>{r({ key: "guideEngine.orgPage.whyTitle" })}</strong> {r(milestone.why)}</p>
          <p className="org-start__subtitle">{r({ key: "guideEngine.orgPage.subTitle" })}</p>
          <ul className="org-start__checks">
            {milestone.checks.map((check) => (
              <li key={check.id}>
                <span>{r(check.label)}</span>
                <span className="org-start__check-state">{check.done ? r({ key: "guideEngine.org.done" }) : r({ key: "guideEngine.org.notYet" })}</span>
                <span className="org-start__who">{r({ key: "guideEngine.orgPage.whoCanTitle" })}: {r(check.who)}</span>
                {check.locked && <span className="org-start__locked"><Lock aria-hidden="true" size={14} />{r({ key: "guideEngine.orgPage.locked" })}</span>}
              </li>
            ))}
          </ul>
          {milestone.lock && <p className="org-start__lock">{r(milestone.lock)}</p>}
          <div className="org-start__actions">
            {milestone.open && <button type="button" className="member-guide-card__primary" onClick={() => onOpen(milestone.open)}>{r(milestone.open.label)}</button>}
            {switchesOpen && view.canReviewSwitches && (
              <button type="button" className="member-guide-card__quiet" onClick={async () => {
                try { await onReviewSwitches(); setReviewStatus(r({ key: "guideEngine.setup.switchesReviewed" })); } catch { setReviewStatus(r({ key: "guideEngine.orgPage.contacts.failed" })); }
              }}>{r({ key: "guideEngine.setup.switchesSave" })}</button>
            )}
          </div>
          {reviewStatus && <p className="org-start__status" role="status">{reviewStatus}</p>}
          {milestone.id === "backups" && view.canNameContacts && <ContactsForm view={view} onSave={onSaveContacts} r={r} />}
        </div>
      )}
    </li>
  );
}

/**
 * @param {{ guide: { view: any } | null, onOpen: (target: { path: string }) => void, onReviewSwitches: () => Promise<unknown>, onSaveContacts: (contacts: object) => Promise<unknown>, onCelebrated: () => Promise<unknown> }} props
 */
export function OrgStartGuide({ guide, onOpen, onReviewSwitches, onSaveContacts, onCelebrated, celebrationKey = "" }) {
  const { lang, t } = useLang();
  const id = useId();
  const r = (entry) => renderGuideCopy(lang, entry, t);
  const view = guide?.view ?? null;
  const [expanded, setExpanded] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef(null);
  useEffect(() => {
    const done = newlyDoneMilestones(previous.current, view);
    if (done.length) {
      setAnnouncement(done.map((milestone) => renderGuideCopy(lang, { key: "guideEngine.announce.milestone", params: { n: milestone.number, title: milestone.title } }, t)).join(" "));
      // A milestone the server just reported done: a small burst
      // (REQ-UG-MILESTONE-CONFETTI-CELEBRATIONS-20261102).
      celebrate("small");
    }
    previous.current = view;
  }, [view, lang, t]);
  // The organization is live: the major celebration, once per organization
  // and account on this browser, so revisiting before the acknowledgment
  // never replays it. The server's once-per-organization acknowledgment is
  // unchanged.
  const live = view?.kind === "celebrate";
  useEffect(() => {
    if (live && celebrationKey) celebrateOnce(`org-start:${celebrationKey}`, "major");
  }, [live, celebrationKey]);
  // #9895: Done on the live card is busy while the acknowledgment saves, and
  // a failure says so under the button instead of leaving the card as it was.
  const [celebrating, setCelebrating] = useState(false);
  const [celebrateStatus, setCelebrateStatus] = useState("");
  const celebrateWriteRef = useRef(new Set());
  const acknowledgeLive = async () => {
    setCelebrating(true);
    setCelebrateStatus("");
    try {
      await onCelebrated();
    } catch {
      setCelebrateStatus(r({ key: "guideEngine.orgPage.contacts.failed" }));
    } finally {
      setCelebrating(false);
    }
  };
  if (!view) return null;
  return (
    <OrgStartGuideCard view={view} expanded={expanded} milestonesId={`${id}-milestones`}
      onContinue={() => {
        setExpanded((value) => !value);
        if (!expanded && !openId && view.next) setOpenId(view.next.id);
      }}
      celebrating={celebrating} celebrateStatus={celebrateStatus}
      onCelebrated={() => runBusyWrite(celebrateWriteRef, "celebrate", acknowledgeLive)}>
      {!live && view.canAct && expanded && (
        <div id={`${id}-milestones`} className="org-start__layout">
          <ol className="org-start__milestones">
            {view.milestones.map((milestone) => (
              <Milestone
                key={milestone.id}
                milestone={milestone}
                view={view}
                open={openId === milestone.id}
                onToggle={() => setOpenId((current) => (current === milestone.id ? null : milestone.id))}
                onOpen={onOpen}
                onReviewSwitches={onReviewSwitches}
                onSaveContacts={onSaveContacts}
                r={r}
              />
            ))}
          </ol>
          <aside className="org-start__how">
            <h3>{r({ key: "guideEngine.orgPage.howTitle" })}</h3>
            <ul>
              <li>{r({ key: "guideEngine.orgPage.how1" })}</li>
              <li>{r({ key: "guideEngine.orgPage.how2", params: { org: view.orgName } })}</li>
              <li>{r({ key: "guideEngine.orgPage.how3" })}</li>
            </ul>
            {view.people.length > 0 && (
              <>
                <h3>{r({ key: "guideEngine.orgPage.whoTitle" })}</h3>
                <ul>
                  {view.people.map((person) => (
                    <li key={person.userId ?? person.name}>{r({ key: "guideEngine.orgPage.whoLine", params: { name: person.name, role: person.roles.map((role) => r({ key: ROLE_KEYS[role] ?? "guideEngine.role.steward" })).join(", ") } })}</li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        </div>
      )}
      <Announcer text={live ? r(view.title) : announcement} />
    </OrgStartGuideCard>
  );
}
