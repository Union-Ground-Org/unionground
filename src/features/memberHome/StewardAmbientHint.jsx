import { useEffect, useId, useState } from "react";
import { Lightbulb } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { isFeatureEnabled } from "../../lib/featureSwitches.js";
import {
  learningScopeFrom, learningScopeKey, learningScopeReady, learningScopeTenant, learningTransportReady, useLearningApi, useLearningTick,
} from "../learningContent/hooks.js";
import { isLearningItemLive } from "../learningContent/model.js";
import "./stewardAmbientHint.css";

export const STEWARD_HINTS_SWITCH = "features.home.steward_ambient_hints";
const PREVIEW_CHARS = 280;

// Staff-audience items first (the old placement was "Steward Pulse Hint" for
// the Stewards audience), then anything published for everyone.
export function pickStewardHint(items) {
  const list = Array.isArray(items) ? items.filter((item) => item && typeof item.title === "string" && item.title.trim()) : [];
  return list.find((item) => item.audience === "staff") ?? list.find((item) => item.audience !== "members") ?? null;
}

function preview(text) {
  const value = typeof text === "string" ? text.trim() : "";
  return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS).trimEnd()}…` : value;
}

// REQ-UG-STEWARD-AMBIENT-HINTS-20261001: the steward side of the old
// ambient knowledge hint (de7df4b57c^:components/home/ambient-knowledge-hint.tsx).
// One quiet hint on the steward desk overview from the governed learning
// library the steward can already read. `learningContent` is App's learning
// wiring (session client factory, session, organization, chapter, locale).
export function StewardAmbientHint({ data, learningContent = null }) {
  if (!learningContent || !isFeatureEnabled(data?.organizationConfiguration, STEWARD_HINTS_SWITCH, true)) return null;
  const scope = learningScopeFrom(learningContent);
  if (!learningScopeReady(scope, learningTransportReady(learningContent)) || !learningScopeTenant(scope)) return null;
  return <StewardAmbientHintSession key={learningScopeKey(scope)} scope={scope} transport={learningContent} />;
}

function StewardAmbientHintSession({ scope, transport }) {
  const { t } = useLang();
  const titleId = useId();
  const api = useLearningApi(scope, transport);
  const [items, setItems] = useState([]);
  useEffect(() => {
    let active = true;
    Promise.resolve(api.listContent({ chapterId: scope.chapterId, locale: scope.locale, limit: 20 }))
      .then((page) => { if (active) setItems(Array.isArray(page?.items) ? page.items : []); })
      .catch(() => { if (active) setItems([]); });
    return () => { active = false; };
  }, [api, scope.chapterId, scope.locale]);
  // The server filters publication time at read time. Retain the bounded batch
  // so a boundary can retire the current hint and select another without a read.
  useLearningTick(items);
  const now = Date.now();
  const item = pickStewardHint(items.filter((candidate) => isLearningItemLive(candidate, now)));
  if (!item) return null;
  const body = preview(item.body);
  return (
    <aside className="steward-hint" aria-labelledby={titleId}>
      <span className="steward-hint__icon" aria-hidden="true"><Lightbulb size={17} /></span>
      <div className="steward-hint__copy">
        <p className="steward-hint__kicker">{t("stewardHint.kicker")}</p>
        <h2 id={titleId}>{item.title}</h2>
        {body ? <p className="steward-hint__body">{body}</p> : null}
        {item.attribution ? <p className="steward-hint__by">{item.attribution}</p> : null}
      </div>
    </aside>
  );
}
