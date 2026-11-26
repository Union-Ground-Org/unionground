import { useCallback, useEffect, useRef, useState } from "react";
import { ContextualPulseSlot } from "../features/engagement/ContextualPulseSlot.jsx";
import { MemberQaForum } from "../features/qa/MemberQaForum.jsx";
import { qaFailureText } from "../features/qa/copy.js";
import { qaContentFingerprint, qaIdempotencyKeyFor } from "../features/qa/idempotency.js";
import { useOrganizationTranslator } from "../lib/LanguageContext.jsx";
import { useQaScopedActor, useStableQaApi } from "../lib/mi1QaWiring.js";

// pulse: { client, configuration } for the reading-screen quick check on a
// question's detail (REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001).
export function MemberQaView({ lang = "en", actor, client, api = null, pulse = null }) {
  const t = useOrganizationTranslator(lang);
  const qaApi = useStableQaApi(client, api);
  const scopeActor = useQaScopedActor(client, actor);
  const [state, setState] = useState("loading");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [noticeVersion, setNoticeVersion] = useState(0);
  const [questions, setQuestions] = useState([]);
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const queryRef = useRef({});
  const mutationKeys = useRef(new Map());

  const idempotencyKey = useCallback((operation, input) => (
    qaIdempotencyKeyFor(mutationKeys.current, operation, qaContentFingerprint(input))
  ), []);

  const releaseIdempotencyKey = useCallback((operation, result) => {
    if (result?.ok) mutationKeys.current.delete(operation);
    return result;
  }, []);

  // afterWrite: the write already succeeded. A refresh that fails then must
  // not empty the list and show a failure, which reads as "your post failed"
  // and invites a second, duplicate post (REQ-UG-SINGLE-SIGHTING-DEFECTS-20261030,
  // finding 83). The current list stays and the notice says the save landed.
  const refresh = useCallback(async (query = {}, questionId = null, { afterWrite = false } = {}) => {
    const requestId = ++requestSequence.current;
    setState((current) => current === "ready" ? "ready" : "loading");
    setError(null);
    const list = await qaApi.list(query);
    if (!mounted.current || requestId !== requestSequence.current) return list;
    if (!list.ok && afterWrite) {
      setState("ready");
      setError(t("qa.savedRefreshFailed"));
      return list;
    }
    if (!list.ok) {
      setQuestions([]);
      setSelectedQuestion(null);
      setState("error");
      setError(qaFailureText(lang, list, t));
      return list;
    }
    const rows = Array.isArray(list.value) ? list.value : (list.value?.questions || []);
    setQuestions(rows);
    if (!questionId) {
      setSelectedQuestion(null);
      setState("ready");
      return list;
    }
    const detail = await qaApi.get(questionId);
    if (!mounted.current || requestId !== requestSequence.current) return list;
    if (!detail.ok && afterWrite) {
      setState("ready");
      setError(t("qa.savedRefreshFailed"));
      return list;
    }
    setSelectedQuestion(detail.ok ? detail.value : null);
    setState(detail.ok ? "ready" : "error");
    if (!detail.ok) setError(qaFailureText(lang, detail, t));
    return list;
  }, [lang, qaApi, t]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, [refresh]);

  const handleSearch = useCallback((query) => {
    setNotice(null);
    queryRef.current = query;
    return refresh(query);
  }, [refresh]);

  async function after(result, questionId = selectedQuestion?.id || null) {
    if (result?.ok) {
      setNotice(t("common.changesSaved"));
      setNoticeVersion((value) => value + 1);
      await refresh(queryRef.current, questionId || result.value?.id || result.value?.question?.id || null, { afterWrite: true });
      return result;
    }
    setNotice(null);
    setError(qaFailureText(lang, result, t, "writeUnconfirmed"));
    return false;
  }

  const beginMutation = () => {
    setError(null);
    setNotice(null);
  };

  return (
    <div className="screen" data-mi1-surface="member-qa">
      {selectedQuestion?.id && <ContextualPulseSlot key={selectedQuestion.id} pulse={pulse} contextKey="qa.detail" className="eng-pulse-slot--inset" />}
      <MemberQaForum
        lang={lang}
        actor={scopeActor}
        questions={questions}
        selectedQuestion={selectedQuestion}
        state={state}
        error={error}
        notice={notice}
        noticeKey={noticeVersion}
        onSearch={handleSearch}
        onAsk={(input) => {
          beginMutation();
          return qaApi.ask({ ...input, idempotencyKey: idempotencyKey("ask", input) })
            .then((result) => after(releaseIdempotencyKey("ask", result)));
        }}
        onOpen={(questionId) => { setNotice(null); return refresh(queryRef.current, questionId); }}
        onBack={() => { setNotice(null); return refresh(queryRef.current); }}
        onVote={(input) => { beginMutation(); return qaApi.toggleVote(input).then((result) => after(result)); }}
        onAccept={(input) => {
          beginMutation();
          return qaApi.accept({ ...input, expectedUpdatedAt: selectedQuestion?.updatedAt ?? null })
            .then((result) => after(result));
        }}
        onFollowUp={(input) => {
          beginMutation();
          const operation = `follow-up:${input.questionId}`;
          return qaApi.followUp({ ...input, idempotencyKey: idempotencyKey(operation, input) })
            .then((result) => after(releaseIdempotencyKey(operation, result), selectedQuestion?.id));
        }}
        onOfficialReply={(input) => {
          beginMutation();
          const operation = `official-reply:${input.questionId}`;
          return qaApi.officialReply({ ...input, idempotencyKey: idempotencyKey(operation, input) })
            .then((result) => after(releaseIdempotencyKey(operation, result), selectedQuestion?.id));
        }}
        onRetry={() => { setNotice(null); return refresh(queryRef.current, selectedQuestion?.id || null); }}
      />
    </div>
  );
}
