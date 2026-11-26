// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
function clone(value) {
  return structuredClone(value);
}

function seedCampaigns() {
  const closesAt = new Date(Date.now() + (6 * 86400000)).toISOString();
  return [{
    id: "demo-ballot-draft", kind: "ballot", scope: "chapter", chapterId: "wor",
    titleEn: "Worksite bargaining priorities", titleEs: "Prioridades de negociación del lugar de trabajo",
    bodyEn: "Rank the issue the bargaining team should hear first.",
    bodyEs: "Elige el tema que el equipo negociador debe escuchar primero.",
    closesAt, quorumTarget: 50, state: "draft", active: false,
    options: [
      { id: "demo-option-1", labelEn: "Safe staffing", labelEs: "Dotación segura", orderIndex: 1 },
      { id: "demo-option-2", labelEn: "Scheduling", labelEs: "Horarios", orderIndex: 2 },
    ],
  }];
}

export function createDemoCampaignApi() {
  let campaigns = seedCampaigns();
  const load = async () => ({ campaigns: clone(campaigns), canManageUnion: true, chapterId: "wor" });
  return {
    load,
    async saveDraft(fields) {
      const id = fields.id || `demo-${fields.kind}-${Date.now()}`;
      const next = {
        ...clone(fields), id, state: "draft", active: false, chapterId: fields.scope === "chapter" ? "wor" : null,
        options: fields.options.map((option, index) => ({ ...option, id: `${id}-option-${index + 1}`, orderIndex: index + 1 })),
      };
      campaigns = campaigns.some((campaign) => campaign.id === id)
        ? campaigns.map((campaign) => campaign.id === id ? next : campaign)
        : [next, ...campaigns];
      return { id, kind: fields.kind, state: "draft" };
    },
    async publish(kind, id) {
      campaigns = campaigns.map((campaign) => campaign.id === id && campaign.kind === kind
        ? { ...campaign, state: "open", active: true, publishedAt: new Date().toISOString() }
        : campaign);
      return { id, kind, state: "open" };
    },
    async close(kind, id) {
      campaigns = campaigns.map((campaign) => campaign.id === id && campaign.kind === kind
        ? { ...campaign, state: "closed", active: false, closedAt: new Date().toISOString() }
        : campaign);
      return { id, kind, state: "closed" };
    },
  };
}
