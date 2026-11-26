// The signed-out surfaces (landing, sign-in, the public document pages) used to
// render outside .sg-app, so they read the light :root aliases. Record
// REQ-UG-SITEWIDE-NEUROMAP-PAPER-VISUAL-LANGUAGE-20261104 wraps them in
// the same identity scope the signed-in shell uses. The site renders light
// only (REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105): the device's
// colour scheme is never read. There is no picker.
export function IdentityThemeScope({ children }) {
  return (
    <div className="sg-app sg-app--public" data-workspace-theme="union-ground">
      {children}
    </div>
  );
}
