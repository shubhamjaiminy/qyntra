/**
 * Remediation: turn a diagnosed test defect into a verified patch.
 *
 * The pure half of the repair loop — applying proposed edits, refusing
 * patches that cheat, and rendering the diff. The other half (asking
 * the model, re-running the test, restoring the file) lives in
 * scripts/repair.ts.
 *
 * The guardrails exist because "make the failing test pass" has trivial
 * wrong answers: delete the assertion, skip the test, swallow the error.
 * Each of those would turn a red test green while hiding whatever it
 * caught, which is worse than leaving it red. A repair may change how a
 * test finds things; it may not change whether the test can fail.
 */

export interface RepairEdit {
  /** Exact text currently in the file. Must occur exactly once. */
  find: string;
  replace: string;
}

export interface RepairProposal {
  /** False when the model judges this is not a test defect. */
  canRepair: boolean;
  /** One sentence: what was wrong with the test and what changed. */
  summary: string;
  edits: RepairEdit[];
}

export type ApplyResult =
  | { ok: true; source: string }
  | { ok: false; error: string };

/**
 * JSON Schema for a repair response, enforced by providers that
 * support constrained decoding.
 */
export const REPAIR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    canRepair: { type: 'boolean' },
    summary: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          find: { type: 'string' },
          replace: { type: 'string' },
        },
        required: ['find', 'replace'],
      },
    },
  },
  required: ['canRepair', 'summary', 'edits'],
} as const;

/** Upper bound on a "minimal" repair; more is a rewrite, not a fix. */
const MAX_EDITS = 5;

export function parseRepairProposal(
  text: string | undefined | null
): RepairProposal {
  if (!text) {
    throw new Error('Repair response was empty.');
  }

  let parsed: any;

  try {
    parsed = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    );
  } catch {
    throw new Error('Repair response was not valid JSON.');
  }

  const edits: RepairEdit[] = Array.isArray(parsed?.edits)
    ? parsed.edits
        .filter(
          (edit: any) =>
            typeof edit?.find === 'string' &&
            typeof edit?.replace === 'string' &&
            edit.find !== ''
        )
        .map((edit: any) => ({ find: edit.find, replace: edit.replace }))
    : [];

  return {
    canRepair: parsed?.canRepair === true && edits.length > 0,
    summary: String(parsed?.summary ?? '').trim(),
    edits,
  };
}

/**
 * Apply edits in order. Each `find` must match exactly once in the
 * current text: zero matches means the model invented code, more than
 * one means the edit is ambiguous. Either way nothing is guessed.
 */
export function applyEdits(
  source: string,
  edits: RepairEdit[]
): ApplyResult {
  if (edits.length === 0) {
    return { ok: false, error: 'The proposal contained no edits.' };
  }

  if (edits.length > MAX_EDITS) {
    return {
      ok: false,
      error: `The proposal has ${edits.length} edits; a repair is at most ${MAX_EDITS}.`,
    };
  }

  let result = source;

  for (const [index, edit] of edits.entries()) {
    const occurrences = countOccurrences(result, edit.find);

    if (occurrences !== 1) {
      return {
        ok: false,
        error:
          `Edit ${index + 1}: the text to replace occurs ${occurrences} ` +
          `time(s) in the file; it must occur exactly once.`,
      };
    }

    // A function replacement, so `$&` and friends in the new code are
    // inserted literally rather than as replacement patterns.
    result = result.replace(edit.find, () => edit.replace);
  }

  if (result === source) {
    return { ok: false, error: 'The edits do not change the file.' };
  }

  return { ok: true, source: result };
}

/**
 * Matchers that check a value, as opposed to mere presence. Losing one
 * means the test checks less than it did.
 */
const VALUE_MATCHER =
  /\.to(HaveText|ContainText|HaveValue|HaveValues|HaveCount|HaveAttribute|HaveClass|HaveCSS|HaveURL|HaveTitle|HaveId|HaveJSProperty|HaveAccessibleName|HaveAccessibleDescription|HaveScreenshot|MatchAriaSnapshot|Be|Equal|StrictEqual|Contain|ContainEqual|Match|MatchObject|HaveLength|HaveProperty|BeChecked|BeGreaterThan|BeGreaterThanOrEqual|BeLessThan|BeLessThanOrEqual|BeCloseTo)\s*\(/g;

interface Guardrail {
  /** Why a patch introducing this is refused. */
  reason: string;
  pattern: RegExp;
}

/**
 * Constructs a repair may not introduce. Counted, not just detected, so
 * a test that already used one legitimately can keep it.
 */
const FORBIDDEN: Guardrail[] = [
  {
    reason: 'skips or disables a test',
    pattern: /\btest\s*\.\s*(skip|fixme|fail)\b|\b(it|describe)\s*\.\s*skip\b/g,
  },
  {
    reason: 'focuses a test with .only, hiding the rest of the suite',
    pattern: /\.\s*only\s*\(/g,
  },
  {
    reason: 'catches errors, which can swallow the assertion failure',
    pattern: /\btry\s*\{|\.catch\s*\(/g,
  },
  {
    reason: 'uses a soft assertion, which cannot fail the test on its own',
    pattern: /\bexpect\s*\.\s*soft\b/g,
  },
  {
    reason: 'negates an assertion, inverting what the test checks',
    pattern: /\)\s*\.\s*not\s*\./g,
  },
  {
    reason: 'forces an action past actionability checks, hiding real UI bugs',
    pattern: /\bforce\s*:\s*true\b/g,
  },
  {
    reason: 'adds a fixed wait, which hides timing bugs instead of fixing them',
    pattern: /\bwaitForTimeout\s*\(/g,
  },
];

/**
 * Reasons this patch is refused. Empty means it may be verified.
 */
export function checkGuardrails(
  original: string,
  patched: string
): string[] {
  const problems: string[] = [];

  const originalCode = stripComments(original);
  const patchedCode = stripComments(patched);

  const assertionsBefore = countMatches(originalCode, /\bexpect\s*\(/g);
  const assertionsAfter = countMatches(patchedCode, /\bexpect\s*\(/g);

  if (assertionsAfter < assertionsBefore) {
    problems.push(
      `Removes assertions (${assertionsBefore} before, ${assertionsAfter} after).`
    );
  }

  const testsBefore = countMatches(originalCode, /\btest\s*\(/g);
  const testsAfter = countMatches(patchedCode, /\btest\s*\(/g);

  if (testsAfter < testsBefore) {
    problems.push(
      `Removes tests (${testsBefore} before, ${testsAfter} after).`
    );
  }

  // Swapping toHaveText('5 items left') for toBeVisible() keeps the
  // assertion count but stops checking the value: the test now passes
  // for any page that shows *something*. Presence checks may be added,
  // but never at the expense of value checks.
  const valueChecksBefore = countMatches(originalCode, VALUE_MATCHER);
  const valueChecksAfter = countMatches(patchedCode, VALUE_MATCHER);

  if (valueChecksAfter < valueChecksBefore) {
    problems.push(
      'Replaces a value assertion (e.g. toHaveText) with a weaker one ' +
        `(${valueChecksBefore} value checks before, ${valueChecksAfter} after).`
    );
  }

  // expect(page.getByText('1 item left')).toHaveText('1 item left')
  // passes whenever that text is anywhere on the page: the locator
  // already guarantees the assertion. Only new lines are checked, so an
  // original test written this way is not the patch's fault.
  const originalLines = new Set(
    originalCode.split('\n').map((line) => line.trim())
  );

  for (const line of patchedCode.split('\n')) {
    if (!originalLines.has(line.trim()) && isTautological(line)) {
      problems.push(
        'Asserts on an element located by the very text it checks, ' +
          'so the assertion cannot fail.'
      );
      break;
    }
  }

  for (const guardrail of FORBIDDEN) {
    const before = countMatches(originalCode, guardrail.pattern);
    const after = countMatches(patchedCode, guardrail.pattern);

    if (after > before) {
      problems.push(`Patch ${guardrail.reason}.`);
    }
  }

  return problems;
}

/**
 * True when an assertion line was changed. A new locator is a test
 * repair; a new expected value is a claim about correct behaviour that
 * a person has to confirm — the model may simply be agreeing with a
 * bug.
 */
export function changesExpectation(
  original: string,
  patched: string
): boolean {
  // Compare matcher calls only — `.toHaveText('1 item left')` — so a
  // new locator on the same line is not mistaken for a new expectation.
  const matchers = (source: string) =>
    new Set(
      [...stripComments(source).matchAll(/\.(?:not\s*\.\s*)?to[A-Z]\w*\s*\([^\n]*/g)].map(
        (match) => match[0].replace(/\s+/g, ' ').trim()
      )
    );

  const before = matchers(original);

  for (const matcher of matchers(patched)) {
    if (!before.has(matcher)) {
      return true;
    }
  }

  return false;
}

/**
 * Unified diff of two versions of one file, with three lines of
 * context. Small and dependency-free: spec files are short, so an
 * O(n·m) LCS is fine.
 */
export function unifiedDiff(
  original: string,
  patched: string,
  filePath: string
): string {
  const a = original.split('\n');
  const b = patched.split('\n');

  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  type Op = { kind: ' ' | '-' | '+'; line: string; aLine: number; bLine: number };

  const ops: Op[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i], aLine: i, bLine: j });
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // Removals before additions, the order git and review tools use.
      ops.push({ kind: '-', line: a[i], aLine: i, bLine: j });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j], aLine: i, bLine: j });
      j++;
    }
  }

  const CONTEXT = 3;
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];

  let index = 0;

  while (index < ops.length) {
    if (ops[index].kind === ' ') {
      index++;
      continue;
    }

    // Grow a hunk until there is a run of more than 2×CONTEXT
    // unchanged lines, then emit it with CONTEXT lines either side.
    const start = Math.max(0, index - CONTEXT);
    let end = index;
    let unchangedRun = 0;

    while (end < ops.length && unchangedRun <= CONTEXT * 2) {
      unchangedRun = ops[end].kind === ' ' ? unchangedRun + 1 : 0;
      end++;
    }

    end = Math.min(ops.length, end - Math.max(0, unchangedRun - CONTEXT));

    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((op) => op.kind !== '+').length;
    const bCount = hunk.filter((op) => op.kind !== '-').length;

    lines.push(
      `@@ -${hunk[0].aLine + 1},${aCount} +${hunk[0].bLine + 1},${bCount} @@`
    );

    for (const op of hunk) {
      lines.push(`${op.kind}${op.line}`);
    }

    index = end;
  }

  return lines.join('\n') + '\n';
}

/**
 * True for an assertion whose expected text is also how the element
 * was found: getByText('X') / hasText: 'X' / text=X, then
 * toHaveText('X') or toContainText('X').
 */
export function isTautological(line: string): boolean {
  const expected = line.match(
    /\.to(?:HaveText|ContainText)\s*\(\s*(['"`])(.*?)\1/
  );

  if (!expected) {
    return false;
  }

  const text = expected[2];
  const quoted = (value: string) =>
    [`'${value}'`, `"${value}"`, `\`${value}\``];

  const locatorPart = line.slice(0, expected.index);

  return (
    quoted(text).some(
      (literal) =>
        locatorPart.includes(`getByText(${literal}`) ||
        locatorPart.includes(`hasText: ${literal}`) ||
        locatorPart.includes(`name: ${literal}`)
    ) ||
    locatorPart.includes(`text=${text}`)
  );
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;

  while ((from = haystack.indexOf(needle, from)) !== -1) {
    count++;
    from += needle.length;
  }

  return count;
}

function countMatches(source: string, pattern: RegExp): number {
  return source.match(new RegExp(pattern.source, 'g'))?.length ?? 0;
}

/**
 * Drop comments so a model cannot satisfy the assertion count by
 * leaving `// expect(...)` behind, and so commented-out code in the
 * original does not count either.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}
