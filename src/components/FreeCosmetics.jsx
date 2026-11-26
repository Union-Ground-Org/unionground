import { BusyButton } from "./BusyControls.jsx";
import { useEffect, useId, useState } from 'react';
import { useLang } from '../lib/LanguageContext.jsx';
import { cosmeticCopyFor } from '../lib/freeCosmetics.js';
import { formatGroupMoment } from '../lib/i18n/zonedDates.js';
import './freeCosmetics.css';

// Owner ruling, November 3, 2026: Union green
// is the only theme, so a theme cosmetic is neither offered, applied nor
// granted on the web; a stored theme choice renders nothing. Badges and the
// native-only app icon are not themes and stay.
const offered = (items) => items.filter((item) => item.kind !== 'theme');

export function FreeCosmetics({ rewards }) {
  const { lang } = useLang();
  const c = cosmeticCopyFor(lang);
  const id = useId();
  const [userId, setUserId] = useState('');
  const [key, setKey] = useState('');
  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const w = rewards?.workspace;
  const items = offered(w?.items ?? []);
  const grantKey = items.some((item) => item.key === key) ? key : items[0]?.key ?? '';
  const reload = rewards?.load;
  useEffect(() => { void reload?.(); }, [reload]);
  const label = (item) => lang === 'es' ? item.labelEs : item.labelEn;
  async function change(action, success) {
    setMessage(''); setFailed(false);
    try { await action(); setMessage(success); }
    catch { setMessage(c.failed); setFailed(true); }
  }
  return <section className="free-cosmetics" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>{c.title}</h2><p>{c.intro}</p><p>{c.milestone}</p>
    {!w ? <div role={rewards?.error ? 'alert' : 'status'}>
      <p>{rewards?.error || !rewards?.available ? c.unavailable : c.loading}</p>
      {rewards?.available && <button type="button" onClick={() => rewards.load()}>{c.retry}</button>}
    </div> : <>
      <ul className="free-cosmetics__catalog">{items.map((item) => <li key={item.key}>
        <h3>{label(item)}</h3><p>{c[item.kind === 'badge' ? 'badgeKind' : item.kind]}</p>
        <p>{item.selected ? c.selected : item.earned ? c.earned : c.locked}</p>
        {item.kind === 'badge' && item.selected && <span className="free-cosmetics__badge">✦ {c.badge}</span>}
        {/* BUG-UG-REWARDS-TIER-GATED-AND-DISABLED-APPLY-20261106: an
            unearned cosmetic shows its "Not earned yet" state, not a greyed
            control it can never use. */}
        {item.kind === 'icon' ? <p>{c.iconWeb}</p> : !item.earned && !item.selected ? null : <BusyButton type="button" pending={rewards.busy} disabled={!item.earned}
          aria-label={`${item.selected ? c.remove : c.apply} ${label(item)}`}
          onClick={() => change(() => rewards.select(item.kind, item.selected ? null : item.key), c.saved)}>
          {rewards.busy ? c.busy : item.selected ? c.remove : c.apply}</BusyButton>}
      </li>)}</ul>
      {w.canGrant && <form onSubmit={(event) => {
        event.preventDefault();
        void change(() => rewards.grant(userId, grantKey, reason), c.granted);
      }}>
        <h3>{c.admin}</h3>
        <label>{c.search}<input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /></label>
        <BusyButton type="button" pending={rewards.busy} onClick={() => { setUserId(''); void rewards.load(search); }}>{c.searchAction}</BusyButton>
        <p>{c.recipientHelp}</p>
        <label>{c.member}<select value={userId} onChange={(event) => setUserId(event.target.value)} required>
          <option value="">{c.choose}</option>{w.recipients.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select></label>
        <label>{c.item}<select value={grantKey} onChange={(event) => setKey(event.target.value)}>
          {items.map((item) => <option key={item.key} value={item.key}>{label(item)}</option>)}
        </select></label>
        <label>{c.reason}<textarea value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={500} /></label>
        <BusyButton pending={rewards.busy} disabled={!userId || !grantKey || !reason.trim()}>{rewards.busy ? c.busy : c.grant}</BusyButton>
      </form>}
      <h3>{c.history}</h3>
      {!w.history.length ? <p>{c.empty}</p> : <ul>{w.history.map((award) => <li key={award.id}>
        <strong>{label(w.items.find((item) => item.key === award.itemKey) ?? { labelEn: award.itemKey, labelEs: award.itemKey })}</strong>
        {w.canGrant && <span> · {award.memberName || award.userId}</span>}
        <p>{award.source === 'rights_checklist' ? c.checklist : award.reason}</p>
        <p><time dateTime={award.createdAt}>{formatGroupMoment(award.createdAt, lang)}</time></p>
      </li>)}</ul>}
    </>}
    {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
  </section>;
}
