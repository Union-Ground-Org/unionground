import { useEffect, useId, useRef, useState } from "react";
import { announcementCopy } from "./copy.js";
import { ANNOUNCEMENT_PAGE } from "./api.js";
import { localDateTimeInputValue } from "../../lib/localDateTime.js";
import { BusyButton, BusyInput, BusyTextarea } from "../../components/BusyControls.jsx";

const blank = { p_id: null, p_expected_revision: 0, p_title_en: "", p_title_es: "", p_body_en: "", p_body_es: "", p_expires_at: "", p_supersedes_id: null };
export function PlatformAnnouncementPublisher({ api, locale, initial }) {
  const c = announcementCopy(locale);
  const uid = useId();
  const [workspace, setWorkspace] = useState(initial);
  const [form, setForm] = useState(blank);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [followers, setFollowers] = useState(null);
  const active = useRef(true);
  const working = useRef(false);
  const cursors = useRef({ post: null, audit: null });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function operate(action) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(false);
    try { await action(); }
    catch { if (active.current) setError(true); }
    finally { working.current = false; if (active.current) setBusy(false); }
  }
  async function reload(after = cursors.current.post, auditBefore = cursors.current.audit) {
    const next = await api.workspace(after, auditBefore);
    if (active.current) { cursors.current = { post: after, audit: auditBefore }; setWorkspace(next); setReviewed(false); }
  }
  function fill(post, correction = false) {
    setForm({ p_id: correction ? null : post.id, p_expected_revision: correction ? 0 : post.revision,
      p_title_en: post.title_en, p_title_es: post.title_es, p_body_en: post.body_en, p_body_es: post.body_es,
      p_expires_at: localDateTimeInputValue(post.expires_at), p_supersedes_id: correction ? post.id : post.supersedes_id });
    setReviewed(false);
  }
  const posts = Array.isArray(workspace.posts) ? workspace.posts.slice(0, ANNOUNCEMENT_PAGE) : [];
  const audit = Array.isArray(workspace.audit) ? workspace.audit.slice(0, ANNOUNCEMENT_PAGE) : [];
  return <div className="pa-panel ph-no-capture" data-sentry-mask="true" aria-label={c.publisher}>
    <h3>{c.publisher}</h3>
    {error ? <p role="alert">{c.unavailable}</p> : null}
    <BusyButton className="pa-button" pending={busy} onClick={() => { setForm(blank); setReviewed(false); }}>{c.draft}</BusyButton>
    <form className="pa-form" onSubmit={event => {
      event.preventDefault();
      void operate(async () => {
        const result = await api.save({ ...form, p_expires_at: new Date(form.p_expires_at).toISOString() });
        if (active.current) setForm(previous => ({ ...previous, p_id: result.id, p_expected_revision: result.revision }));
        await reload();
      });
    }}>
      {[["p_title_en", c.titleEn], ["p_title_es", c.titleEs], ["p_body_en", c.bodyEn], ["p_body_es", c.bodyEs]].map(([name, label]) => <label key={name} htmlFor={`${uid}-${name}`}>{label}
        {name.includes("body") ? <BusyTextarea id={`${uid}-${name}`} value={form[name]} required maxLength={4000} pending={busy} onChange={event => setForm({ ...form, [name]: event.target.value })} />
          : <BusyInput id={`${uid}-${name}`} value={form[name]} required maxLength={120} pending={busy} onChange={event => setForm({ ...form, [name]: event.target.value })} />}
      </label>)}
      <label htmlFor={`${uid}-expires`}>{c.expires}<BusyInput id={`${uid}-expires`} type="datetime-local" required value={form.p_expires_at} pending={busy} onChange={event => setForm({ ...form, p_expires_at: event.target.value })} /></label>
      <BusyButton className="pa-button" type="submit" pending={busy}>{c.save}</BusyButton>
    </form>
    <label className="pa-review"><BusyInput type="checkbox" checked={reviewed} pending={busy} onChange={event => setReviewed(event.target.checked)} /> {c.reviewNotice}</label>
    <h4>{c.posts}</h4>
    {!posts.length ? <p>{c.noPosts}</p> : null}
    {posts.map(post => <article key={`${post.id}:${post.revision}`} className="pa-post">
      <h4>{locale === "es" ? post.title_es : post.title_en}</h4>
      <p>{locale === "es" ? post.body_es : post.body_en}</p>
      <p>{c[`${post.state}State`]}</p>
      <div className="pa-actions">
        {["draft", "reviewed"].includes(post.state) ? <BusyButton className="pa-button" pending={busy} onClick={() => fill(post)}>{c.edit}</BusyButton> : null}
        {post.state === "draft" ? <BusyButton className="pa-button" pending={busy} disabled={!reviewed} onClick={() => { void operate(async () => { await api.transition("review", post.id, post.revision); await reload(); }); }}>{c.review}</BusyButton> : null}
        {post.state === "reviewed" ? <BusyButton className="pa-button" pending={busy} onClick={() => { void operate(async () => { await api.transition("publish", post.id, post.revision); await reload(); }); }}>{c.publish}</BusyButton> : null}
        {post.state === "published" ? <BusyButton className="pa-button" pending={busy} onClick={() => fill(post, true)}>{c.correct}</BusyButton> : null}
        {post.state !== "withdrawn" ? <BusyButton className="pa-button" pending={busy} onClick={() => { void operate(async () => { await api.transition("withdraw", post.id, post.revision); await reload(); }); }}>{c.withdraw}</BusyButton> : null}
      </div>
    </article>)}
    <div className="pa-actions">
      <BusyButton className="pa-button" pending={busy} onClick={() => { void operate(() => reload(null, null)); }}>{c.newest}</BusyButton>
      {workspace.hasMorePosts ? <BusyButton className="pa-button" pending={busy} onClick={() => { void operate(() => reload(workspace.nextPostId)); }}>{c.morePosts}</BusyButton> : null}
    </div>
    <h4>{c.audit}</h4>
    <ul>{audit.map(event => <li key={event.id}>{c[event.action] ?? c.saved} · {new Date(event.occurred_at).toLocaleString(locale)}</li>)}</ul>
    {workspace.hasMoreAudit ? <BusyButton className="pa-button" pending={busy} onClick={() => { void operate(() => reload(cursors.current.post, workspace.nextAuditBefore)); }}>{c.moreAudit}</BusyButton> : null}
    <h4>{c.followers}</h4>
    <BusyButton className="pa-button" pending={busy} onClick={() => { void operate(async () => { const next = await api.followers(); if (active.current) setFollowers(next.items); }); }}>{c.refresh}</BusyButton>
    {followers ? <ul>{followers.map(row => <li key={row.organizationId}>{row.name} · {row.status === "active" ? c.active : c.revoked}</li>)}</ul> : null}
    {followers?.length === ANNOUNCEMENT_PAGE ? <BusyButton className="pa-button" pending={busy} onClick={() => { void operate(async () => { const next = await api.followers(followers.at(-1).organizationId); if (active.current) setFollowers(next.items); }); }}>{c.moreFollowers}</BusyButton> : null}
  </div>;
}
