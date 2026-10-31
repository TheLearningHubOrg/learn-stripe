// Domain types for the companion service. Stripe objects stay at the edge;
// the rest of the app works with these small, explicit shapes.

export type OrderStatus =
  | 'pending' // Checkout Session created, customer has not finished
  | 'awaiting_payment' // Checkout completed with a delayed method (e.g. bank debit)
  | 'paid' // money confirmed: safe to fulfil
  | 'failed' // delayed payment failed
  | 'expired' // Checkout Session expired without payment
  | 'refunded'; // fully refunded after payment

export interface Order {
  id: string;
  sku: string;
  quantity: number;
  amount: number; // total in the smallest currency unit (cents for USD)
  currency: string;
  status: OrderStatus;
  checkoutSessionId?: string;
  paymentIntentId?: string;
  amountRefunded?: number;
}

export interface CatalogItem {
  name: string;
  unitAmount: number;
  currency: string;
}
