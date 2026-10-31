// Environment loading with a guard rail: test-mode keys only unless you opt in.

export interface AppConfig {
  stripeSecretKey: string;
  webhookSecret: string;
  publicBaseUrl: string;
  port: number;
}

export class ConfigError extends Error {}

const TEST_KEY = /^(sk|rk)_test_/;
const LIVE_KEY = /^(sk|rk)_live_/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const stripeSecretKey = env.STRIPE_SECRET_KEY ?? '';
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET ?? '';

  if (!TEST_KEY.test(stripeSecretKey) && !LIVE_KEY.test(stripeSecretKey)) {
    throw new ConfigError('STRIPE_SECRET_KEY must be a secret (sk_) or restricted (rk_) key');
  }
  if (LIVE_KEY.test(stripeSecretKey) && env.STRIPE_ALLOW_LIVE !== 'true') {
    throw new ConfigError('Live key detected. Set STRIPE_ALLOW_LIVE=true only in production.');
  }
  if (!webhookSecret.startsWith('whsec_')) {
    throw new ConfigError('STRIPE_WEBHOOK_SECRET must start with whsec_');
  }

  return {
    stripeSecretKey,
    webhookSecret,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? 'http://localhost:4242').replace(/\/$/, ''),
    port: Number(env.PORT ?? 4242),
  };
}
