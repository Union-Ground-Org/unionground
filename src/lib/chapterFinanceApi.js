import { MemberApiError } from "./memberApi.js";

export function createChapterFinanceApi(client, scope, canAuthor = false) {
  if (!client) return null;
  const bound = { p_org: scope.organizationId, p_chapter: scope.chapterId };
  async function value(request, name) {
    const result = await request;
    if (result.error) throw new MemberApiError(name, result.error);
    return result.data;
  }
  return {
    load: (page, requestPage) => value(client.rpc("get_chapter_finance_workspace", { ...bound, p_page: page, p_request_page: requestPage, p_authoring: canAuthor }), "Load chapter finances"),
    members: async (page, query) => {
      const rows = await value(client.rpc("list_chapter_finance_members", { ...bound, p_page: page, p_query: query }), "Find finance members");
      if (!Array.isArray(rows)) throw new MemberApiError("Find finance members", { message: "Member names unavailable" });
      return rows;
    },
    saveDocument: (document) => value(client.rpc("save_chapter_financial_document", { ...bound,
      p_id: document.id || null, p_revision: document.revision || 0,
      p_kind: document.kind, p_title: document.title, p_body: document.body,
      p_status: document.status, p_budget: document.budgetId || null,
    }), "Save financial document"),
    submit: (request) => value(client.rpc("submit_chapter_financial_request", { ...bound,
      p_subject: request.subjectId, p_kind: request.kind,
      p_title: request.title, p_description: request.description, p_amount: Number(request.amount),
    }), "Submit financial request"),
    decide: (request, decision, note) => value(client.rpc("decide_chapter_financial_request", { ...bound,
      p_id: request.id, p_revision: request.revision, p_decision: decision, p_note: note,
    }), "Record financial decision"),
  };
}
