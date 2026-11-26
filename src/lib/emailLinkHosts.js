// Hosts whose https links may carry an emailed invitation or password-reset
// credential. Union Ground has no verified domain yet, so none may: every
// emailed link is refused until one is approved here and in
// config/mobile-app-links.json. Never list a sibling product's host. Kept in
// its own module so suites can substitute a fictional host.
export const EMAIL_LINK_HOSTS = Object.freeze([]);
