// Billing module: NOT IMPLEMENTED on purpose. These are the plug-in points for a future Stripe
// integration (see README "Stripe later"). Nothing here talks to any payment provider.

export class NotImplementedError extends Error {
  constructor(what: string) { super(`${what}: not implemented`); }
}

/** Start a subscription checkout for a host and return a URL to send the browser to. */
export function createCheckoutSession(_hostId: string): Promise<{ url: string }> {
  throw new NotImplementedError('createCheckoutSession');
}

/** Verify and process a provider webhook (raw body + signature header); should flip the host's flag. */
export function handleWebhook(_rawBody: Buffer, _signatureHeader: string | undefined): Promise<void> {
  throw new NotImplementedError('handleWebhook');
}

/** Return a URL where the host can manage or cancel the subscription. */
export function createPortalSession(_hostId: string): Promise<{ url: string }> {
  throw new NotImplementedError('createPortalSession');
}
