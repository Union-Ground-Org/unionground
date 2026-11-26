// Union Ground line icons for the signed-out site, copied from the promo
// package's kit/brand/theme/icons.json (24-unit box, 1.75 stroke, round caps
// and joins, no fill, currentColor). Decorative: each sits beside its words.
const ICONS = {
  calendar: <><rect x="3.8" y="5.2" width="16.4" height="15" rx="2.6"/><path d="M3.8 9.9h16.4M8.2 3.4v3.5M15.8 3.4v3.5"/></>,
  cases: <><path d="M3.8 8.6a2 2 0 0 1 2-2h12.4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2z"/><path d="M9 6.6V5.4A1.4 1.4 0 0 1 10.4 4h3.2A1.4 1.4 0 0 1 15 5.4v1.2"/><path d="M3.8 12.4h16.4M12 11.2v2.4"/></>,
  chapters: <><circle cx="9" cy="8.6" r="3.2"/><path d="M3.4 19.6c.4-3.3 2.6-5.3 5.6-5.3s5.2 2 5.6 5.3"/><path d="M15.4 5.7a3.2 3.2 0 0 1 0 5.9M17.2 14.6c1.9.7 3.1 2.4 3.4 5"/></>,
  "chev-right": <><path d="m9.4 5.8 6.2 6.2-6.2 6.2"/></>,
  clock: <><circle cx="12" cy="12" r="8.6"/><path d="M12 7.3V12l3.1 1.9"/></>,
  contract: <><path d="M6.4 3.8h7.4l4.4 4.4v10a2 2 0 0 1-2 2H6.4a2 2 0 0 1-2-2V5.8a2 2 0 0 1 2-2z"/><path d="M13.6 3.8v4.6h4.6M8 12.4h7M8 15.8h4.6"/></>,
  deck: <><rect x="3.5" y="4.4" width="17" height="11.6" rx="2.2"/><path d="M12 16v3.4M8 19.6h8"/><path d="M8.4 12.6v-2M12 12.6V7.8M15.6 12.6V9.4"/></>,
  globe: <><circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.5 2.4 3.8 5.3 3.8 8.6s-1.3 6.2-3.8 8.6c-2.5-2.4-3.8-5.3-3.8-8.6S9.5 5.8 12 3.4z"/></>,
  layers: <><path d="m12 3.6 8.4 4.5-8.4 4.5-8.4-4.5z"/><path d="m3.6 12.2 8.4 4.5 8.4-4.5"/><path d="m3.6 16.1 8.4 4.5 8.4-4.5"/></>,
  menu: <><path d="M4.2 7h15.6M4.2 12h15.6M4.2 17h15.6"/></>,
  messages: <><path d="M4.2 6.4a2 2 0 0 1 2-2h11.6a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2h-6.3L7.4 20v-3.4H6.2a2 2 0 0 1-2-2z"/><path d="M8.2 9h7.6M8.2 12.2h4.6"/></>,
  open: <><circle cx="12" cy="12" r="8.6"/><path d="m8.4 12.3 2.4 2.4 4.8-5.2"/></>,
  play: <><rect x="3.5" y="5" width="17" height="14" rx="3.2"/><path d="m10.3 9.1 4.9 2.9-4.9 2.9z"/></>,
  rights: <><path d="M12 3.6 5 6.3v5.2c0 4.3 2.9 7.4 7 8.9 4.1-1.5 7-4.6 7-8.9V6.3z"/><path d="m9.1 12 2 2 3.8-4.1"/></>,
  signin: <><path d="M13.5 4.4h4a2 2 0 0 1 2 2v11.2a2 2 0 0 1-2 2h-4"/><path d="M4.5 12h10.2"/><path d="m11 8.2 3.8 3.8L11 15.8"/></>,
  tasks: <><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.4 12.2 2.4 2.4 4.9-5.2"/></>,
  vote: <><path d="M4.4 13.2h15.2v5.4a1.6 1.6 0 0 1-1.6 1.6H6a1.6 1.6 0 0 1-1.6-1.6z"/><path d="m8 13.2 1.4-8h5.2l1.4 8"/><path d="m10.4 8.8 1.3 1.3 2.2-2.4"/></>,
};

export function SiteIcon({ name, className = "site-icon" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}
