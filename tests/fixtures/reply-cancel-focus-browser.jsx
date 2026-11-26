import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SharedMessageActions } from "../../src/components/SharedMessageActions.jsx";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import "../../src/sg-tokens.css";
import "../../src/styles.css";

// In-memory adapter with the same capability shape as
// tests/message-action-web-parity.test.jsx. The local preview has no nested
// reply, so this fixture is the browser proof of the real component.
// window.__replyFocusFail names a message id whose reply write fails.
const capabilities = { canEdit: true, saved: false, reminders: [], reactions: [] };

function apiFor() {
  return {
    async messageAction(_kind, id, action, value) {
      if (action === "state") return capabilities;
      if (action === "reply") {
        if (window.__replyFocusFail === id) throw new Error("offline");
        return { id: `${id}-reply`, parent_message_id: id, body: value };
      }
      if (action === "edit") return { id, body: value, edited_at: "now" };
      return { state: { ...capabilities } };
    },
  };
}

function MessageRow({ id, body }) {
  const [notice, setNotice] = useState("");
  return <article aria-label={body} className="thread-message">
    <p>{body}</p>
    <SharedMessageActions sourceKind="private" message={{ id, body, reactions: [] }} actorId="me" api={apiFor()} onNotice={setNotice} onMessageChange={() => {}} onReply={() => {}} />
    <p role="status">{notice}</p>
  </article>;
}

createRoot(document.getElementById("root")).render(<LanguageProvider lang="en">
  <main className="sg-app" data-workspace-theme="union-ground" style={{ colorScheme: "light", boxSizing: "border-box", width: "100%", padding: 16 }}>
    <h1>Tamarack message replies</h1>
    <p>Fictional chapter notes. Nothing here is a hosted account.</p>
    <MessageRow id="m1" body="The hall opens at six." />
    <MessageRow id="m2" body="Bring the printed agenda." />
  </main>
</LanguageProvider>);
