// @vitest-environment node
//
// REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001 — the restored-controls
// contract (the "Messaging channel controls contract").
//
// This file replaces tests/messaging-retired-channel-controls.test.js, which
// guarded the 2026-09-06 retirement. The owner brought the six controls back on
// the condition that each returns as a complete capability: server-side
// authorization, a settings surface on responsive web AND iPhone AND Android,
// real notification production, deterministic tenant-scoped mute precedence
// across direct, channel, task and announcement boundaries, and accessibility
// coverage. Every block below fails if one leg of that bar goes missing, so a
// later change cannot quietly turn a control back into "a column and a grant".
//
// The retirement migration stays history: its byte-for-byte proofs are kept at
// the bottom, and the engagement-era objects it removed stay removed (the
// restored design uses new, server-only objects instead).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";
import { latestFnBody, migrationFiles, stripComments } from "./helpers/migration.js";
import {
  CHANNEL_ALERT_PRECEDENCE,
  CHANNEL_MUTE_NEVER_SILENCES,
  channelAlertDecision,
} from "../src/features/messaging/channelControls.js";
import { catalogue } from "../src/lib/i18n.js";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");
const migrations = migrationFiles();
const RESTORE = "20261003034000_channel_controls_restored.sql";
const restore = migrations.find((file) => file.name === RESTORE);
const code = stripComments(restore.sql).toLowerCase();
const flat = code.replace(/\s+/g, " ");

const SWITCHES = [
  "features.messaging.channel_pinning",
  "features.messaging.channel_notification_levels",
  "features.messaging.channel_mute",
  "features.messaging.mentions",
  "features.messaging.here_mentions",
  "features.messaging.mention_search",
  "features.messaging.keyword_alerts",
];
const LIMIT = "limits.messaging.keyword_alerts_per_member";
const MEMBER_RPCS = [
  ["public.set_channel_notification_level", "uuid, text", "features.messaging.channel_notification_levels"],
  ["public.set_channel_mute", "uuid, boolean, timestamptz", "features.messaging.channel_mute"],
  ["public.set_channel_keyword_alerts", "uuid, text[]", "features.messaging.keyword_alerts"],
  ["public.set_chapter_thread_pinned", "uuid, boolean", "features.messaging.channel_pinning"],
  ["public.list_channel_mention_candidates", "uuid, text, integer", "features.messaging.mentions"],
  ["public.search_my_channel_mentions", "text, integer", "features.messaging.mention_search"],
  ["public.get_my_channel_controls", "", null],
];

function body(name) {
  return stripComments(latestFnBody(name)).toLowerCase();
}

function walk(directory, extensions) {
  const results = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === ".expo" || name === "dist" || name === "coverage") continue;
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) results.push(...walk(path, extensions));
    else if (extensions.some((extension) => name.endsWith(extension))) results.push(path);
  }
  return results;
}

describe("organization switches (visible on the admin Feature switches & limits page)", () => {
  it("defines every switch ON and the keyword limit at 10, member-visible, under messaging", () => {
    for (const key of SWITCHES) {
      const row = flat.slice(flat.indexOf(`('${key}'`), flat.indexOf(`('${key}'`) + 400);
      expect(row, key).toMatch(/'boolean'/);
      expect(row, key).toMatch(/'true', null, null, null, \d+, 'messaging', true\)/);
    }
    const limit = flat.slice(flat.indexOf(`('${LIMIT}'`), flat.indexOf(`('${LIMIT}'`) + 400);
    expect(limit).toMatch(/'integer'/);
    expect(limit).toMatch(/'10', 1, 50, null, \d+, 'messaging', true\)/);
    expect(flat).toContain("on conflict (key) do nothing");
  });

  it("ships admin-page copy for every key in both languages", () => {
    for (const key of [...SWITCHES, LIMIT]) {
      for (const lang of ["en", "es"]) {
        expect(catalogue[lang][`settings.def.${key}.label`], `${lang} ${key} label`).toBeTruthy();
        expect(catalogue[lang][`settings.def.${key}.description`], `${lang} ${key} description`).toBeTruthy();
      }
    }
  });
});

describe("server-side authorization", () => {
  it.each(MEMBER_RPCS)("%s is a definer RPC executable by authenticated only, MFA-gated, switch-enforced", (name, args, key) => {
    const fn = body(name);
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = ''");
    expect(fn).toContain("private.mfa_satisfied()");
    if (key) expect(fn, `${name} must read ${key} server-side`).toContain(`'${key}'`);
    expect(code).toContain(`revoke all on function ${name}(${args}) from public, anon, authenticated, service_role;`);
    expect(code).toContain(`grant execute on function ${name}(${args}) to authenticated;`);
    expect(code).not.toMatch(new RegExp(`grant execute on function ${name.replace(".", "\\.")}\\([^)]*\\) to [^;]*(anon|service_role)`));
  });

  it("writers enter the case-graph gate first and act only on a channel the caller can read now", () => {
    for (const name of ["public.set_channel_notification_level", "public.set_channel_mute", "public.set_channel_keyword_alerts", "public.set_chapter_thread_pinned"]) {
      expect(body(name).trimStart(), name).toMatch(/^create (or replace )?function [^$]*\$function\$\s*begin\s+perform private\.lock_case_graph\(/);
    }
    expect(body("private.channel_settings_target")).toContain("private.can_read_chapter_space(s)");
    expect(body("private.channel_settings_target")).toContain("private.current_member_organization()");
    expect(body("public.set_chapter_thread_pinned")).toContain("private.assert_space_manager(target.space_id)");
  });

  it("gives no client a write path to pins, levels, mutes or keywords", () => {
    expect(code).toContain("revoke all on public.chapter_space_notification_settings from public, anon, authenticated, service_role;");
    expect(code).not.toMatch(/grant [^;]* on (table )?public\.chapter_space_notification_settings/);
    expect(code).not.toMatch(/grant (insert|update)[^;]*pinned_at/);
    expect(code).not.toMatch(/grant (insert|update)[^;]*chapter_space_members/);
    expect(code).toContain("alter table public.chapter_space_notification_settings enable row level security;");
    expect(code).toMatch(/create policy mfa_assurance on public\.chapter_space_notification_settings\s+as restrictive/);
    // The one client-writable addition is the mention list, and it is sanitized.
    expect(code).toContain("grant insert (mentioned_user_ids) on public.chapter_thread_posts to authenticated;");
    const sanitizer = body("private.prepare_chapter_post_mentions");
    expect(sanitizer).toContain("'features.messaging.mentions'");
    expect(sanitizer).toContain("m.id is distinct from post_author");
    expect(sanitizer).toContain("private.channel_member_can_read_space(m.id, target_space)");
    expect(code).toMatch(/create trigger chapter_thread_posts_prepare_mentions\s+before insert on public\.chapter_thread_posts/);
  });

  it("keeps a settings row from ever granting channel access", () => {
    // Access is chapter_space_members (private channels) and the visibility
    // rule; the readability check never consults the settings table.
    expect(body("private.channel_member_can_read_space")).not.toContain("chapter_space_notification_settings");
    expect(body("private.can_read_chapter_space")).not.toContain("chapter_space_notification_settings");
  });
});

describe("real notification production through the existing pipeline", () => {
  it("produces notices from an AFTER INSERT trigger through private.notify_member with the 'messages' kind", () => {
    expect(code).toMatch(/create trigger chapter_thread_posts_channel_alerts\s+after insert on public\.chapter_thread_posts/);
    const producer = body("private.produce_channel_post_alerts");
    expect(producer).toContain("private.notify_member(candidate.user_id, 'channel.' || candidate.reason");
    expect(producer).toContain("'messages'");
    expect(producer).toContain("private.channel_alert_decision(post.organization_id, post.space_id, candidate.user_id, candidate.reason) <> 'deliver'");
    expect(producer).toContain("private.channel_member_can_read_space(candidate.user_id, post.space_id)");
    for (const key of ["channel.mention", "channel.here", "channel.keyword", "channel.post"]) {
      for (const lang of ["en", "es"]) expect(flat, `${key} ${lang}`).toContain(`('${key}', '${lang}',`);
    }
  });

  it("makes 'messages' an outbound topic, so preferences, caps, kill switch and quiet hours apply", () => {
    const constraint = flat.slice(flat.indexOf("add constraint member_notifications_kind_check"));
    expect(constraint.slice(0, 300)).toContain("'messages'");
    expect(body("private.enqueue_notification_deliveries")).toContain("'appointments', 'workload', 'dues', 'messages'");
    expect(body("private.enqueue_notification_deliveries")).toContain("pref_value := prefs -> new.kind");
    expect(body("private.enqueue_notification_deliveries")).toContain("max_per_recipient_week := private.organization_limit(notification_org, 'limits.notifications.member_weekly_nudges')");
    expect(body("public.expire_notification_deliveries")).toContain("'appointments', 'workload', 'dues', 'messages')");
    // Quiet hours / DND defer at claim time for every non-urgent kind.
    expect(body("private.member_focus_blocks")).toContain("urgent := p_kind in ('deadlines', 'cases')");
    const dispatcher = read("api/notifications-dispatch.js");
    expect(dispatcher).toMatch(/\n {2}messages: \{\n {4}en: \{ subject:/);
    // The web topic list drops "dues": Union Ground has no dues, so the
    // web settings never offer a dues topic even though the inert schema
    // still admits the kind.
    const webTopics = read("src/lib/memberApi.js").match(/export const NOTIFICATION_TOPIC_KEYS = \[[^\]]*\]/)?.[0] ?? "";
    expect(webTopics).toContain('"appointments", "workload", "messages"]');
    expect(webTopics).not.toContain('"dues"');
    // The native list mirrors the web one: no dues topic there either.
    const nativeTopics = read("apps/mobile/src/lib/notificationPreferences.ts").match(/export const NOTIFICATION_TOPIC_KEYS[^=]*= \[[^\]]*\]/)?.[0] ?? "";
    expect(nativeTopics).toContain("'appointments', 'workload', 'messages']");
    expect(nativeTopics).not.toContain("'dues'");
  });

  it("@here reaches only online channel readers, rate-limited as the old app", () => {
    const producer = body("private.produce_channel_post_alerts");
    expect(producer).toContain("from public.member_presence presence");
    expect(producer).toContain("presence.status = 'online'");
    expect(producer).toContain("presence.last_seen_at >= pg_catalog.now() - interval '5 minutes'");
    expect(producer).toContain("limit 200");
    expect(producer).toContain("interval '10 minutes'");
    expect(producer).toMatch(/< 6\s+and pg_catalog\.count\(\*\) < 20/);
    // No new presence log: the existing one-row heartbeat is reused.
    expect(code).not.toMatch(/create table [^(]*presence/);
  });
});

describe("deterministic, tenant-scoped mute precedence", () => {
  const decision = () => body("private.channel_alert_decision");

  it("evaluates switch, mute, then level, in that order, from the channel's own organization", () => {
    const fn = decision();
    const switchAt = fn.indexOf("return 'switch_off'");
    const muteAt = fn.indexOf("return 'muted'");
    const noneAt = fn.indexOf("return 'level_none'");
    const mentionsAt = fn.indexOf("return 'level_mentions'");
    expect(switchAt).toBeGreaterThan(-1);
    expect(muteAt).toBeGreaterThan(switchAt);
    expect(noneAt).toBeGreaterThan(muteAt);
    expect(mentionsAt).toBeGreaterThan(noneAt);
    expect(fn).toContain("s.organization_id = p_organization_id and s.space_id = p_space_id and s.user_id = p_user_id");
    expect(fn).not.toContain("current_member_organization");
  });

  it("is mirrored exactly by the shared client module both apps use", () => {
    expect(CHANNEL_ALERT_PRECEDENCE.map((row) => row.result)).toEqual(["dropped", "switch_off", "muted", "level_none", "level_mentions", "deliver"]);
    const on = { channelPinning: true, notificationLevels: true, channelMute: true, mentions: true, hereMentions: true, mentionSearch: true, keywordAlerts: true };
    const now = new Date("2026-10-02T12:00:00Z");
    const muted = { muted: true, mutedUntil: "2026-10-02T13:00:00Z", level: "all" };
    expect(channelAlertDecision({ switches: { ...on, mentions: false }, setting: muted, reason: "mention", now })).toBe("switch_off");
    expect(channelAlertDecision({ switches: on, setting: muted, reason: "mention", now })).toBe("deliver");
    for (const reason of ["here", "keyword", "post"]) expect(channelAlertDecision({ switches: on, setting: muted, reason, now })).toBe("muted");
    expect(channelAlertDecision({ switches: on, setting: { ...muted, mutedUntil: "2026-10-02T11:00:00Z" }, reason: "post", now })).toBe("deliver");
    expect(channelAlertDecision({ switches: { ...on, channelMute: false }, setting: muted, reason: "here", now })).toBe("deliver");
    expect(channelAlertDecision({ switches: on, setting: { level: "none" }, reason: "mention", now })).toBe("level_none");
    expect(channelAlertDecision({ switches: on, setting: { level: "mentions" }, reason: "post", now })).toBe("level_mentions");
    expect(channelAlertDecision({ switches: on, setting: { level: "mentions" }, reason: "keyword", now })).toBe("deliver");
    expect(channelAlertDecision({ switches: { ...on, notificationLevels: false }, setting: { level: "none" }, reason: "mention", now })).toBe("deliver");
    expect(channelAlertDecision({ switches: { ...on, notificationLevels: false }, setting: { level: "all" }, reason: "post", now })).toBe("switch_off");
  });

  it("never reaches direct, task, announcement or urgent notices", () => {
    expect(CHANNEL_MUTE_NEVER_SILENCES).toEqual(["direct", "task", "announcement", "urgent"]);
    // Only the channel-post producer consults the channel settings.
    const consumers = new Set();
    for (const file of migrations.filter((candidate) => candidate.name >= RESTORE)) {
      const text = stripComments(file.sql);
      for (const match of text.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(/gi)) {
        const fnBody = text.slice(match.index, text.indexOf("$function$;", match.index) + 11);
        if (/channel_alert_decision\(|chapter_space_notification_settings/.test(fnBody.slice(fnBody.indexOf("as $"))))
          consumers.add(match[1].toLowerCase());
      }
    }
    for (const forbidden of ["notify_chapter_task_watchers", "send_chapter_task_message", "notify_stewards_of_request", "member_broadcast", "case_deadline_notice_sweep"]) {
      expect([...consumers].some((name) => name.includes(forbidden)), forbidden).toBe(false);
    }
    expect(consumers).toContain("private.produce_channel_post_alerts");
  });
});

describe("mention search respects message redaction", () => {
  it("searches only live channel bodies in channels the caller can read, never direct-message bodies", () => {
    const fn = body("public.search_my_channel_mentions");
    expect(fn).toContain("post.deleted_at is null");
    expect(fn).toContain("private.can_read_chapter_space(space)");
    expect(fn).not.toContain("member_messages");
    expect(fn).toContain("escape '\\'");
  });
});

describe("settings surfaces on responsive web, iPhone and Android", () => {
  it("responsive web offers levels, mute, keywords, pinning, mentions, highlighting and mention search", () => {
    const hub = read("src/views/ProductHubView.jsx");
    for (const needle of ["ChannelSettingsDialog", "MentionPicker", "MentionSearchPanel", "PinToggle", "ChannelPostBody", "orderThreadsForChannel"]) {
      expect(hub, needle).toContain(needle);
    }
    const ui = read("src/features/messaging/ChannelControls.jsx");
    expect(ui).toContain('role="radio"');
    expect(ui).toContain("<RadioGroup");
    expect(ui).toContain('role="search"');
    expect(ui).toContain("<mark");
    expect(read("src/lib/memberApi.js")).toContain("row.mentioned_user_ids = mentionIds");
    expect(read("src/App.jsx")).toContain("channelControlsClient=");
    expect(read("src/views/SettingsView.jsx")).toContain('messages: { labelKey: "settings.topicMessages"');
  });

  it("the Expo app (iPhone and Android) offers the same controls", () => {
    const screen = read("apps/mobile/app/channel/[id].tsx");
    for (const needle of ["ChannelSettingsPanel", "MentionPickerPanel", "ChannelHighlightedBody", "channelControlsApi.setPinned", "useChannelControls({ heartbeat: true })"]) {
      expect(screen, needle).toContain(needle);
    }
    expect(existsSync(resolve(root, "apps/mobile/app/mentions.tsx"))).toBe(true);
    // Union Ground's native Messages is a stack screen, not one of the five
    // dock tabs (Home, Work, Guide, Campaign, Account).
    expect(existsSync(resolve(root, "apps/mobile/app/(tabs)/messages.tsx"))).toBe(false);
    expect(read("apps/mobile/app/messages.tsx")).toContain("router.push('/mentions'");
    const live = read("apps/mobile/src/data/liveChannels.ts");
    expect(live).toContain("created_at,pinned_at");
    expect(live).toContain("parent_post_id,mentioned_user_ids");
    const panel = read("apps/mobile/src/components/ChannelControls.tsx");
    expect(panel).toContain('accessibilityRole="radiogroup"');
    expect(panel).toContain("selected={setting.level === level}");
  });

  it("every native channel-control Pressable or input carries a role or label", () => {
    const panel = read("apps/mobile/src/components/ChannelControls.tsx");
    for (const match of panel.matchAll(/<TextInput[\s\S]*?\/>/g)) expect(match[0]).toContain("accessibilityLabel=");
    expect(panel).not.toMatch(/<Pressable(?![^>]*accessibilityRole)/);
  });
});

describe("the engagement-era objects the retirement removed stay removed", () => {
  const RETIRED_OBJECTS = [
    "chapter_space_preferences", "chapter_space_keyword_monitors", "chapter_space_keyword_hits",
    "set_chapter_space_preference", "save_chapter_space_keyword_monitor",
    "mark_chapter_space_keyword_hit_read", "capture_chapter_space_keyword_hits",
    "chapter_thread_posts_capture_keyword_hits",
  ];
  const RETIRED_PAYLOAD_KEYS = ["keywordHits", "keywordMonitors"];
  const retirement = migrations.find((file) => file.name === "20260907122000_retire_dormant_channel_controls.sql");

  it("no later migration recreates them or their payload keys", () => {
    for (const file of migrations.filter((candidate) => candidate.name > retirement.name)) {
      const later = stripComments(file.sql).toLowerCase();
      for (const name of RETIRED_OBJECTS) expect(later, `${file.name} references ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      for (const key of RETIRED_PAYLOAD_KEYS) expect(later, `${file.name} emits ${key}`).not.toMatch(new RegExp(`'${key.toLowerCase()}'`));
    }
  });

  it("no client, API or script reads them, and nothing writes the restored columns directly", () => {
    const sources = [
      ...walk(resolve(root, "src"), [".js", ".jsx"]),
      ...walk(resolve(root, "api"), [".js"]),
      ...walk(resolve(root, "apps/mobile/src"), [".ts", ".tsx"]),
      ...walk(resolve(root, "apps/mobile/app"), [".ts", ".tsx"]),
      ...walk(resolve(root, "scripts"), [".mjs"]),
    ];
    expect(sources.length).toBeGreaterThan(200);
    const offenders = [];
    for (const path of sources) {
      if (/\.(test|spec)\./.test(path)) continue;
      const source = readFileSync(path, "utf8");
      for (const donor of ["set_chapter_space_preference", "save_chapter_space_keyword_monitor", "mark_chapter_space_keyword_hit_read", ...RETIRED_PAYLOAD_KEYS]) {
        if (source.includes(donor)) offenders.push(`${path}: ${donor}`);
      }
      if (/chapter_space_members[^\n]{0,200}notification_level|notification_level[^\n]{0,200}chapter_space_members/.test(source)) {
        offenders.push(`${path}: chapter_space_members.notification_level`);
      }
      if (/\.from\(\s*["']chapter_threads["']\s*\)\s*\.update\([^)]*pinned_at/.test(source)) {
        offenders.push(`${path}: direct chapter_threads.pinned_at write`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the retirement migration's replaced bodies remain the originals minus the retired references", () => {
  // History, not policy: these pins prove the 2026-09-06 retirement rewrote
  // three live functions faithfully. They stay true after the restore.
  const entry = migrations.find((file) => file.name === "20260907122000_retire_dormant_channel_controls.sql");
  const block = (name, start, end) => read(`supabase/migrations/${name}`).split("\n").slice(start - 1, end).join("\n");

  function extract(signature) {
    const raw = entry.sql;
    const start = raw.indexOf(signature);
    expect(start, `${signature} not found`).toBeGreaterThan(-1);
    const bodyStart = raw.indexOf("\nas $$\n", start);
    const end = raw.indexOf("\n$$;", bodyStart);
    return raw.slice(start, end + 4);
  }

  it("reproduces the export function exactly", () => {
    const original = block("20260812180000_member_account_lifecycle.sql", 73, 230)
      .replace(
        "create function public.get_member_data_export()",
        "create or replace function private.member_data_export_without_peer_contact()",
      )
      .replace(
        "        'spaceId', m.space_id, 'role', m.role, 'notificationLevel', m.notification_level,\n",
        "        'spaceId', m.space_id, 'role', m.role,\n",
      )
      .replace(
        "        'body', m.body, 'readAt', m.read_at, 'createdAt', m.created_at) order by m.created_at)",
        "        'body', m.body, 'redactedAt', m.redacted_at, 'redactionReason', m.redaction_reason,\n"
        + "        'bodySha256', m.body_sha256, 'originalLength', m.original_length,\n"
        + "        'readAt', m.read_at, 'createdAt', m.created_at) order by m.created_at)",
      );
    expect(extract("create or replace function private.member_data_export_without_peer_contact()")).toBe(original);
  });

  it("reproduces the two SAMPLE channel seeds exactly", () => {
    const cases = [
      {
        signature: "create or replace function public.presg_demo_seed_channels(",
        original: block("20260826160000_presg_demo_seed.sql", 829, 1086),
        dropped: "      case when t <= 2 then pg_catalog.now() - interval '3 days' else null end,\n",
      },
      {
        signature: "create or replace function public.uniondemo_seed_channels(",
        original: block("20260824233000_uniondemo_org_seed.sql", 974, 1230),
        dropped: "      case when t = 1 then pg_catalog.now() - interval '3 days' else null end,\n",
      },
    ];
    for (const item of cases) {
      const expected = item.original
        .replace("create function public.", "create or replace function public.")
        .replace(
          "    insert into public.chapter_threads (id, space_id, chapter_id, title, kind, status, resolved_at, pinned_at, created_at, updated_at)\n",
          "    insert into public.chapter_threads (id, space_id, chapter_id, title, kind, status, resolved_at, created_at, updated_at)\n",
        )
        .replace(item.dropped, "");
      expect(extract(item.signature), item.signature).toBe(expected);
    }
  });
});
