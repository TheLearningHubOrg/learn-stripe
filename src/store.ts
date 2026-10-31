import { randomUUID } from 'node:crypto';
import type { Order } from './types.js';

// In-memory persistence so the sample runs with zero infrastructure.
// In production this is a database table plus a unique index on event id.
export class OrderStore {
  private readonly orders = new Map<string, Order>();
  private readonly processedEvents = new Set<string>();

  create(fields: Omit<Order, 'id' | 'status'>): Order {
    const order: Order = { ...fields, id: `ord_${randomUUID()}`, status: 'pending' };
    this.orders.set(order.id, order);
    return order;
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  update(id: string, patch: Partial<Omit<Order, 'id'>>): Order | undefined {
    const current = this.orders.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.orders.set(id, next);
    return next;
  }

  findByPaymentIntent(paymentIntentId: string): Order | undefined {
    for (const order of this.orders.values()) {
      if (order.paymentIntentId === paymentIntentId) return order;
    }
    return undefined;
  }

  // Returns true the first time an event id is seen, false on any redelivery.
  claimEvent(eventId: string): boolean {
    if (this.processedEvents.has(eventId)) return false;
    this.processedEvents.add(eventId);
    return true;
  }

  releaseEvent(eventId: string): void {
    this.processedEvents.delete(eventId);
  }
}
