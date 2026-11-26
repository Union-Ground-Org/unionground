function clone(value) {
  return structuredClone(value);
}


export function createDemoCampaignApi() {
  let campaigns = [];
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
