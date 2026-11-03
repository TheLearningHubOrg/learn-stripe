import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import Stripe from 'stripe';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import type { CheckoutGateway } from '../src/payments.js';
import { stripeWebhookVerifier } from '../src/payments.js';
import { OrderStore } from '../src/store.js';

// 1. Test-mode fixtures only. The key and secret are fake; nothing here reaches the network.
//    constructEvent and generateTestHeaderString are pure HMAC functions inside the SDK.
const FAKE_SECRET_KEY = 'sk_test_51FakeKeyForOfflineTestsOnly';
const WEBHOOK_SECRET = 'whsec_test_fixture_secret_for_offline_tests';
const stripe = new Stripe(FAKE_SECRET_KEY);

// 2. A fake Checkout gateway that records calls instead of hitting api.stripe.com.
function fakeCheckout() {
  const calls: Array<{ params: Stripe.Checkout.SessionCreateParams; idempotencyKey: string }> = [];
  let counter = 0;
  const gateway: CheckoutGateway = {
    async createCheckoutSession(params, idempotencyKey) {
      calls.push({ params, idempotencyKey });
      counter += 1;
      const id = `cs_test_fixture_${counter}`;
      return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    },
  };
  return { gateway, calls };
}

// 3. Build an event envelope shaped like a real test-mode delivery.
let eventSeq = 0;
function eventFixture(type: string, object: Record<string, unknown>, id?: string) {
  eventSeq += 1;
  return {
    id: id ?? `evt_test_fixture_${eventSeq}`,
    object: 'event',
    api_version: '2026-10-28.endive',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

function checkoutSessionObject(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_fixture_1',
    object: 'checkout.session',
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    client_reference_id: orderId,
    metadata: { orderId },
    payment_intent: 'pi_test_fixture_1',
    amount_total: 3800,
    currency: 'usd',
    livemode: false,
    ...overrides,
  };
}

function sign(payload: string, opts: { secret?: string; timestamp?: number } = {}) {
  return stripe.webhooks.generateTestHeaderString({
    payload,
    secret: opts.secret ?? WEBHOOK_SECRET,
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
  });
}

describe('learn-stripe companion service', () => {
  let store: OrderStore;
  let checkout: ReturnType<typeof fakeCheckout>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new OrderStore();
    checkout = fakeCheckout();
    app = createApp({
      checkout: checkout.gateway,
      webhooks: stripeWebhookVerifier(stripe, WEBHOOK_SECRET),
      store,
      publicBaseUrl: 'http://localhost:4242',
    });
  });

  async function createOrder(sku = 'guide-ebook', quantity = 2) {
    const res = await request(app).post('/checkout-sessions').send({ sku, quantity });
    assert.equal(res.status, 201);
    return res.body as { orderId: string; sessionId: string; url: string };
  }

  async function deliver(event: object, signatureOverride?: string) {
    const payload = JSON.stringify(event);
    return request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signatureOverride ?? sign(payload))
      .send(payload);
  }

  it('reports health', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  });

  describe('POST /checkout-sessions', () => {
    it('prices the cart on the server and passes an idempotency key', async () => {
      const body = await createOrder('guide-ebook', 2);
      assert.match(body.sessionId, /^cs_test_/);
      assert.equal(checkout.calls.length, 1);

      const { params, idempotencyKey } = checkout.calls[0]!;
      assert.equal(params.mode, 'payment');
      assert.equal(params.line_items?.[0]?.price_data?.unit_amount, 1900);
      assert.equal(params.line_items?.[0]?.quantity, 2);
      assert.equal(params.client_reference_id, body.orderId);
      assert.equal(idempotencyKey, `checkout:${body.orderId}`);
      assert.ok(params.success_url?.includes('{CHECKOUT_SESSION_ID}'));

      const order = store.get(body.orderId)!;
      assert.equal(order.amount, 3800);
      assert.equal(order.status, 'pending');
      assert.equal(order.checkoutSessionId, body.sessionId);
    });

    it('ignores any client-supplied amount', async () => {
      const res = await request(app).post('/checkout-sessions').send({ sku: 'workshop-seat', quantity: 1, amount: 1 });
      assert.equal(res.status, 201);
      assert.equal(checkout.calls[0]!.params.line_items?.[0]?.price_data?.unit_amount, 14900);
    });

    it('rejects unknown SKUs and invalid quantities', async () => {
      for (const body of [
        { sku: 'free-laptop', quantity: 1 },
        { sku: 'guide-ebook', quantity: 0 },
        { sku: 'guide-ebook', quantity: 11 },
        { sku: 'guide-ebook', quantity: 1.5 },
        { sku: '__proto__', quantity: 1 },
      ]) {
        const res = await request(app).post('/checkout-sessions').send(body);
        assert.equal(res.status, 400, JSON.stringify(body));
      }
      assert.equal(checkout.calls.length, 0);
    });

    it('returns 502 when Stripe is unreachable', async () => {
      const failing = createApp({
        checkout: {
          async createCheckoutSession() {
            throw new Error('connect ETIMEDOUT');
          },
        },
        webhooks: stripeWebhookVerifier(stripe, WEBHOOK_SECRET),
        store,
        publicBaseUrl: 'http://localhost:4242',
      });
      const res = await request(failing).post('/checkout-sessions').send({ sku: 'sticker-pack', quantity: 1 });
      assert.equal(res.status, 502);
    });
  });

  describe('POST /webhooks/stripe signature verification', () => {
    it('rejects a request with no Stripe-Signature header', async () => {
      const res = await request(app)
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(eventFixture('ping', {})));
      assert.equal(res.status, 400);
    });

    it('rejects a payload signed with the wrong secret', async () => {
      const { orderId } = await createOrder();
      const payload = JSON.stringify(eventFixture('checkout.session.completed', checkoutSessionObject(orderId)));
      const res = await deliver(JSON.parse(payload), sign(payload, { secret: 'whsec_attacker' }));
      assert.equal(res.status, 400);
      assert.equal(store.get(orderId)!.status, 'pending');
    });

    it('rejects a tampered body even with a once-valid signature', async () => {
      const { orderId } = await createOrder();
      const original = JSON.stringify(eventFixture('checkout.session.completed', checkoutSessionObject(orderId, { amount_total: 1 })));
      const signature = sign(original);
      const tampered = original.replace('"amount_total":1', '"amount_total":2');
      const res = await request(app)
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .send(tampered);
      assert.equal(res.status, 400);
    });

    it('rejects a replayed signature older than the tolerance window', async () => {
      const { orderId } = await createOrder();
      const payload = JSON.stringify(eventFixture('checkout.session.completed', checkoutSessionObject(orderId)));
      const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
      const res = await deliver(JSON.parse(payload), sign(payload, { timestamp: tenMinutesAgo }));
      assert.equal(res.status, 400);
    });
  });

  describe('event-driven fulfillment', () => {
    it('marks an order paid on checkout.session.completed', async () => {
      const { orderId } = await createOrder();
      const res = await deliver(eventFixture('checkout.session.completed', checkoutSessionObject(orderId)));
      assert.equal(res.status, 200);
      assert.equal(res.body.result, 'handled');

      const order = (await request(app).get(`/orders/${orderId}`)).body;
      assert.equal(order.status, 'paid');
      assert.equal(order.paymentIntentId, 'pi_test_fixture_1');
    });

    it('processes a redelivered event exactly once', async () => {
      const { orderId } = await createOrder();
      const event = eventFixture('checkout.session.completed', checkoutSessionObject(orderId), 'evt_test_dup');
      const first = await deliver(event);
      const second = await deliver(event);
      assert.equal(first.body.duplicate, undefined);
      assert.equal(second.status, 200);
      assert.equal(second.body.duplicate, true);
    });

    it('handles delayed payment methods: unpaid, then async success', async () => {
      const { orderId } = await createOrder();
      await deliver(eventFixture('checkout.session.completed', checkoutSessionObject(orderId, { payment_status: 'unpaid' })));
      assert.equal(store.get(orderId)!.status, 'awaiting_payment');

      await deliver(eventFixture('checkout.session.async_payment_succeeded', checkoutSessionObject(orderId)));
      assert.equal(store.get(orderId)!.status, 'paid');
    });

    it('keeps a settled outcome when checkout.session.completed arrives late', async () => {
      const { orderId } = await createOrder();
      await deliver(eventFixture('checkout.session.async_payment_succeeded', checkoutSessionObject(orderId)));
      const late = await deliver(
        eventFixture('checkout.session.completed', checkoutSessionObject(orderId, { payment_status: 'unpaid' })),
      );
      assert.equal(late.body.result, 'ignored');
      assert.equal(store.get(orderId)!.status, 'paid');
      assert.equal(store.get(orderId)!.paymentIntentId, 'pi_test_fixture_1');
    });

    it('marks delayed payment failures', async () => {
      const { orderId } = await createOrder();
      await deliver(eventFixture('checkout.session.completed', checkoutSessionObject(orderId, { payment_status: 'unpaid' })));
      await deliver(eventFixture('checkout.session.async_payment_failed', checkoutSessionObject(orderId, { payment_status: 'unpaid' })));
      assert.equal(store.get(orderId)!.status, 'failed');
    });

    it('expires only pending orders', async () => {
      const pending = await createOrder();
      const paid = await createOrder();
      await deliver(eventFixture('checkout.session.completed', checkoutSessionObject(paid.orderId)));

      await deliver(eventFixture('checkout.session.expired', checkoutSessionObject(pending.orderId, { status: 'expired' })));
      await deliver(eventFixture('checkout.session.expired', checkoutSessionObject(paid.orderId, { status: 'expired' })));
      assert.equal(store.get(pending.orderId)!.status, 'expired');
      assert.equal(store.get(paid.orderId)!.status, 'paid');
    });

    it('records partial and full refunds from charge.refunded', async () => {
      const { orderId } = await createOrder();
      await deliver(eventFixture('checkout.session.completed', checkoutSessionObject(orderId)));

      const charge = { id: 'ch_test_fixture_1', object: 'charge', payment_intent: 'pi_test_fixture_1', amount: 3800 };
      await deliver(eventFixture('charge.refunded', { ...charge, amount_refunded: 1900, refunded: false }));
      assert.equal(store.get(orderId)!.status, 'paid');
      assert.equal(store.get(orderId)!.amountRefunded, 1900);

      await deliver(eventFixture('charge.refunded', { ...charge, amount_refunded: 3800, refunded: true }));
      assert.equal(store.get(orderId)!.status, 'refunded');
    });

    it('acknowledges event types it does not handle', async () => {
      const res = await deliver(eventFixture('customer.created', { id: 'cus_test_fixture', object: 'customer' }));
      assert.equal(res.status, 200);
      assert.equal(res.body.result, 'ignored');
    });
  });

  describe('loadConfig', () => {
    it('accepts test-mode keys', () => {
      const cfg = loadConfig({ STRIPE_SECRET_KEY: FAKE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
      assert.equal(cfg.port, 4242);
    });

    it('refuses live keys unless explicitly allowed', () => {
      const env = { STRIPE_SECRET_KEY: 'sk_live_not_a_real_key', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
      assert.throws(() => loadConfig(env), ConfigError);
      assert.doesNotThrow(() => loadConfig({ ...env, STRIPE_ALLOW_LIVE: 'true' }));
    });

    it('refuses a missing webhook secret', () => {
      assert.throws(() => loadConfig({ STRIPE_SECRET_KEY: FAKE_SECRET_KEY }), ConfigError);
    });
  });
});
