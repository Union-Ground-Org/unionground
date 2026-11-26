import { useCallback, useEffect, useRef, useState } from "react";
import { OfficerQaQueue } from "../features/qa/OfficerQaQueue.jsx";
import { qaFailureText } from "../features/qa/copy.js";
import { qaContentFingerprint, qaIdempotencyKeyFor } from "../features/qa/idempotency.js";
import { useOrganizationTranslator } from "../lib/LanguageContext.jsx";
import { useQaScopedActorState, useStableQaApi } from "../lib/mi1QaWiring.js";

const AUTHORIZATION_QUEUE_CODES = new Set([
  "mfa_required",
  "forbidden",
  "unauthenticated",
  "membership_revoked",
  "organization_required",
  "chapter_required",
  "organization_scope_missing",
]);

function keepOfficerQueueOnFailure(result, { append = false, preserveNotice = false } = {}) {
  return (append || preserveNotice) && !AUTHORIZATION_QUEUE_CODES.has(result?.code);
}

export function OfficerQaView({ lang = "en", actor, client, api = null, embedded = false, onOpenQuestion = null }) {
  const t = useOrganizationTranslator(lang);
  const qaApi = useStableQaApi(client, api);
  const { actor: scopeActor, scopeSettled } = useQaScopedActorState(client, actor);
  const [state, setState] = useState("loading");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [noticeVersion, setNoticeVersion] = useState(0);
  const [questions, setQuestions] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const replyKeys = useRef(new Map());

  const refresh = useCallback(async ({ preserveNotice = false, append = false, cursor = null } = {}) => {
    const requestId = ++requestSequence.current;
    if (!preserveNotice) setNotice(null);
    setState((current) => current === "ready" ? "ready" : "loading");
    setError(null);
    const result = await qaApi.officerQueue(cursor || undefined);
    if (!mounted.current || requestId !== requestSequence.current) return result;
    if (!result.ok) {
      // Keep already-loaded rows on a retryable Load more or post-reply reread.
      // Authorization, MFA, membership, and scope failures still clear the queue.
      const keepLoadedQueue = keepOfficerQueueOnFailure(result, { append, preserveNotice });
      if (!keepLoadedQueue) {
        setQuestions([]);
        setNextCursor(null);
      }
      setState((current) => (keepLoadedQueue && current === "ready" ? "ready" : "error"));
      setError(result);
      return;
    }
    const rows = Array.isArray(result.value) ? result.value : (result.value?.questions || []);
    setQuestions((current) => append ? [...current, ...rows] : rows);
    setNextCursor(result.value?.nextAfterCreatedAt && result.value?.nextAfterId ? {
      afterCreatedAt: result.value.nextAfterCreatedAt,
      afterId: result.value.nextAfterId,
    } : null);
    setState("ready");
  }, [qaApi]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, [refresh]);

  return (
    <div className={embedded ? "" : "screen"} data-mi1-surface="officer-qa">
      {!embedded && <h1>{t("nav.qaQueue")}</h1>}
      <OfficerQaQueue
        lang={lang}
        actor={scopeActor}
        scopeSettled={scopeSettled}
        questions={questions}
        state={state}
        error={error ? qaFailureText(lang, error, t, error.write ? "writeUnconfirmed" : undefined) : null}
        notice={notice ? t(notice) : null}
        noticeKey={noticeVersion}
        onReply={(input) => {
          setError(null);
          setNotice(null);
          const operation = input.questionId;
          const idempotencyKey = qaIdempotencyKeyFor(replyKeys.current, operation, qaContentFingerprint(input));
          return qaApi.officialReply({ ...input, idempotencyKey }).then((result) => {
          if (result.ok) {
            replyKeys.current.delete(operation);
            setQuestions((current) => current.filter((question) => question.id !== operation));
            setNotice("common.changesSaved");
            setNoticeVersion((value) => value + 1);
            refresh({ preserveNotice: true });
          }
          else {
            setNotice(null);
            // A failed reply is a write: its unknown cause is not a failed load.
            setError({ ...result, write: true });
          }
          return result.ok ? result : false;
          });
        }}
        onOpen={onOpenQuestion}
        onLoadMore={nextCursor ? () => refresh({ preserveNotice: true, append: true, cursor: nextCursor }) : null}
        onRetry={refresh}
      />
    </div>
  );
}
