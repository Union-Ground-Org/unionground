// A resource shared in a conversation used to live only in the open thread's
// local state. Any change to the conversation's messages (a read marker, a
// projection, leaving and coming back) reset that state from app data, which
// never received the message, so the share vanished until a reload although
// the row existed. A successful share is confirmed into the member loader the
// way a plain send is: the message row and its resource link, so every later
// projection carries it.
export function sharedResourceRows({ messageId, conversationId, userId, senderName, body, documentId, createdAt }) {
  return {
    message: {
      id: messageId,
      conversation_id: conversationId,
      user_id: userId,
      sender_kind: "member",
      sender_name: senderName || "Member",
      // send_member_resource stores this text when the member adds none.
      body: String(body || "").trim() || "Shared resource",
      created_at: createdAt,
      read_at: null,
    },
    link: { id: `confirmed-resource-${messageId}`, message_id: messageId, document_id: documentId, created_at: createdAt },
  };
}

export function confirmSharedResource(loader, rows) {
  if (!loader) return;
  loader.confirmRows("table:member_messages", (current) => [...current.filter((row) => row.id !== rows.message.id), rows.message]);
  loader.confirmRows("table:member_message_resources", (current) => [...current.filter((row) => row.message_id !== rows.message.id), rows.link]);
}

// The member messaging api's share: send, then confirm the message and its
// link into the loader and patch the open conversation in app data, so the
// share survives read markers, projections and leaving and coming back.
export async function shareAndConfirmResource({ send, loader, patchConversation, userId, senderName, documents, formatDate }, conversationId, documentId, body) {
  const result = await send(conversationId, documentId, body);
  if (!result?.messageId) return result;
  const rows = sharedResourceRows({
    messageId: result.messageId, conversationId, userId, senderName,
    body, documentId, createdAt: new Date().toISOString(),
  });
  confirmSharedResource(loader, rows);
  const document = (documents || []).find((item) => item.id === documentId);
  patchConversation(conversationId, (item) => ({
    ...item,
    preview: rows.message.body,
    dateLabel: formatDate(rows.message.created_at),
    messages: [...(item.messages || []).filter((message) => message.id !== rows.message.id), {
      ...rows.message, reactions: [], saved: false, reminder: null,
      resource: { id: rows.link.id, documentId, title: document?.title || "", documentType: document?.document_type || "document" },
    }],
  }));
  return result;
}
