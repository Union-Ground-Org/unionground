import { useId, useState } from "react";
import { LearningContentBody, lessonHasMore } from "./LearningContentBody.jsx";
import { buildLearningItemPayload } from "./model.js";

// The unsaved draft, rendered by the same component members see, inside a
// fiction that behaves like the real surfaces: Next steps to a clearly
// fictional neighbor, Hide and Show again work, a lesson expands. Nothing
// here calls the server or reads live content.
export function LearningPreviewPanel({ draft, tr }) {
  const payload = buildLearningItemPayload(draft);
  const item = { ...payload, id: "preview-draft", bullets: payload.bullets.filter(Boolean), topics: payload.topics.filter(Boolean) };
  const neighbor = {
    id: "preview-neighbor", kind: item.kind, title: tr("preview.sampleTitle"), body: tr("preview.sampleBody"),
    attribution: "", source: "", bullets: [], topics: [], learning_outcome: "",
  };
  const [surface, setSurface] = useState("home");
  const [position, setPosition] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  const cardHeadingId = useId();
  const cardBodyId = useId();
  const learnAvailable = item.kind === "mini_lesson";
  const activeSurface = learnAvailable ? surface : "home";
  const shown = position === 0 ? item : neighbor;
  const shownExpanded = shown.kind === "quote" || expanded;
  const empty = !item.title || !item.body;

  let frame;
  if (empty) {
    frame = <p className="lc-status">{tr("preview.empty")}</p>;
  } else if (activeSurface === "learn") {
    frame = (
      <article className="lc-lesson lc-lesson--open">
        <LearningContentBody item={item} tr={tr} headingLevel={4} expanded showSource />
      </article>
    );
  } else if (hidden) {
    frame = (
      <div className="home-card lc-home lc-home--hidden">
        <p className="lc-home__notice">{tr("preview.hidden")}</p>
        <button type="button" className="lc-button lc-button--quiet" onClick={() => setHidden(false)}>{tr("preview.showAgain")}</button>
      </div>
    );
  } else {
    frame = (
      <div className="home-card lc-home">
        <div className="lc-home__top">
          <span className="lc-kicker">{tr(`kind.${shown.kind}`)}</span>
          <span className="lc-home__position">{tr("home.position", { position: position + 1, count: 2 })}</span>
        </div>
        <div className="lc-home__content" id={cardBodyId} aria-live="polite">
          <LearningContentBody item={shown} tr={tr} headingId={cardHeadingId} headingLevel={4} expanded={shownExpanded} />
        </div>
        <div className="lc-actions">
          {lessonHasMore(shown) ? (
            <button type="button" className="lc-button lc-button--quiet" aria-expanded={shownExpanded} aria-controls={cardBodyId} onClick={() => setExpanded((value) => !value)}>
              {shownExpanded ? tr("home.readLess") : tr("home.readMore")}
            </button>
          ) : null}
          <button type="button" className="lc-button" aria-controls={cardBodyId} onClick={() => { setExpanded(false); setPosition((value) => (value + 1) % 2); }}>{tr("home.next")}</button>
          <button type="button" className="lc-button lc-button--quiet" onClick={() => setHidden(true)}>{tr("home.hide")}</button>
        </div>
      </div>
    );
  }

  return (
    <section className="lc-panel lc-preview" aria-labelledby={titleId}>
      <h3 className="lc-panel__title" id={titleId}>{tr("preview.title")}</h3>
      <p className="lc-hint">{tr("preview.note")}</p>
      {learnAvailable ? (
        <div className="lc-segment" role="group" aria-labelledby={titleId}>
          <button type="button" aria-pressed={activeSurface === "home"} onClick={() => setSurface("home")}>{tr("preview.home")}</button>
          <button type="button" aria-pressed={activeSurface === "learn"} onClick={() => setSurface("learn")}>{tr("preview.learn")}</button>
        </div>
      ) : null}
      <p className="lc-hint">{tr("preview.language", { language: tr(`locale.${item.locale}`) })}</p>
      <div className="lc-preview__frame">{frame}</div>
    </section>
  );
}
