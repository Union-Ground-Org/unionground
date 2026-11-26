// Responsive-web client for the chapter channel controls RPCs
// (REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001). Every call is a SECURITY
// DEFINER RPC that re-checks the caller, the channel and the organization
// switch; nothing here grants anything.
import { useCallback, useEffect, useRef, useState } from "react";
import { UNAVAILABLE_CHANNEL_CONTROLS, normalizeChannelControls, normalizeChannelSetting } from "./channelControls.js";
import { useLearningUndone } from "../learningPeriod/undoneSignal.js";

// Every RPC name stays a literal at its call site so the read-RPC drift guard
// can resolve it.
function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

export function createChannelControlsApi(client) {
  if (!client) return null;
  return {
    load: async () => normalizeChannelControls(unwrap(await client.rpc("get_my_channel_controls"))),
    setLevel: async (spaceId, level) => normalizeChannelSetting(
      unwrap(await client.rpc("set_channel_notification_level", { p_space_id: spaceId, p_level: level })), spaceId),
    setMute: async (spaceId, muted, mutedUntil = null) => normalizeChannelSetting(
      unwrap(await client.rpc("set_channel_mute", { p_space_id: spaceId, p_muted: muted, p_muted_until: muted ? mutedUntil : null })), spaceId),
    setKeywords: async (spaceId, keywords) => normalizeChannelSetting(
      unwrap(await client.rpc("set_channel_keyword_alerts", { p_space_id: spaceId, p_keywords: keywords })), spaceId),
    setPinned: async (threadId, pinned) => unwrap(await client.rpc("set_chapter_thread_pinned", { p_thread_id: threadId, p_pinned: pinned })),
    mentionCandidates: async (spaceId, query) => {
      const rows = unwrap(await client.rpc("list_channel_mention_candidates", { p_space_id: spaceId, p_query: query || null, p_limit: 8 }));
      return Array.isArray(rows) ? rows : [];
    },
    searchMentions: async (query) => {
      const rows = unwrap(await client.rpc("search_my_channel_mentions", { p_query: query || null, p_limit: 30 }));
      return Array.isArray(rows) ? rows : [];
    },
    // @here reaches people who are online now. The presence row is the
    // existing one-per-member heartbeat; channel surfaces keep it fresh.
    heartbeat: async (status = "online") => unwrap(await client.rpc("heartbeat_member_presence", { p_status: status })),
  };
}

const HEARTBEAT_MS = 60_000;

/**
 * Loads the caller's channel controls once per scope and keeps presence fresh
 * while a channel surface is mounted. `api` null (preview, no organization)
 * leaves every control unavailable rather than inventing one.
 */
export function useChannelControls(api, scopeKey) {
  const [controls, setControls] = useState(UNAVAILABLE_CHANNEL_CONTROLS);
  const [status, setStatus] = useState(api ? "loading" : "unavailable");
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!api) {
      setControls(UNAVAILABLE_CHANNEL_CONTROLS);
      setStatus("unavailable");
      return;
    }
    const run = ++generation.current;
    setStatus((current) => (current === "ready" ? current : "loading"));
    try {
      const next = await api.load();
      if (run !== generation.current) return;
      setControls(next);
      setStatus("ready");
    } catch {
      if (run !== generation.current) return;
      setControls(UNAVAILABLE_CHANNEL_CONTROLS);
      setStatus("error");
    }
  }, [api]);
  useEffect(() => {
    reload();
    return () => { generation.current += 1; };
    // scopeKey changes with the signed-in member, organization and chapter.
  }, [reload, scopeKey]);
  useEffect(() => {
    if (!api) return undefined;
    const beat = () => {
      const hidden = typeof document !== "undefined" && document.hidden;
      api.heartbeat(hidden ? "away" : "online").catch(() => {});
    };
    beat();
    const timer = globalThis.setInterval(beat, HEARTBEAT_MS);
    return () => globalThis.clearInterval(timer);
  }, [api, scopeKey]);
  const applySetting = useCallback((spaceId, setting) => {
    setControls((current) => {
      const before = current.spaces[spaceId]?.keywords?.length || 0;
      const after = setting.keywords?.length || 0;
      return {
        ...current,
        keywordCount: Math.max(0, current.keywordCount - before + after),
        spaces: { ...current.spaces, [spaceId]: setting },
      };
    });
  }, []);
  // #7027: an undo of your own level, mute or keyword change re-reads them.
  useLearningUndone(["own_channel_notifications"], () => { void reload(); });
  return { controls, status, reload, applySetting };
}
