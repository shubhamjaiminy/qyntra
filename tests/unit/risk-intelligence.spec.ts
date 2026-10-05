import { test, expect } from '@playwright/test';

import {
  assessRisk,
  profileSurface,
  type DiscoveredSurface,
} from '../../scripts/lib/risk-intelligence';

// --------------------------------------------------
// FIXTURES
// --------------------------------------------------

/** A read-only marketing page: no mutation, no auth, no money. */
const readOnlyApp: DiscoveredSurface = {
  application: { title: 'Docs', url: 'https://example.com/docs' },
  inputs: [],
  buttons: [{ text: 'Read more', selector: 'a.more' }],
  capabilities: [],
  network: { apiEndpoints: [] },
  metadata: { forms: 0, authenticationIndicators: [], paymentIndicators: [] },
};

/** A checkout flow, observed. */
const paymentApp: DiscoveredSurface = {
  application: { title: 'Shop', url: 'https://example.com/checkout' },
  inputs: [
    { type: 'text', purpose: 'AMOUNT_INPUT', selector: '#amount' },
    { type: 'password', purpose: 'PASSWORD_INPUT', selector: '#password' },
  ],
  buttons: [
    { text: 'Pay now', selector: 'button.pay' },
    { text: 'Delete card', selector: 'button.remove-card' },
  ],
  capabilities: [
    { name: 'Payment', confidence: 'high', evidence: 'Pay button found' },
    { name: 'Authentication', confidence: 'high', evidence: 'Password field' },
  ],
  dynamicDiscovery: { enabled: true, actions: [] },
  network: {
    apiEndpoints: [
      '/api/cart',
      '/api/pay',
      '/api/user',
      '/api/tax',
      '/api/ship',
      '/api/audit',
    ],
  },
  metadata: {
    forms: 3,
    authenticationIndicators: ['password field at /login'],
    paymentIndicators: ['card number field', 'Pay now button'],
  },
};

/** A simple CRUD list app. */
const crudApp: DiscoveredSurface = {
  application: { title: 'Tasks', url: 'https://example.com' },
  inputs: [{ type: 'text', purpose: 'CREATE_TODO', selector: '#new' }],
  buttons: [],
  capabilities: [
    { name: 'Create Todo', confidence: 'high', evidence: 'Input found' },
  ],
  todoStructure: { detected: true, delete: 'button.destroy' },
  dynamicDiscovery: { enabled: true, actions: [] },
  network: { apiEndpoints: [] },
  metadata: { forms: 1, authenticationIndicators: [], paymentIndicators: [] },
};

// --------------------------------------------------
// SURFACE PROFILING
// --------------------------------------------------

test.describe('surface profiling', () => {
  test('detects payments and credentials from observed indicators', () => {
    const profile = profileSurface(paymentApp);

    expect(profile.handlesPayments).toBe(true);
    expect(profile.handlesCredentials).toBe(true);
    expect(profile.requiresAuthentication).toBe(true);
    expect(profile.apiEndpoints).toBe(6);
    expect(profile.forms).toBe(3);
  });

  test('detects credentials from a password input alone', () => {
    // No metadata.authenticationIndicators — a real app whose login page
    // discovery reached without the indicator heuristic firing.
    const profile = profileSurface({
      inputs: [{ type: 'password', selector: '#pw' }],
      metadata: { authenticationIndicators: [] },
    });

    expect(profile.handlesCredentials).toBe(true);
  });

  test('counts destructive controls from discovered UI', () => {
    const profile = profileSurface(paymentApp);

    // "Delete card" button plus nothing else destructive.
    expect(profile.destructiveActions).toBeGreaterThan(0);
  });

  test('a read-only surface profiles as harmless', () => {
    const profile = profileSurface(readOnlyApp);

    expect(profile.handlesPayments).toBe(false);
    expect(profile.handlesCredentials).toBe(false);
    expect(profile.destructiveActions).toBe(0);
    expect(profile.mutations).toBe(0);
  });

  test('an absent map profiles as empty rather than throwing', () => {
    const profile = profileSurface(undefined);

    expect(profile.handlesPayments).toBe(false);
    expect(profile.apiEndpoints).toBe(0);
  });
});

// --------------------------------------------------
// RATING
// --------------------------------------------------

test.describe('risk rating', () => {
  test('an observed payment surface rates CRITICAL', () => {
    const assessment = assessRisk(
      'User can complete a checkout',
      paymentApp
    );

    expect(assessment.riskLevel).toBe('CRITICAL');
    expect(assessment.derivedFrom).toBe('application-map');
    expect(assessment.confidence).toBe('High');
  });

  test('a read-only surface rates LOW regardless of wording', () => {
    // This is the exact failure of the old keyword matcher: a cosmetic
    // change whose description happens to contain "payment" was rated
    // CRITICAL with a score of 9.
    const assessment = assessRisk(
      'Remove the payment reminder tooltip from the docs page',
      readOnlyApp
    );

    expect(assessment.riskLevel).not.toBe('CRITICAL');
    expect(assessment.riskScore).toBeLessThan(3.5);
    expect(assessment.derivedFrom).toBe('application-map');
  });

  test('requirement wording alone can never reach CRITICAL', () => {
    // No map at all. Wording is not evidence, so the rating is capped
    // below CRITICAL however alarming the words are.
    const assessment = assessRisk(
      'Process a bank payment transaction with authorization and refund',
      undefined
    );

    expect(assessment.riskLevel).not.toBe('CRITICAL');
    expect(assessment.derivedFrom).toBe('requirement-text');
    expect(assessment.confidence).toBe('Low');
  });

  test('a missing map is reported, not silently rated as safe', () => {
    const assessment = assessRisk('Anything at all', undefined);

    expect(assessment.derivedFrom).toBe('requirement-text');
    expect(assessment.reasoning).toContain('no usable application surface');
    // Actionable: tells the customer how to get a real rating.
    expect(assessment.reasoning).toContain('app.auth');
  });

  test('a map from a page that failed to load counts as no evidence', () => {
    const assessment = assessRisk('User can pay', {
      application: { title: 'Error', url: 'https://example.com' },
      inputs: [],
      buttons: [],
      capabilities: [],
      network: { apiEndpoints: [] },
      metadata: { forms: 0 },
    });

    expect(assessment.derivedFrom).toBe('requirement-text');
  });

  test('a riskier observed surface always outranks a tamer one', () => {
    const risky = assessRisk('User can do the thing', paymentApp);
    const tame = assessRisk('User can do the thing', crudApp);

    expect(risky.riskScore).toBeGreaterThan(tame.riskScore);
  });

  test('every factor is itemised and the score is the sum', () => {
    const assessment = assessRisk('User can check out', paymentApp);

    expect(assessment.factors.length).toBeGreaterThan(0);

    const sum = assessment.factors.reduce(
      (total, factor) => total + factor.points,
      0
    );

    // Score is min(sum, ceiling); with this fixture the sum exceeds 10.
    expect(assessment.riskScore).toBe(Math.min(sum, 10));

    for (const factor of assessment.factors) {
      expect(factor.reason.length).toBeGreaterThan(0);
      expect(['discovered', 'requirement']).toContain(factor.source);
    }
  });

  test('discovered factors carry the evidence behind them', () => {
    const assessment = assessRisk('User can check out', paymentApp);

    const payments = assessment.factors.find((factor) =>
      factor.reason.includes('payments')
    );

    expect(payments?.source).toBe('discovered');
    expect(payments?.evidence).toContain('card number field');
  });

  test('wording contributes, but is capped so it cannot dominate', () => {
    const withWording = assessRisk(
      'Refund a payment transaction for a bank order',
      crudApp
    );

    const withoutWording = assessRisk('Change a label', crudApp);

    const delta = withWording.riskScore - withoutWording.riskScore;

    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(3);
  });
});

// --------------------------------------------------
// SCENARIOS
// --------------------------------------------------

test.describe('scenario derivation', () => {
  test('payment scenarios appear only when a payment surface exists', () => {
    const fromEvidence = assessRisk('Ship it', paymentApp);
    const fromNothing = assessRisk('Ship it', readOnlyApp);

    expect(
      fromEvidence.scenarios.some((scenario) =>
        /payment/i.test(scenario.name)
      )
    ).toBe(true);

    expect(
      fromNothing.scenarios.some((scenario) =>
        /payment/i.test(scenario.name)
      )
    ).toBe(false);
  });

  test('duplicate-charge coverage is generated for payment surfaces', () => {
    // The highest-cost payment defect, so it must not be left to chance.
    const assessment = assessRisk('Checkout', paymentApp);

    expect(
      assessment.scenarios.some((scenario) =>
        /duplicate/i.test(scenario.name)
      )
    ).toBe(true);
  });

  test('delete coverage follows an observed destructive control', () => {
    const assessment = assessRisk('Manage tasks', crudApp);

    expect(
      assessment.scenarios.some((scenario) =>
        /delete/i.test(scenario.name)
      )
    ).toBe(true);
  });

  test('every scenario states why it exists', () => {
    const assessment = assessRisk('Checkout', paymentApp);

    for (const scenario of assessment.scenarios) {
      expect(scenario.rationale.length).toBeGreaterThan(0);
    }
  });

  test('a baseline set is emitted when nothing is observed', () => {
    const assessment = assessRisk('Do a thing', readOnlyApp);

    expect(assessment.scenarios.length).toBeGreaterThan(0);
  });
});
