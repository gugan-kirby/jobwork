import { describe, expect, it } from 'vitest';
import { productionConfigProblems } from '../src/production-config';

const rules = {
  secrets: ['SESSION_SECRET', 'SERVICE_TOKEN_SECRET'],
  credentials: ['OBJECT_STORE_ACCESS_KEY'],
  replaced: { DATABASE_URL: 'postgres://localhost:5432/jobwork_dev' },
};
const strong = 'q7T2v9Lm4Xc8Rb1Nf6Hd3Ks0Wp5Yz2Ae';

describe('production configuration (F-12.3)', () => {
  it('lets development and test run on the public defaults', () => {
    expect(productionConfigProblems({ NODE_ENV: 'development', SESSION_SECRET: 'dev-only-change-me' }, rules)).toEqual([]);
    expect(productionConfigProblems({ NODE_ENV: 'test', SESSION_SECRET: 'test-secret-value' }, rules)).toEqual([]);
  });

  it('refuses every public, short or default value in production, naming each', () => {
    const problems = productionConfigProblems(
      { NODE_ENV: 'production', SESSION_SECRET: 'dev-only-change-me', SERVICE_TOKEN_SECRET: 'short-but-not-public', OBJECT_STORE_ACCESS_KEY: 'minioadmin', DATABASE_URL: 'postgres://localhost:5432/jobwork_dev' },
      rules,
    );
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toMatch(/SESSION_SECRET.*development value/);
    expect(problems.join('\n')).toMatch(/SERVICE_TOKEN_SECRET.*shorter than 32/);
    expect(problems.join('\n')).toMatch(/OBJECT_STORE_ACCESS_KEY/);
    expect(problems.join('\n')).toMatch(/DATABASE_URL/);
  });

  it('accepts a production configuration with real values', () => {
    expect(
      productionConfigProblems(
        { NODE_ENV: 'production', SESSION_SECRET: strong, SERVICE_TOKEN_SECRET: strong.split('').reverse().join(''), OBJECT_STORE_ACCESS_KEY: 'AKPRODEXAMPLE0001', DATABASE_URL: 'postgres://db.internal:5432/jobwork' },
        rules,
      ),
    ).toEqual([]);
  });
});
