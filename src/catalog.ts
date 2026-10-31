import type { CatalogItem } from './types.js';

// 1. Server-side price list. The browser sends a SKU and a quantity, never an amount.
export const CATALOG: Readonly<Record<string, CatalogItem>> = Object.freeze({
  'guide-ebook': { name: 'Stripe Field Guide (eBook)', unitAmount: 1900, currency: 'usd' },
  'workshop-seat': { name: 'Payments Workshop Seat', unitAmount: 14900, currency: 'usd' },
  'sticker-pack': { name: 'Sticker Pack', unitAmount: 500, currency: 'usd' },
});

export const MAX_QUANTITY = 10;

export class CatalogError extends Error {}

// 2. Turn an untrusted request into a priced line item, or throw.
export function priceLineItem(sku: unknown, quantity: unknown) {
  if (typeof sku !== 'string' || !Object.hasOwn(CATALOG, sku)) {
    throw new CatalogError('Unknown SKU');
  }
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new CatalogError(`Quantity must be an integer between 1 and ${MAX_QUANTITY}`);
  }
  const item = CATALOG[sku] as CatalogItem;
  return { sku, quantity, item, total: item.unitAmount * quantity };
}
