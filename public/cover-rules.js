// When the cover screen (title + Play button) is shown. Pure so it can be unit tested (test/cover.test.ts).
// - ?cover=1 always shows it (for testing).
// - otherwise once per browser session (sessionStorage flag), and not when the link has a purpose: an invite code or a return from checkout.
// Resuming a seat is decided later (the server sends the table after connecting): the client hides the cover as soon as a table, tournament or event arrives.

export function shouldShowCover({ forced = false, seen = false, deepLink = false } = {}) {
  if (forced) return true;
  return !seen && !deepLink;
}
