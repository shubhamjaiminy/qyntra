import { test, expect } from '@playwright/test';

import {
  buildUploadPayload,
  pullRequestFromEnv,
  scrubUrls,
  type UploadInputs,
  type UploadLevel,
} from '../../scripts/lib/cloud-upload';
import { resolveCloudConfig } from '../../scripts/lib/config';

const COMMIT = 'f'.repeat(40);

/**
 * Artifacts carrying everything a real run can hold, including the
 * things no upload level may contain.
 */
function inputs(level: UploadLevel): UploadInputs {
  return {
    level,
    project: 'acme-billing',
    qyntraVersion: '0.1.0',
    provider: 'gemini (gemini-3.5-flash)',
    pullRequest: 42,

    decision: {
      generatedAt: '2026-10-09T05:00:00.000Z',
      application: 'Acme Secret Billing',
      verdict: 'UNSAFE',
      qualityScore: 55,
      decisionConfidence: 'Medium',
      blockingReasons: [
        'Checkout With Saved Card failed at https://staging.acme.example/checkout?card=4242 — product defect',
      ],
      warnings: ['GET /api/invoices regressed at https://staging.acme.example/api/invoices'],
      scoreBreakdown: [],
      failureHistory: [],
      evidence: {
        execution: { total: 3, passed: 1, failed: 2, skipped: 0 },
        passRate: 33,
        risk: { level: 'HIGH', score: 8 },
        failuresBySeverity: { Critical: 1, High: 1, Medium: 0, Low: 0 },
        productDefects: 1,
        testDefects: 1,
        unattributedFailures: 0,
        aiAnalysisAvailable: true,
        newRegressions: 1,
        knownFlakyFailures: 0,
        chronicFailures: 0,
        historyAvailable: true,
        runsCompared: 10,
      },
    } as unknown as UploadInputs['decision'],

    run: {
      runId: 'r1',
      timestamp: '2026-10-09T05:00:00.000Z',
      git: { commit: COMMIT, branch: 'feature/secret-launch' },
      execution: { total: 3, passed: 1, failed: 2, skipped: 0 },
      verdict: 'UNSAFE',
      qualityScore: 55,
      risk: { level: 'HIGH', score: 8 },
      tests: [],
    },

    failures: {
      summary: { durationSeconds: '12.5' },
      tests: [
        { test: 'Checkout With Saved Card', status: 'failed' },
        { test: 'Invoice List Loads', status: 'failed' },
        { test: 'Login Works', status: 'passed' },
      ],
    },

    analysis: {
      analyses: [
        {
          test: 'Checkout With Saved Card',
          category: 'Functional / Assertion',
          severity: 'Critical',
          rootCause: 'Total shows $0 after applying coupon',
          stackTrace: 'Error: expected 100 got 0 at https://staging.acme.example/cart?token=abc password=hunter2',
          isLikelyProductDefect: true,
          // Fields the upload must never carry, at any level.
          testSource: 'const CUSTOMER_SOURCE_MARKER = 1;',
          evidence: { screenshot: 'SCREENSHOT_MARKER', dom: 'DOM_MARKER' },
        } as never,
        {
          test: 'Invoice List Loads',
          category: 'Locator / UI',
          severity: 'High',
          rootCause: 'Selector #invoices renamed',
          stackTrace: 'Locator #invoices not found',
          isLikelyTestDefect: true,
        },
      ],
    },

    remediation: {
      repairs: [
        {
          test: 'Invoice List Loads',
          status: 'verified',
          summary: 'Use the new data-testid',
          diff: '-  #invoices\n+  [data-testid="invoices"]',
          attempts: 1,
          attemptLog: [],
          reviewRequired: false,
        },
        {
          test: 'Checkout With Saved Card',
          status: 'declined',
          summary: 'Product defect; not a test problem',
          diff: 'REJECTED_DIFF_MARKER',
          attempts: 0,
          attemptLog: [],
        },
      ],
    },
  };
}

const NEVER_SENT = [
  'CUSTOMER_SOURCE_MARKER',
  'SCREENSHOT_MARKER',
  'DOM_MARKER',
  'REJECTED_DIFF_MARKER',
  'Acme Secret Billing',
  'hunter2',
  '/checkout',
  '?card=',
  '?token=',
  '/api/invoices regressed at https://staging.acme.example/api',
];

test.describe('cloud upload payload', () => {
  for (const level of ['metrics', 'standard', 'full'] as const) {
    test(`${level}: never contains source, evidence, app name, secrets or URL paths`, () => {
      const sent = JSON.stringify(buildUploadPayload(inputs(level)));

      for (const marker of NEVER_SENT) {
        expect(sent, marker).not.toContain(marker);
      }
    });
  }

  test('metrics holds counts only: no names, commits or text', () => {
    const payload = buildUploadPayload(inputs('metrics'));
    const sent = JSON.stringify(payload);

    expect(payload.decision).toMatchObject({
      verdict: 'UNSAFE',
      qualityScore: 55,
      durationSeconds: 12.5,
      blockingReasonCount: 1,
      warningCount: 1,
      newRegressions: 1,
    });

    for (const text of ['Checkout', 'Invoice', COMMIT, 'secret-launch', 'staging.acme', 'coupon']) {
      expect(sent, text).not.toContain(text);
    }
    expect(payload.tests).toBeUndefined();
    expect(payload.source).toBeUndefined();
  });

  test('standard adds commit, branch, PR, tests and reasons — but no diagnosis text', () => {
    const payload = buildUploadPayload(inputs('standard'));

    expect(payload.source).toEqual({ commit: COMMIT, branch: 'feature/secret-launch', pullRequest: 42 });
    expect(payload.tests).toEqual([
      { name: 'Checkout With Saved Card', status: 'failed', category: 'Functional / Assertion', severity: 'Critical', productDefect: true, testDefect: false },
      { name: 'Invoice List Loads', status: 'failed', category: 'Locator / UI', severity: 'High', productDefect: false, testDefect: true },
      { name: 'Login Works', status: 'passed' },
    ]);
    expect(payload.reasons?.blocking[0]).toContain('https://staging.acme.example —');

    const sent = JSON.stringify(payload);
    expect(sent).not.toContain('coupon');
    expect(sent).not.toContain('renamed');
    expect(payload.diagnoses).toBeUndefined();
    expect(payload.repairs).toBeUndefined();
  });

  test('full adds redacted errors, diagnoses and only verified diffs', () => {
    const payload = buildUploadPayload(inputs('full'));

    expect(payload.diagnoses?.[0]).toEqual({
      test: 'Checkout With Saved Card',
      error: 'Error: expected 100 got 0 at https://staging.acme.example password=***',
      rootCause: 'Total shows $0 after applying coupon',
    });
    expect(payload.repairs).toEqual([
      { test: 'Invoice List Loads', status: 'verified', summary: 'Use the new data-testid', diff: '-  #invoices\n+  [data-testid="invoices"]', reviewRequired: false, applied: false },
      { test: 'Checkout With Saved Card', status: 'declined', summary: 'Product defect; not a test problem', reviewRequired: false, applied: false },
    ]);
  });

  test('long error messages are truncated', () => {
    const base = inputs('full');
    base.analysis!.analyses![0].stackTrace = 'x'.repeat(2000);

    expect(buildUploadPayload(base).diagnoses?.[0].error.length).toBeLessThanOrEqual(501);
  });
});

test.describe('upload helpers', () => {
  test('URLs are reduced to their origin', () => {
    expect(scrubUrls('see https://a.example/x/y?z=1#f and http://b.example:8080/p.')).toBe(
      'see https://a.example and http://b.example:8080'
    );
  });

  test('PR number comes from GitHub or GitLab, and nothing else', () => {
    expect(pullRequestFromEnv({ GITHUB_REF: 'refs/pull/17/merge' })).toBe(17);
    expect(pullRequestFromEnv({ CI_MERGE_REQUEST_IID: '9' })).toBe(9);
    expect(pullRequestFromEnv({ GITHUB_REF: 'refs/heads/main' })).toBeUndefined();
    expect(pullRequestFromEnv({})).toBeUndefined();
  });
});

test.describe('cloud config', () => {
  test('defaults to standard, with no project: nothing is uploaded', () => {
    expect(resolveCloudConfig(undefined)).toEqual({ upload: 'standard', history: false });
  });

  test('rejects a token in the committed config file', () => {
    expect(() => resolveCloudConfig({ project: 'p', token: 'qy_live_x' })).toThrow(/"cloud.token" is not allowed/);
  });

  test('cloud.url must be https, except on this machine', () => {
    expect(resolveCloudConfig({ url: 'https://app.qyntra.dev/', project: 'p' })).toMatchObject({ url: 'https://app.qyntra.dev' });
    expect(resolveCloudConfig({ url: 'http://localhost:8080' })).toMatchObject({ url: 'http://localhost:8080' });
    expect(() => resolveCloudConfig({ url: 'http://cloud.example' })).toThrow(/must use https/);
  });

  test('rejects an unknown upload level', () => {
    expect(() => resolveCloudConfig({ upload: 'everything' })).toThrow(/metrics, standard, full/);
  });
});
