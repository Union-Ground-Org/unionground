-- Sole-writer revokes for the four atomic member-write RPCs (20260725000000).
--
-- ============================= APPLY ORDER ==================================
-- CONTRACT phase of an expand/contract rollout. Apply ONLY AFTER the frontend
-- deploy that calls the RPCs is verified live at its exact SHA. Rationale:
-- these revokes are backward-incompatible in both directions —
--   * applied early, every old cached bundle's direct-table write fails 42501;
--   * skipped, the RPC validations are decorative, because the raw PostgREST
--     table write they replaced is still reachable and an attacker simply
--     keeps using the old endpoint.
-- Navigations are network-first and HTML is never cached (public/sw.js), so
-- any reload/relaunch after the deploy picks up the RPC bundle; the only
-- exposure is a SPA session held open across the entire rollout without a
-- single navigation. (: two-migration split chosen
-- over single-step for zero write-downtime.)
-- ============================================================================
--
-- The revokes are surgical: each verb was verified to have no remaining client
-- caller (repo-wide grep over src/, api/, and scripts/ finds only SELECTs on
-- these tables outside the four RPCs).
--
-- ROLLBACK (copy-paste, only if the frontend must roll back to a pre-RPC
-- bundle AFTER this migration has been applied — the old bundle direct-table
-- writes, so these grants must come back first or every member write 42501s):
--   grant insert on public.member_messages to authenticated;
--   grant insert, update on public.member_conversations to authenticated;
--   grant insert on public.member_cases to authenticated;
--   grant insert, update on public.member_ballot_votes to authenticated;
--   grant insert, update on public.member_survey_responses to authenticated;
--   grant update on public.member_messages to authenticated;
--   grant update on public.member_cases to authenticated;
--   notify pgrst, 'reload schema';
--
-- REQ-UG-ATOMIC-MEMBER-WRITES-20260725 (contract phase).

set local lock_timeout = '5s';

-- Machine-enforced ordering: filename sort proves nothing about what was
-- actually applied to a given database (out-of-band applies stamp their own
-- versions). If the EXPAND phase's RPCs are not present, refuse loudly
-- instead of silently revoking the only write path members would have left.
do $$
begin
  if pg_catalog.to_regprocedure('public.send_member_message(uuid, text)') is null then
    raise exception 'apply 20260725000000_atomic_member_write_rpcs (EXPAND phase) first'
      using errcode = '42883';
  end if;
end
$$;

revoke insert on public.member_messages from authenticated;
revoke insert, update on public.member_conversations from authenticated;
revoke insert on public.member_cases from authenticated;
revoke insert, update on public.member_ballot_votes from authenticated;
revoke insert, update on public.member_survey_responses from authenticated;

-- Column-scope the two UPDATE grants that must survive. Supabase's platform
-- default privileges grant `authenticated` table-wide UPDATE (every column) at
-- CREATE TABLE time, so the repo's earlier `grant ... (col)` statements were
-- decorative — the table-level bit stood underneath them, and the *_update_own
-- RLS policies carry no column or sender_kind restriction. Left as-is, a member
-- could PATCH their own row one request after a legit write to overwrite the
-- very columns the RPCs exist to control: on member_messages, forge
-- sender_kind='steward' / sender_name (the impersonation defect the RPC
-- migration closes) or rewrite a past body (grievance-channel repudiation); on
-- member_cases, overwrite the CSPRNG reference, defeat the case_type allow-list
-- the staff planes group on, or blow the length bounds. Revoke the table bit
-- first, then regrant exactly the columns the two surviving client callers
-- write (markConversationRead -> read_at; updateMemberCase -> status/step/deadline).
revoke update on public.member_messages from authenticated;
grant  update (read_at) on public.member_messages to authenticated;
revoke update on public.member_cases from authenticated;
grant  update (status, step, deadline) on public.member_cases to authenticated;

-- KEPT ON PURPOSE, do not add to the revoke list above:
--   * member_action_log INSERT — saveRightsProgress and requestSteward still
--     call logAction directly. Revoking it would break both. The award
--     trigger's prefix anchoring plus its entity-backing check are the defense
--     for entity-anchored keys (vote/survey/case/form/scan/... each pin a
--     specific entity id). NOTE the exception: the 'message' and 'steward'
--     branches anchor only to a conversation / lesson id with an unvalidated
--     numeric tail, so a forged key there *does* earn points (bounded by the
--     weekly cap, ~40 pts/wk). Not closed here — tracked as a follow-up that
--     rebinds those keys to the message / steward-request row id.
--
-- CONTRACT COORDINATION (scripts/db-contract.json): applying this migration
-- shrinks five knownGaps.surplusClientTableGrants privilege strings and adds
-- two column grants. The verifier matches gap strings exactly, so the shrunk
-- strings read as NEW gaps until the contract is updated — land the contract
-- update in the same operational step as this apply, before any CI run.

notify pgrst, 'reload schema';
