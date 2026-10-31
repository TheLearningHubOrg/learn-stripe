import express, { type Request, type Response } from 'express';
import { CatalogError, priceLineItem } from './catalog.js';
import { handleStripeEvent } from './fulfillment.js';
import type { CheckoutGateway, WebhookVerifier } from './payments.js';
import type { OrderStore } from './store.js';

export interface AppDeps {
  checkout: CheckoutGateway;
  webhooks: WebhookVerifier;
  store: OrderStore;
  publicBaseUrl: string;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export function createApp({ checkout, webhooks, store, publicBaseUrl, log = () => {} }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');

  // 1. Webhook route FIRST, with a raw body parser. Signature checks need the exact
  //    bytes Stripe sent; a JSON parser would re-serialise them and break the HMAC.
  app.post(
    '/webhooks/stripe',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req: Request, res: Response) => {
      const signature = req.header('stripe-signature');
      if (!signature || !Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: 'Missing Stripe-Signature header or body' });
        return;
      }

      let event;
      try {
        event = webhooks.verify(req.body, signature);
      } catch (err) {
        log('webhook signature rejected', { reason: (err as Error).message });
        res.status(400).json({ error: 'Invalid signature' });
        return;
      }

      // 2. Deduplicate: Stripe delivers at least once, so an event id can arrive again.
      if (!store.claimEvent(event.id)) {
        res.status(200).json({ received: true, duplicate: true });
        return;
      }

      try {
        const result = handleStripeEvent(event, store);
        log('webhook processed', { id: event.id, type: event.type, result });
        res.status(200).json({ received: true, result });
      } catch (err) {
        // 3. Release the claim and answer 500 so Stripe retries later.
        store.releaseEvent(event.id);
        log('webhook handler failed', { id: event.id, error: (err as Error).message });
        res.status(500).json({ error: 'Handler failed' });
      }
    },
  );

  // 4. Everything else speaks JSON.
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/checkout-sessions', async (req: Request, res: Response) => {
    let priced;
    try {
      priced = priceLineItem(req.body?.sku, req.body?.quantity);
    } catch (err) {
      if (err instanceof CatalogError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const order = store.create({
      sku: priced.sku,
      quantity: priced.quantity,
      amount: priced.total,
      currency: priced.item.currency,
    });

    try {
      const session = await checkout.createCheckoutSession(
        {
          mode: 'payment',
          line_items: [
            {
              quantity: priced.quantity,
              price_data: {
                currency: priced.item.currency,
                unit_amount: priced.item.unitAmount,
                product_data: { name: priced.item.name },
              },
            },
          ],
          client_reference_id: order.id,
          metadata: { orderId: order.id, sku: priced.sku },
          success_url: `${publicBaseUrl}/orders/${order.id}?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${publicBaseUrl}/cart`,
        },
        // 5. One idempotency key per order: a retried request cannot create a second session.
        `checkout:${order.id}`,
      );
      store.update(order.id, { checkoutSessionId: session.id });
      res.status(201).json({ orderId: order.id, sessionId: session.id, url: session.url });
    } catch (err) {
      log('checkout session creation failed', { orderId: order.id, error: (err as Error).message });
      res.status(502).json({ error: 'Payment provider unavailable', orderId: order.id });
    }
  });

  // 6. The success page reads OUR order state, which only webhooks move to "paid".
  app.get('/orders/:id', (req: Request<{ id: string }>, res: Response) => {
    const order = store.get(req.params.id);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json(order);
  });

  return app;
}
