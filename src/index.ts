import Stripe from 'stripe';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { stripeCheckoutGateway, stripeWebhookVerifier } from './payments.js';
import { OrderStore } from './store.js';

// Entry point: wire the real Stripe adapters into the app and start listening.
const config = loadConfig();

// The SDK pins the API version it was generated against; retries cover transient 5xx/429s.
const stripe = new Stripe(config.stripeSecretKey, {
  maxNetworkRetries: 2,
  timeout: 20_000,
  appInfo: { name: 'learn-stripe', version: '1.0.0' },
});

const app = createApp({
  checkout: stripeCheckoutGateway(stripe),
  webhooks: stripeWebhookVerifier(stripe, config.webhookSecret),
  store: new OrderStore(),
  publicBaseUrl: config.publicBaseUrl,
  log: (msg, meta) => console.log(JSON.stringify({ level: 'info', msg, ...meta })),
});

app.listen(config.port, () => {
  console.log(`learn-stripe listening on http://localhost:${config.port}`);
});
