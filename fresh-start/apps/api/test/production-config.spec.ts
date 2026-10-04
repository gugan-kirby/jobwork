import { afterEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../src/platform/config/config.service';

/**
 * F-12.3 finding: in production the API used to start on the service-token and webhook
 * secrets this public repository ships as defaults, letting anyone mint a worker token
 * (and, say, mark an upload clean) or forge a payment callback. It now refuses.
 */
describe('API production configuration', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  const strong = (seed: string): string => `${seed}-${'x9Lm4Xc8Rb1Nf6Hd3Ks0Wp5Yz2Ae7Tq'}`;

  it('refuses to start in production on the repository defaults', () => {
    process.env = { NODE_ENV: 'production', SESSION_SECRET: 'dev-only-change-me' };
    expect(() => new ConfigService()).toThrow(/refusing to start in production: SESSION_SECRET.*SERVICE_TOKEN_SECRET.*PAYMENT_WEBHOOK_SECRET.*OBJECT_STORE_ACCESS_KEY.*OBJECT_STORE_SECRET_KEY.*DATABASE_URL/);
  });

  it('starts in production once every secret and credential is real', () => {
    process.env = {
      NODE_ENV: 'production',
      SESSION_SECRET: strong('session'),
      SERVICE_TOKEN_SECRET: strong('service'),
      PAYMENT_WEBHOOK_SECRET: strong('webhook'),
      OBJECT_STORE_ACCESS_KEY: 'AKPRODEXAMPLE0001',
      OBJECT_STORE_SECRET_KEY: strong('store'),
      DATABASE_URL: 'postgres://db.internal:5432/jobwork',
    };
    expect(() => new ConfigService()).not.toThrow();
  });

  it('leaves development on its defaults', () => {
    process.env = { NODE_ENV: 'development', SESSION_SECRET: 'dev-only-change-me' };
    expect(new ConfigService().env.SERVICE_TOKEN_SECRET).toBe('dev-service-token-secret');
  });
});
