import { boundedRows, cappedLimit } from "../../lib/boundedPage.js";

// An earlier page of a thread (channelHistory.js,
// privateHistory.js) set saved false, reminder null and resource null on
// every row without reading them, so a message the person saved, set a
// reminder on or shared a document from showed without that mark once it was
// opened from an earlier page. These reads give an earlier page the marks the
// member load gives the newest one (memberApi.js), for the page's rows only.

// Ids named in one request line, and rows read per request (one probe row past it).
const ID_BATCH = 100;
export const MARK_PAGE = 500;

// Every row of `table` whose `column` is one of `ids`: batches of ids, each
// read in pages by row id until a page says no more (lib/boundedPage.js), so
// a full answer never cuts rows off silently. A refused read rejects.
async function readAllFor(client, table, columns, column, ids, narrow = (query) => query) {
  const rows = [];
  for (let index = 0; index < ids.length; index += ID_BATCH) {
    let after = null;
    for (;;) {
      let query = narrow(client.from(table).select(columns)).in(column, ids.slice(index, index + ID_BATCH));
      if (after !== null) query = query.gt("id", after);
      const { data, error } = await query.order("id").limit(cappedLimit(MARK_PAGE));
      if (error) throw error;
      const page = boundedRows(data, MARK_PAGE);
      rows.push(...page.rows);
      if (!page.more) break;
      after = page.rows[page.rows.length - 1].id;
    }
  }
  return rows;
}

/**
 * The marks of an earlier page's rows, as the member load reads them: the
 * member's own saved mark and earliest pending reminder, and for a private
 * message the document shared from it. Returns `marksFor(id)`. With no rows or
 * no signed-in member nothing is read and every row reads unmarked. Like the
 * member load (softData in memberApi.js), a refused or failed mark read never
 * fails the page: that mark reads absent and the rows still show.
 * @param {object} client a Supabase client for the signed-in member
 * @param {{ sourceKind: "private" | "channel", userId: string, ids: string[] }} page
 */
export async function earlierPageMarks(client, { sourceKind, userId, ids }) {
  const privateKind = sourceKind === "private";
  const unmarked = privateKind ? { saved: false, reminder: null, resource: null } : { saved: false, reminder: null };
  if (!ids.length || !userId) return () => unmarked;
  const field = privateKind ? "private_message_id" : "channel_post_id";
  const own = (query) => query.eq("owner_id", userId).eq("source_kind", sourceKind);
  // As the member load's softFailed (memberApi.js): warn in development, read the mark as absent.
  const soft = (read) => read.catch((error) => {
    if (import.meta.env.DEV) console.warn("[earlierMarks] mark read degraded:", error?.message);
    return [];
  });
  const [saved, reminders, resources] = await Promise.all([
    soft(readAllFor(client, "member_saved_messages", "id,source_kind,private_message_id,channel_post_id,task_message_id,saved_at", field, ids, own)),
    soft(readAllFor(client, "member_message_reminders", "id,source_kind,private_message_id,channel_post_id,task_message_id,note,remind_at,status", field, ids, (query) => own(query).eq("status", "pending"))),
    privateKind ? soft(readAllFor(client, "member_message_resources", "id,message_id,document_id,created_at", "message_id", ids)) : [],
  ]);
  const documentIds = [...new Set(resources.map((row) => row.document_id))];
  const documents = documentIds.length ? await soft(readAllFor(client, "chapter_documents", "id,title,document_type", "id", documentIds)) : [];
  const savedIds = new Set(saved.map((row) => row[field]));
  // Earliest by time, as the member load's server order("remind_at") gives it,
  // not by text: two offsets for one instant sort apart as text.
  const time = (row) => Date.parse(row.remind_at);
  const soonest = [...reminders].sort((left, right) => (time(left) - time(right)) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return (id) => {
    const marks = { saved: savedIds.has(id), reminder: soonest.find((row) => row[field] === id) || null };
    if (!privateKind) return marks;
    // One link per message: member_message_resources.message_id is unique.
    const link = resources.find((row) => row.message_id === id);
    const document = link && documents.find((row) => row.id === link.document_id);
    return { ...marks, resource: document ? { id: link.id, documentId: link.document_id, title: document.title, documentType: document.document_type } : null };
  };
}
