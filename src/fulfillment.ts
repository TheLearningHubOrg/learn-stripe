import type Stripe from 'stripe';
import type { OrderStore } from './store.js';

export type HandleResult = 'handled' | 'ignored';

function paymentIntentId(value: string | Stripe.PaymentIntent | null): string | undefined {
  if (!value) return undefined;
  return typeof value === 'string' ? value : value.id;
}

function orderIdFrom(session: Stripe.Checkout.Session): string | undefined {
  return session.client_reference_id ?? session.metadata?.orderId ?? undefined;
}

// State transitions keyed off verified events. Every branch is safe to run twice.
export function handleStripeEvent(event: Stripe.Event, store: OrderStore): HandleResult {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const orderId = orderIdFrom(session);
      if (!orderId || !store.get(orderId)) return 'ignored';
      // Cards report 'paid' immediately; bank debits report 'unpaid' and settle later.
      const status = session.payment_status === 'unpaid' ? 'awaiting_payment' : 'paid';
      const piId = paymentIntentId(session.payment_intent);
      store.update(orderId, { status, ...(piId ? { paymentIntentId: piId } : {}) });
      return 'handled';
    }
    case 'checkout.session.async_payment_succeeded': {
      const orderId = orderIdFrom(event.data.object);
      if (!orderId || !store.update(orderId, { status: 'paid' })) return 'ignored';
      return 'handled';
    }
    case 'checkout.session.async_payment_failed': {
      const orderId = orderIdFrom(event.data.object);
      if (!orderId || !store.update(orderId, { status: 'failed' })) return 'ignored';
      return 'handled';
    }
    case 'checkout.session.expired': {
      const orderId = orderIdFrom(event.data.object);
      const order = orderId ? store.get(orderId) : undefined;
      // Never let a late "expired" overwrite an order that already moved on.
      if (!order || order.status !== 'pending') return 'ignored';
      store.update(order.id, { status: 'expired' });
      return 'handled';
    }
    case 'charge.refunded': {
      const charge = event.data.object;
      const piId = paymentIntentId(charge.payment_intent);
      const order = piId ? store.findByPaymentIntent(piId) : undefined;
      if (!order) return 'ignored';
      store.update(order.id, {
        amountRefunded: charge.amount_refunded,
        ...(charge.refunded ? { status: 'refunded' as const } : {}),
      });
      return 'handled';
    }
    default:
      return 'ignored';
  }
}
