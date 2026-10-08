import { test, expect } from '@playwright/test';

import {
  applyEdits,
  changesExpectation,
  checkGuardrails,
  isTautological,
  parseRepairProposal,
  unifiedDiff,
} from '../../scripts/lib/remediation';

const ORIGINAL = `import { test, expect } from '@playwright/test';

test('counter after adding one todo', async ({ page }) => {
  await page.goto('https://demo.playwright.dev/todomvc');
  await page.getByPlaceholder('What needs to be done?').fill('buy milk');
  await page.keyboard.press('Enter');
  await expect(page.locator('.todo-counter')).toHaveText('1 item left');
});
`;

const patch = (find: string, replace: string) => {
  const result = applyEdits(ORIGINAL, [{ find, replace }]);

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.source;
};

test.describe('applying edits', () => {
  test('replaces exactly one occurrence', () => {
    const result = applyEdits(ORIGINAL, [
      { find: "page.locator('.todo-counter')", replace: "page.getByTestId('todo-count')" },
    ]);

    expect(result.ok && result.source).toContain("getByTestId('todo-count')");
  });

  test('refuses text that is not in the file, rather than guessing', () => {
    const result = applyEdits(ORIGINAL, [{ find: 'page.locator(".nope")', replace: 'x' }]);

    expect(result.ok).toBe(false);
  });

  test('refuses an ambiguous edit that matches more than once', () => {
    const result = applyEdits(ORIGINAL, [{ find: 'await ', replace: 'await  ' }]);

    expect(!result.ok && result.error).toMatch(/occurs 4 time/);
  });

  test('inserts replacement text literally, including $ patterns', () => {
    const result = applyEdits(ORIGINAL, [{ find: "'1 item left'", replace: "'$& cost'" }]);

    expect(result.ok && result.source).toContain("'$& cost'");
  });

  test('a no-op or oversized proposal is refused', () => {
    expect(applyEdits(ORIGINAL, []).ok).toBe(false);
    expect(applyEdits(ORIGINAL, [{ find: 'buy milk', replace: 'buy milk' }]).ok).toBe(false);
    expect(
      applyEdits(ORIGINAL, Array.from({ length: 6 }, () => ({ find: 'a', replace: 'b' }))).ok
    ).toBe(false);
  });
});

test.describe('guardrails', () => {
  test('a locator repair passes', () => {
    expect(
      checkGuardrails(ORIGINAL, patch("page.locator('.todo-counter')", "page.getByTestId('todo-count')"))
    ).toEqual([]);
  });

  const refused: [string, string, string, RegExp][] = [
    ['removing the assertion', "  await expect(page.locator('.todo-counter')).toHaveText('1 item left');\n", '', /Removes assertions/],
    ['commenting it out', "  await expect(", '  // await expect(', /Removes assertions/],
    ['skipping the test', "test('counter", "test.skip('counter", /skips or disables/],
    ['focusing with .only', "test('counter", "test.only('counter", /\.only/],
    ['wrapping in try', "  await expect(page.locator('.todo-counter'))", "  try { await expect(page.locator('.todo-counter'))", /catches errors/],
    ['a soft assertion', "await expect(page.locator", "await expect.soft(page.locator", /soft assertion/],
    ['negating the assertion', ').toHaveText(', ').not.toHaveText(', /negates/],
    ['forcing an action', "press('Enter')", "press('Enter', { force: true })", /forces/],
    ['a fixed wait', "  await page.keyboard.press('Enter');", "  await page.keyboard.press('Enter');\n  await page.waitForTimeout(3000);", /fixed wait/],
    ['downgrading to a presence check', ".toHaveText('1 item left')", '.toBeVisible()', /weaker one/],
  ];

  for (const [name, find, replace, reason] of refused) {
    test(`refuses ${name}`, () => {
      expect(checkGuardrails(ORIGINAL, patch(find, replace)).join(' ')).toMatch(reason);
    });
  }

  test('refuses an assertion on an element found by the text it checks', () => {
    const problems = checkGuardrails(
      ORIGINAL,
      patch("page.locator('.todo-counter')", "page.getByText('1 item left')")
    );

    expect(problems.join(' ')).toMatch(/cannot fail/);
  });

  test('constructs the original already used are not held against the patch', () => {
    const withWait = ORIGINAL.replace(
      "press('Enter');",
      "press('Enter');\n  await page.waitForTimeout(500);"
    );

    const repaired = withWait.replace("page.locator('.todo-counter')", "page.getByTestId('todo-count')");

    expect(checkGuardrails(withWait, repaired)).toEqual([]);
  });
});

test.describe('tautology detection', () => {
  test('flags text-located elements asserted on the same text', () => {
    expect(isTautological(`await expect(page.getByText('Saved')).toHaveText('Saved')`)).toBe(true);
    expect(isTautological(`await expect(page.getByRole('heading', { name: "Todos" })).toContainText("Todos")`)).toBe(true);
    expect(isTautological(`await expect(page.locator('li', { hasText: 'a' })).toHaveText('a')`)).toBe(true);
  });

  test('a locator independent of the expected text is fine', () => {
    expect(isTautological(`await expect(page.getByTestId('count')).toHaveText('1 item left')`)).toBe(false);
    expect(isTautological(`await expect(page.getByText('Total')).toHaveText('Total: 5')`)).toBe(false);
  });
});

test.describe('expectation changes', () => {
  test('a new locator alone is not an expectation change', () => {
    expect(
      changesExpectation(ORIGINAL, patch("page.locator('.todo-counter')", "page.getByTestId('todo-count')"))
    ).toBe(false);
  });

  test('a new expected value needs human review', () => {
    expect(changesExpectation(ORIGINAL, patch("'1 item left'", "'2 items left'"))).toBe(true);
  });
});

test.describe('scenario protection', () => {
  const MOCKED = `test('shows an error banner when the API fails', async ({ page }) => {
  await page.route('**/api/todos', (route) => route.fulfill({ status: 500 }));
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('seen', '1'));
  await expect(page.getByRole('alert')).toHaveText('Could not load todos');
});
`;

  test('refuses changing a mocked response', () => {
    const patched = MOCKED.replace('status: 500', 'status: 200');

    expect(checkGuardrails(MOCKED, patched).join(' ')).toMatch(/simulates/);
  });

  test('refuses changing injected page state', () => {
    const patched = MOCKED.replace("setItem('seen', '1')", "setItem('seen', '0')");

    expect(checkGuardrails(MOCKED, patched).join(' ')).toMatch(/simulates/);
  });

  test('a locator repair in a mocked test is still allowed', () => {
    const patched = MOCKED.replace("getByRole('alert')", "getByTestId('error-banner')");

    expect(checkGuardrails(MOCKED, patched)).toEqual([]);
  });
});

test.describe('expectation changes elsewhere in the file', () => {
  test('an identical matcher in another test does not hide a changed value', () => {
    const file = `test('a', async ({ page }) => {
  await expect(page.getByTestId('count')).toHaveText('1 item left');
});

test('b', async ({ page }) => {
  await expect(page.getByTestId('count')).toHaveText('5 items left');
});
`;

    const patched = file.replace("'5 items left'", "'1 item left'");

    expect(changesExpectation(file, patched)).toBe(true);
  });
});

test.describe('repair proposals', () => {
  test('a proposal with no usable edits cannot repair', () => {
    expect(
      parseRepairProposal(JSON.stringify({ canRepair: true, summary: 'x', edits: [{ find: '', replace: 'y' }] }))
        .canRepair
    ).toBe(false);
  });

  test('a refusal is preserved with its reason', () => {
    const proposal = parseRepairProposal(
      JSON.stringify({ canRepair: false, summary: 'The API returned 500.', edits: [] })
    );

    expect(proposal).toEqual({ canRepair: false, summary: 'The API returned 500.', edits: [] });
  });

  test('non-JSON is rejected', () => {
    expect(() => parseRepairProposal('sure, here is a fix')).toThrow(/not valid JSON/);
  });
});

test.describe('unified diff', () => {
  test('removals come before additions, with context', () => {
    const diff = unifiedDiff(
      ORIGINAL,
      patch("page.locator('.todo-counter')", "page.getByTestId('todo-count')"),
      'tests/e2e/todo.spec.ts'
    );

    const lines = diff.split('\n');
    const removal = lines.findIndex((line) => line.startsWith("-  await expect(page.locator"));
    const addition = lines.findIndex((line) => line.startsWith("+  await expect(page.getByTestId"));

    expect(lines[0]).toBe('--- a/tests/e2e/todo.spec.ts');
    expect(lines[1]).toBe('+++ b/tests/e2e/todo.spec.ts');
    expect(lines[2]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    expect(removal).toBeGreaterThan(2);
    expect(addition).toBe(removal + 1);
  });
});
