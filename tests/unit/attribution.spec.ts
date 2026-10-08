import { test, expect } from '@playwright/test';

import { reconcileWithEvidence } from '../../scripts/lib/attribution';

const ERROR = `Error: expect(locator).toHaveText(expected) failed

Locator: locator('.todo-counter')
Expected: "1 item left"
Timeout: 2000ms
Error: element(s) not found`;

const blamedProduct = {
  category: 'Locator / UI',
  rootCause: 'The counter is missing.',
  whyItHappened: 'The app did not render it.',
  isLikelyTestDefect: false,
  isLikelyProductDefect: true,
};

const evidence = (domElements: string[], extra = {}) => ({
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  steps: [],
  domElements,
  ...extra,
});

test.describe('evidence cross-check', () => {
  test('expected text present under another element: the locator is wrong', () => {
    const result = reconcileWithEvidence(blamedProduct, {
      error: ERROR,
      evidence: evidence(['footer.footer text "1 item leftAll"', 'span.todo-count[data-testid="todo-count"] text "1 item left"']),
    });

    expect(result).toMatchObject({ isLikelyTestDefect: true, isLikelyProductDefect: false });
    // The exact match is named, not the container that includes it.
    expect(result.rootCause).toContain('span.todo-count[data-testid="todo-count"]');
  });

  test('expected text absent: a missing element may be a real regression, so nothing changes', () => {
    expect(reconcileWithEvidence(blamedProduct, { error: ERROR, evidence: evidence(['h1 "todos"']) })).toBe(blamedProduct);
  });

  test('the page failing on its own keeps the product verdict', () => {
    const withErrors = evidence(['span.todo-count "1 item left"'], { pageErrors: ['TypeError: x is undefined'] });
    const with500 = evidence(['span.todo-count "1 item left"'], { failedRequests: [{ method: 'GET', url: 'u', status: 503 }] });

    expect(reconcileWithEvidence(blamedProduct, { error: ERROR, evidence: withErrors })).toBe(blamedProduct);
    expect(reconcileWithEvidence(blamedProduct, { error: ERROR, evidence: with500 })).toBe(blamedProduct);
  });

  test('a value mismatch is not a missing element', () => {
    const mismatch = ERROR.replace('Error: element(s) not found', '- unexpected value "2 items left"');

    expect(reconcileWithEvidence(blamedProduct, { error: mismatch, evidence: evidence(['span "1 item left"']) })).toBe(blamedProduct);
  });

  test('without DOM evidence nothing is assumed', () => {
    expect(reconcileWithEvidence(blamedProduct, { error: ERROR })).toBe(blamedProduct);
  });
});
