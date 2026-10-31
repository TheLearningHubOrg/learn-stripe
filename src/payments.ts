import type Stripe from 'stripe';

// A narrow port over the Stripe SDK. Routes depend on this interface, so tests
// can swap in a fake and never touch the network.
export interface CheckoutGateway {
  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string,
  ): Promise<{ id: string; url: string | null }>;
}

export interface WebhookVerifier {
  verify(rawBody: Buffer, signatureHeader: string): Stripe.Event;
}

export function stripeCheckoutGateway(stripe: Stripe): CheckoutGateway {
  return {
    async createCheckoutSession(params, idempotencyKey) {
      const session = await stripe.checkout.sessions.create(params, { idempotencyKey });
      return { id: session.id, url: session.url };
    },
  };
}

// constructEvent recomputes the HMAC-SHA256 over `${timestamp}.${rawBody}` and
// compares it in constant time; it also rejects timestamps outside the tolerance.
export function stripeWebhookVerifier(
  stripe: Stripe,
  endpointSecret: string,
  toleranceSeconds = 300,
): WebhookVerifier {
  return {
    verify(rawBody, signatureHeader) {
      return stripe.webhooks.constructEvent(rawBody, signatureHeader, endpointSecret, toleranceSeconds);
    },
  };
}
