import { composeCollectiveActions, composeOrganizationIntelligence } from "./model.js";
import { normalizeOrganizationIntelligenceActor } from "./authorization.js";

async function load(fetcher, compose, actor, request = {}) {
  const normalized = normalizeOrganizationIntelligenceActor(actor);
  if (!fetcher) return compose({ snapshot: null, actor: normalized });
  try {
    const snapshot = await fetcher(normalized, request);
    return compose({ snapshot, actor: normalized });
  } catch {
    return compose({ snapshot: { organizationId: normalized.organizationId, error: "snapshot_failed" }, actor: normalized });
  }
}

export function createOrganizationIntelligenceAdapter({
  fetchIntelligence = null,
  fetchActions = null,
  saveChartNode = null,
  saveRelationship = null,
  saveTopicProgress = null,
  saveTimelineEvent = null,
  saveAction = null,
  toggleParticipation = null,
  exportParticipants = null,
  goalBreakdown = null,
} = {}) {
  return Object.freeze({
    loadIntelligence: ({ actor } = {}) => load(fetchIntelligence, composeOrganizationIntelligence, actor),
    loadActions: ({ actor, ...request } = {}) => load(fetchActions, composeCollectiveActions, actor, request),
    saveChartNode: (input) => saveChartNode ? saveChartNode(input) : Promise.reject(new Error("organization intelligence is unwired")),
    saveRelationship: (input) => saveRelationship ? saveRelationship(input) : Promise.reject(new Error("organization intelligence is unwired")),
    saveTopicProgress: (input) => saveTopicProgress ? saveTopicProgress(input) : Promise.reject(new Error("organization intelligence is unwired")),
    saveTimelineEvent: (input) => saveTimelineEvent ? saveTimelineEvent(input) : Promise.reject(new Error("organization intelligence is unwired")),
    saveAction: (input) => saveAction ? saveAction(input) : Promise.reject(new Error("collective actions are unwired")),
    toggleParticipation: (input) => toggleParticipation ? toggleParticipation(input) : Promise.reject(new Error("collective actions are unwired")),
    exportParticipants: (input) => exportParticipants ? exportParticipants(input) : Promise.reject(new Error("collective action exports are unwired")),
    goalBreakdown: goalBreakdown ? (input) => goalBreakdown(input) : null,
  });
}
