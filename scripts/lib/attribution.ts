/**
 * Attribution cross-checks: evidence the code can verify, applied on top
 * of whatever a model (or the deterministic analyzer) concluded.
 */

import type { FailureEvidence } from './failure-evidence';

export interface Attribution {
  category: string;
  rootCause: string;
  whyItHappened: string;
  isLikelyTestDefect: boolean;
  isLikelyProductDefect: boolean;
}

/**
 * "Element not found" is ambiguous on its own: a wrong locator (test
 * defect) or a missing element (product regression). The page settles
 * it. If the text the test expected is on the page, in some other
 * element, and the page shows no failure of its own, the element exists
 * and the locator is wrong — whatever a model concluded. Applied to AI
 * and deterministic analyses alike, because a 7B model gets this wrong
 * often enough to block repair of exactly the defects it can fix.
 */
export function reconcileWithEvidence<T extends Attribution>(
  analysis: T,
  failure: { error?: unknown; evidence?: FailureEvidence }
): T {
  const error = String(failure.error ?? '');
  const evidence: FailureEvidence | undefined = failure.evidence;

  if (
    !/element\(s\) not found|element not found/i.test(error) ||
    /unexpected value/i.test(error) ||
    !evidence?.domElements?.length ||
    evidence.pageErrors.length > 0 ||
    evidence.failedRequests.some((request) => request.status >= 500)
  ) {
    return analysis;
  }

  const expected = error.match(/Expected(?: string| substring)?:\s*"([^"\n]{2,200})"/)?.[1];

  if (!expected) {
    return analysis;
  }

  const normalized = expected.replace(/\s+/g, ' ').trim().toLowerCase();
  const textOf = (line: string) => line.match(/"([^"]*)"$/)?.[1]?.replace(/\s+/g, ' ').trim().toLowerCase();

  // An element whose own text is exactly the expected text names the
  // right element; a container that merely includes it does not.
  const exact = evidence.domElements.find((line) => textOf(line) === normalized);
  const containing = evidence.domElements.find((line) => textOf(line)?.includes(normalized));
  const match = exact ?? containing;

  if (!match) {
    return analysis;
  }

  const note =
    `The expected text "${expected}" is on the page (${match}), so the element exists ` +
    'and the locator is wrong; the page showed no errors of its own.';

  return {
    ...analysis,
    category: 'Locator / UI',
    isLikelyTestDefect: true,
    isLikelyProductDefect: false,
    rootCause: analysis.isLikelyTestDefect ? analysis.rootCause : `${note} ${analysis.rootCause}`,
    whyItHappened: analysis.isLikelyTestDefect
      ? analysis.whyItHappened
      : `${analysis.whyItHappened} Overridden by page evidence: ${note}`,
  };
}

