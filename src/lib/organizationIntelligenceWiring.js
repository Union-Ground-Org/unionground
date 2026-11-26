import { createOrganizationIntelligenceAdapter } from "../features/organizationIntelligence/adapter.js";
import { ORGANIZATION_INTELLIGENCE_RPCS } from "../features/organizationIntelligence/contract.js";
import { buildMi1AnalyticsActor, useMi1AnalyticsActor } from "./mi1AnalyticsWiring.js";

export const buildOrganizationIntelligenceActor = buildMi1AnalyticsActor;
export const useOrganizationIntelligenceActor = useMi1AnalyticsActor;

function requireClient(client) {
  if (!client?.rpc) throw new Error("organization intelligence is unavailable");
}

async function call(client, rpc, args = {}) {
  requireClient(client);
  const { data, error } = await client.rpc(rpc, args);
  if (error) throw error;
  return data;
}

function hat(actor) {
  return { p_selected_hat: actor?.selectedHat || "member" };
}

async function fetchCollectiveActions(client, actor, { limit = 25, offset = 0 } = {}) {
  requireClient(client);
  const { data, error, status } = await client.rpc(ORGANIZATION_INTELLIGENCE_RPCS.collectiveActions, {
    ...hat(actor), p_limit: limit, p_offset: offset,
  });
  if (!error) return data;
  // A refusal must clear previously displayed rows. Only a failed read in
  // the same scope can leave the current page available for retry.
  if (status === 401 || status === 403 || ["42501", "PGRST301", "PGRST302"].includes(error.code)) {
    return { organizationId: actor.organizationId, unavailable: true };
  }
  throw error;
}

export function createWiredOrganizationIntelligenceAdapter(client) {
  return createOrganizationIntelligenceAdapter({
    fetchIntelligence: (actor) => call(client, ORGANIZATION_INTELLIGENCE_RPCS.intelligenceSnapshot, hat(actor)),
    fetchActions: (actor, request) => fetchCollectiveActions(client, actor, request),
    saveChartNode: async ({ actor, ...input }) => {
      const saved = await call(client, ORGANIZATION_INTELLIGENCE_RPCS.saveChartNode, {
        ...hat(actor), p_id: input.id || null, p_chart_kind: input.chartKind,
        p_node_kind: input.nodeKind, p_parent_id: input.parentId || null,
        p_chapter_id: input.chapterId || null, p_label: input.label,
        p_subtitle: input.subtitle || null, p_position_x: Number(input.positionX || 0),
        p_position_y: Number(input.positionY || 0), p_sort_order: Number(input.sortOrder || 0),
      });
      // REQ-UG-TENANT-ORG-CHART-BASELINE-20261030. The seat state is
      // written only when the administrator set it in this edit; a content
      // change alone leaves the server's reset to unconfirmed in place.
      if (!input.seatTouched) return saved;
      let status;
      try {
        status = await call(client, ORGANIZATION_INTELLIGENCE_RPCS.saveChartSeatStatus, {
          ...hat(actor), p_node_id: saved?.id || input.id, p_seat_status: input.seatStatus,
          p_vacant: input.vacant === true,
        });
      } catch (cause) {
        // The content write has already committed, so the node exists with
        // its seat back at unconfirmed. Report that partial success with the
        // saved ID so a retry updates this node instead of creating another.
        const error = new Error("chart content saved; seat status not saved");
        error.cause = cause;
        error.chartNodeSaved = { ...saved, id: saved?.id || input.id };
        throw error;
      }
      return { ...saved, ...status };
    },
    saveRelationship: ({ actor, ...input }) => call(client, ORGANIZATION_INTELLIGENCE_RPCS.saveRelationship, {
      ...hat(actor), p_id: input.id || null, p_source_user_id: input.sourceId,
      p_target_user_id: input.targetId, p_relationship_kind: input.kind,
      p_strength: Number(input.strength || 1),
    }),
    saveTopicProgress: ({ actor, ...input }) => call(client, ORGANIZATION_INTELLIGENCE_RPCS.saveTopicProgress, {
      ...hat(actor), p_member_user_id: input.memberId, p_topic_key: input.topicKey,
      p_topic_label: input.topicLabel, p_progress_state: input.state,
      p_progress: Number(input.progress || 0),
    }),
    saveTimelineEvent: ({ actor, ...input }) => call(client, ORGANIZATION_INTELLIGENCE_RPCS.saveTimelineEvent, {
      ...hat(actor), p_id: input.id || null, p_chapter_id: input.chapterId || null,
      p_event_kind: input.kind, p_title: input.title, p_detail: input.detail || null,
      p_effective_on: input.effectiveOn, p_ended_on: input.endedOn || null,
      p_amount_cents: input.amountCents == null ? null : Number(input.amountCents),
      p_amount_basis: input.amountBasis || null, p_source_label: input.sourceLabel || null,
      p_source_as_of: input.sourceAsOf || null,
    }),
    saveAction: ({ actor, ...input }) => call(client, ORGANIZATION_INTELLIGENCE_RPCS.saveAction, {
      ...hat(actor), p_id: input.id || null, p_chapter_id: input.chapterId || null,
      p_action_kind: input.kind, p_title: input.title, p_summary: input.summary,
      p_status: input.status, p_target_count: Number(input.targetCount || 1),
      p_starts_at: input.startsAt || null, p_ends_at: input.endsAt || null,
    }),
    toggleParticipation: (input) => call(client, ORGANIZATION_INTELLIGENCE_RPCS.toggleParticipation, {
      p_action_id: input.actionId, p_participation_kind: input.participationKind,
      p_joined: Boolean(input.joined),
    }),
    exportParticipants: ({ actor, ...input }) => call(client, ORGANIZATION_INTELLIGENCE_RPCS.exportParticipants, {
      ...hat(actor), p_action_id: input.actionId,
      p_participation_kind: input.participationKind,
    }),
    goalBreakdown: ({ actionId }) => call(client, ORGANIZATION_INTELLIGENCE_RPCS.goalBreakdown, { p_action_id: actionId }),
  });
}
