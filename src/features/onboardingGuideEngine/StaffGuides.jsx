// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029.
//
// Guide 2 for a staff hat on screen, from staffFeatureGuides(...).view: the
// list of the hat's feature guides on its home ("Your feature guides", a ring
// of done guides, the member steps group for staff who hold a member plan) and
// the inline guide card at the top of a feature the first time it is reached.
// Nothing here is a dialog and nothing moves focus; each speaks once, politely,
// and the card speaks only after an in-app move to its page.
import { useEffect, useId, useRef, useState } from "react";
import { CircleCheck, Info, OctagonX, UserRound } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { renderGuideCopy } from "./memberAdapter.js";
import "./MemberGuideLayers.css";
import "./StaffGuides.css";

function Polite({ text }) {
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (!text) return undefined;
    const timer = window.setTimeout(() => setSaid(text), 50);
    return () => window.clearTimeout(timer);
  }, [text]);
  return <span className="sr-only" role="status" aria-live="polite">{said}</span>;
}

function Group({ icon: Icon, heading, items }) {
  if (!items.length) return null;
  return (
    <div className="member-guide-card__group">
      <h3><Icon aria-hidden="true" size={18} />{heading}</h3>
      <ul>{items.map((line) => <li key={line}>{line}</li>)}</ul>
    </div>
  );
}

/**
 * The staff feature guide card for the feature on screen. Its primary button
 * goes to (or, for a looking action, is) the real first action; Got it hides
 * it. A shared feature shows each held role's lines under its role chip. A
 * step in parts (the chapter's units) has no single first action: each part
 * says where it stands and opens its own screen through `onOpenPart`.
 * `announce` is false on a first paint: the card then stays quiet.
 */
export function StaffFeatureGuide({ guides, onPrimary, onOpenPart, onGotIt, onSeen, announce = true }) {
  const { lang, t } = useLang();
  const id = useId();
  const item = guides?.showing ?? null;
  const seen = useRef(onSeen);
  seen.current = onSeen;
  const stepId = item?.stepId ?? null;
  const showingAs = guides?.showingAs ?? null;
  useEffect(() => {
    if (stepId && showingAs === "first") seen.current?.(stepId);
  }, [stepId, showingAs]);
  if (!item) return null;
  const r = (entry) => renderGuideCopy(lang, entry, t);
  const name = r(item.title);
  const doneBefore = item.doneBeforeOpened && showingAs === "first";
  const several = item.lines.length > 1;
  return (
    <section className="member-guide-card staff-guide-card" data-guide-surface="staff-feature-guide" aria-labelledby={`${id}-title`}>
      {/* B-52 (#9525): the heading is "About {feature}", so it never repeats
          the page title the feature shares (Chapter health under Chapter
          health); the eyebrow keeps only the notes and chips. */}
      {(doneBefore || item.roleChip || item.countsForAll) && <p className="member-guide-card__eyebrow">
        {doneBefore && <span>{r({ key: "guideEngine.fg.doneBeforeOpened" })}</span>}
        {item.roleChip && <span className="member-guide-card__chip">{r(item.roleChip)}</span>}
        {item.countsForAll && <span className="member-guide-card__chip">{r({ key: "guideEngine.sf.countsBoth" })}</span>}
      </p>}
      <h2 id={`${id}-title`} className="member-guide-card__title">{r({ key: "guideEngine.fg.about", params: { feature: name } })}</h2>
      {item.done && !doneBefore && <p className="member-guide-card__done">{r({ key: "guideEngine.row.done" })}</p>}
      {item.lines.map((line) => (
        <div key={line.role} className="member-guide-card__groups">
          {several && <p className="staff-guide-card__role"><span className="member-guide-card__chip">{r(line.roleLabel)}</span></p>}
          <Group icon={CircleCheck} heading={r({ key: "guideEngine.fg.youCan" })} items={line.canDo.map(r)} />
          <Group icon={OctagonX} heading={r({ key: "guideEngine.fg.never" })} items={line.neverDo.map(r)} />
        </div>
      ))}
      {item.about?.length > 0 && (
        <div className="member-guide-card__groups">
          <Group icon={Info} heading={r({ key: "guideEngine.sf.units.about" })} items={item.about.map(r)} />
        </div>
      )}
      {item.parts && (
        <ol className="staff-guide-card__parts">
          {item.parts.map((part) => (
            <li key={part.id}>
              <span className="staff-guide-card__part-name">
                <strong>{r(part.label)}</strong>
                <span>{part.done ? r({ key: "guideEngine.row.done" }) : r(part.status)}</span>
              </span>
              <button type="button" className="member-guide-card__quiet" onClick={() => onOpenPart?.(part)}>{r({ key: "guideEngine.sf.open", params: { feature: r(part.label) } })}</button>
            </li>
          ))}
        </ol>
      )}
      <div className="member-guide-card__groups">
        <Group icon={UserRound} heading={r({ key: "guideEngine.fg.askHeading" })} items={[r({ key: "guideEngine.fg.askLine", params: { who: item.askWho } })]} />
      </div>
      <div className="member-guide-card__actions">
        {!item.done && !item.parts && <button type="button" className="member-guide-card__primary" onClick={() => onPrimary?.(item)}>{r(item.firstLabel)}</button>}
        <button type="button" className="member-guide-card__quiet" onClick={() => onGotIt?.(item)}>{r({ key: "guideEngine.fg.gotIt" })}</button>
      </div>
      {announce && <Polite text={r({ key: "guideEngine.fg.announce", params: { feature: name } })} />}
    </section>
  );
}

function Row({ item, onOpen, r, isNext }) {
  const state = item.done
    ? r(item.doneBeforeOpened ? { key: "guideEngine.fg.doneBeforeOpened" } : { key: "guideEngine.row.done" })
    : r({ key: isNext ? "guideEngine.sf.nextWord" : "guideEngine.fg.notYet" });
  return (
    <li>
      <button type="button" className="member-guide-list__row" onClick={() => onOpen?.(item)}>
        <span className="member-guide-list__name">
          <strong>{r(item.title)}</strong>
          {(item.roleChip || item.countsForAll) && (
            <span className="staff-guide-list__chips">
              {item.roleChip && <span className="member-guide-card__chip">{r(item.roleChip)}</span>}
              {item.countsForAll && <span className="member-guide-card__chip">{r({ key: "guideEngine.sf.countsBoth" })}</span>}
            </span>
          )}
          <span className="member-guide-list__why">{item.done ? r(item.why) : r(item.firstLabel)}</span>
        </span>
        <span className={`member-guide-list__state${isNext ? " staff-guide-list__state--next" : ""}`}>{state}</span>
      </button>
    </li>
  );
}

/**
 * "Your feature guides" at the top of a staff hat's home: the ring, the
 * hat's guides in order (the first not done is Next), the done ones folded,
 * and, for staff who hold a member plan, their member steps as their own
 * collapsed group. A person with several roles sees which hat this is.
 */
export function StaffGuideList({ guides, onOpen, onFirstSwitch }) {
  const { lang, t } = useLang();
  const id = useId();
  const [showDone, setShowDone] = useState(false);
  const switched = useRef(onFirstSwitch);
  switched.current = onFirstSwitch;
  const role = guides?.role ?? null;
  const first = guides?.firstSwitch === true;
  useEffect(() => {
    if (role && first) switched.current?.(role);
  }, [role, first]);
  if (!guides || guides.total === 0) return null;
  const r = (entry) => renderGuideCopy(lang, entry, t);
  const allDone = guides.items.length === 0;
  return (
    <section className="member-guide-list staff-guide-list" data-staff-guide-list={guides.role} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>{r({ key: "guideEngine.sf.yourGuides" })}</h2>
      {guides.note && <p className="staff-guide-list__note">{r(guides.note)}</p>}
      <p className="staff-guide-list__ring">
        <progress max={guides.total} value={guides.doneCount} aria-hidden="true" />
        <span>{r(guides.ring)}</span>
      </p>
      {allDone && <p className="staff-guide-list__note">{r({ key: "guideEngine.sf.cardAllDone" })}</p>}
      {guides.items.length > 0 && (
        <ul>{guides.items.map((item, index) => <Row key={item.stepId} item={item} onOpen={onOpen} r={r} isNext={index === 0} />)}</ul>
      )}
      {guides.done.length > 0 && (
        <>
          <button type="button" className="member-guide-list__fold" aria-expanded={showDone} aria-controls={`${id}-done`} onClick={() => setShowDone((value) => !value)}>
            {r({ key: "guideEngine.fg.doneGroup", params: { n: guides.done.length } })}
          </button>
          {showDone && <ul id={`${id}-done`}>{guides.done.map((item) => <Row key={item.stepId} item={item} onOpen={onOpen} r={r} isNext={false} />)}</ul>}
        </>
      )}
      {guides.memberSteps && (
        <details className="staff-guide-list__member">
          <summary>
            {r(guides.memberSteps.label)}
            {guides.memberSteps.stalled && <span className="member-guide-card__chip">{r({ key: "guideEngine.sf.stalled" })}</span>}
          </summary>
          <p>{r({ key: "guideEngine.sf.memberStepsNote" })}</p>
        </details>
      )}
      {first && guides.note && <Polite text={r(guides.note)} />}
    </section>
  );
}
