import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CaseNoteComposer } from "../../src/components/CaseMentions.jsx";
import { MentionPicker } from "../../src/features/messaging/ChannelControls.jsx";
import { MessagesView } from "../../src/views/MessagesView.jsx";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import { loadLanguage, t as translate } from "../../src/lib/i18n.js";
import "../../src/sg-tokens.css";
import "../../src/styles.css";
import "../../src/alt/styles/messages.css";
import "../../src/alt/styles/design.css";

const params = new URLSearchParams(location.search);
const lang = params.get("lang") === "es" ? "es" : "en";
document.documentElement.lang = lang;
await loadLanguage(lang);
const t = (key, vars) => translate(lang, key, vars);
const people = ["tamarack-east", "tamarack-west"].map((id) => ({ id, userId: id, fullName: "Alex Rivera", name: "Alex Rivera" }));
const api = { mentionCandidates: async () => people };
const conversation = { id: "tamarack-thread", sender: "Tamarack case team", messages: people.map((person) => ({ id: `post-${person.id}`, sender_id: person.id, sender_kind: "steward", sender_name: person.fullName, body: "Tamarack", created_at: "2026-11-08T12:00:00-05:00" })) };
function Fixture() {
  const [picked, setPicked] = useState("");
  return <LanguageProvider lang={lang}><main className="sg-app ugalt ug-app" style={{ colorScheme: "light", width: "100%", boxSizing: "border-box", padding: 16 }}>
    <h1>Tamarack</h1>
    {params.get("surface") === "messages" ? <MessagesView alt desktop={innerWidth >= 1000} data={{ member: { id: "tamarack-member" }, conversations: [conversation], broadcasts: [], product: { spaces: [], documents: [] } }} onSendMessage={async () => {}} onReadConversation={() => {}} /> : <>
      <CaseNoteComposer caseId="tamarack-case" t={t} candidates={people} onSubmit={async (_case, _body, ids) => setPicked(ids.join(", "))} />
      <MentionPicker t={t} api={api} spaceId="tamarack-space" onPick={(person) => setPicked(person.id)} />
      <output aria-live="polite">{picked}</output>
    </>}
  </main></LanguageProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
