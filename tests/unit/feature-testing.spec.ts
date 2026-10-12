import { test, expect } from '@playwright/test';

import { cleanBody, parseTests, type Finding } from '../../scripts/lib/feature-ai';
import { featureLabel, locatorCandidates, trimSnapshot, type FeatureObservation } from '../../scripts/lib/feature-explorer';
import { decideFeature, observedFindings, type TestOutcome } from '../../scripts/lib/feature-report';
import { assertionsOnly, fixtureSource, isInfrastructureError, isValueMismatch, specSource, statements, strictModeFix } from '../../scripts/lib/feature-tests';
import { isWriteRequest } from '../../scripts/lib/read-only-guard';

const gql = (query: string, extra: object = {}) => JSON.stringify({ query, ...extra });

test.describe('read-only guard', () => {
  test('reads pass: GET, HEAD, OPTIONS and GraphQL queries', () => {
    expect(isWriteRequest('GET', 'https://app.example/api/rules', null)).toBe(false);
    expect(isWriteRequest('HEAD', 'https://app.example/graphql', null)).toBe(false);
    expect(isWriteRequest('OPTIONS', 'https://app.example/graphql', null)).toBe(false);
    expect(isWriteRequest('POST', 'https://app.example/graphql', gql('query feeRules { feeRules { id } }'))).toBe(false);
    expect(isWriteRequest('POST', 'https://app.example/graphql', gql('{ me { id } }'))).toBe(false);
  });

  test('GraphQL mutations and subscriptions are writes, including in a batch', () => {
    expect(isWriteRequest('POST', 'https://app.example/graphql', gql('mutation deleteRule($id: ID!) { deleteRule(id: $id) }'))).toBe(true);
    expect(isWriteRequest('POST', 'https://app.example/graphql', gql('  # comment\n mutation { a }'))).toBe(true);
    expect(isWriteRequest('POST', 'https://app.example/graphql', gql('subscription { events { id } }'))).toBe(true);
    expect(
      isWriteRequest('POST', 'https://app.example/graphql', JSON.stringify([{ query: 'query { a }' }, { query: 'mutation { b }' }]))
    ).toBe(true);
  });

  test('a field or string that merely says "mutation" is still a read', () => {
    expect(isWriteRequest('POST', 'https://app.example/graphql', gql('query { user { subscription { id } mutation } }'))).toBe(false);
    expect(isWriteRequest('POST', 'https://app.example/graphql', gql('query { search(text: "mutation { x }") { id } }'))).toBe(false);
  });

  test('REST writes and unknown POST bodies are writes', () => {
    expect(isWriteRequest('POST', 'https://app.example/api/rules', '{"name":"x"}')).toBe(true);
    expect(isWriteRequest('PUT', 'https://app.example/api/rules/1', '{}')).toBe(true);
    expect(isWriteRequest('DELETE', 'https://app.example/api/rules/1', null)).toBe(true);
    expect(isWriteRequest('POST', 'https://app.example/graphql', JSON.stringify({ extensions: { persistedQuery: {} } }))).toBe(true);
    expect(isWriteRequest('POST', 'https://app.example/form', 'a=1&b=2')).toBe(true);
  });

  test('identity providers may refresh the session', () => {
    expect(isWriteRequest('POST', 'https://securetoken.googleapis.com/v1/token', 'grant_type=refresh_token')).toBe(false);
    expect(isWriteRequest('POST', 'https://acme.okta.com/oauth2/v1/token', 'x')).toBe(false);
    expect(isWriteRequest('POST', 'https://evil-okta.com/api', 'x')).toBe(true);
  });

  test('the generated fixture embeds a working copy of the guard', () => {
    const source = fixtureSource({ dir: '/tmp/x', featureUrl: 'https://app.example/f', readOnly: true });
    const embedded = /const isWriteRequest: [^=]+=> boolean = (function[\s\S]*?\n\});?\n\n\/\*\*/.exec(source)?.[1];

    expect(embedded).toBeTruthy();
    expect(source).not.toContain('__name');

    const guard = new Function(`return (${embedded})`)();
    expect(guard('POST', 'https://app.example/graphql', gql('mutation { a }'))).toBe(true);
    expect(guard('POST', 'https://app.example/graphql', gql('query { a }'))).toBe(false);
  });
});

test.describe('snapshot trimming', () => {
  const sidebar = Array.from({ length: 12 }, (_, index) => `  - listitem:\n    - link "Item ${index}":\n      - /url: /app/item-${index}`).join('\n');

  test('drops link-heavy menus and /url lines, keeps the feature', () => {
    const snapshot = `- list:\n${sidebar}\n- grid "Fee Rules":\n  - row "Rule Name Status"\n- link "Help":\n  - /url: /help`;
    const trimmed = trimSnapshot(snapshot);

    expect(trimmed).toContain('list (24 links omitted)');
    expect(trimmed).toContain('grid "Fee Rules"');
    expect(trimmed).toContain('link "Help"');
    expect(trimmed).not.toContain('Item 3');
    expect(trimmed).not.toContain('/url:');
  });

  test('keeps a navigation that holds a context selector', () => {
    const snapshot = '- navigation:\n  - combobox "Workspace": Acme West\n- heading "Fee Rules"';
    expect(trimSnapshot(snapshot)).toContain('combobox "Workspace"');
  });

  test('caps size and redacts credential-looking values', () => {
    const trimmed = trimSnapshot(`- text: token=abc123secret\n${'- text: x\n'.repeat(5_000)}`, 500);

    expect(trimmed.length).toBeLessThan(600);
    expect(trimmed).toContain('(truncated)');
    expect(trimmed).not.toContain('abc123secret');
  });
});

test.describe('AI test parsing', () => {
  test('strips fences and wrappers the model was told not to add', () => {
    expect(cleanBody("```ts\nawait expect(page.getByText('A')).toBeVisible();\n```")).toBe("await expect(page.getByText('A')).toBeVisible();");
    expect(cleanBody("test('x', async ({ page }) => {\n  await expect(page).toHaveTitle(/A/);\n});")).toBe('await expect(page).toHaveTitle(/A/);');
    expect(cleanBody("import { test } from '@playwright/test';\nawait expect(page).toHaveURL(/f/);")).toBe('await expect(page).toHaveURL(/f/);');
  });

  test('keeps only tests with an assertion and a unique title', () => {
    const text = JSON.stringify({
      tests: [
        { title: 'Grid shows rules', intent: 'i', body: "await expect(page.getByRole('grid')).toBeVisible();" },
        { title: 'Grid shows rules', intent: 'dup', body: 'await expect(page).toHaveURL(/x/);' },
        { title: 'No assertion', intent: 'i', body: "await page.getByRole('button').click();" },
        { title: '', intent: 'i', body: 'await expect(page).toHaveURL(/x/);' },
      ],
    });

    expect(parseTests(`Sure! ${text}`, 10).map((entry) => entry.title)).toEqual(['Grid shows rules']);
  });

  test('a generated spec imports the fixture and keeps the title literal', () => {
    const source = specSource({ title: 'Rule "A" opens', intent: 'Protects opening', body: 'await expect(page).toHaveURL(/a/);' });

    expect(source).toContain("from '../qyntra-fixture'");
    expect(source).toContain('test("Rule \\"A\\" opens"');
  });
});

test.describe('value mismatch detection', () => {
  test('a different value is a mismatch; a missing element is not', () => {
    expect(isValueMismatch('expect(locator).toHaveText(expected) failed\nExpected: "$129.00"\nReceived: "$40.00"\nCall log:\n  - waiting for getByTestId(\'total\')')).toBe(true);
    expect(isValueMismatch('expect(locator).toBeVisible() failed\nExpected: visible\nReceived: <element(s) not found>')).toBe(false);
    expect(isValueMismatch('locator.click: Timeout 15000ms exceeded.\nwaiting for getByRole(\'button\')')).toBe(false);
  });
});

function observation(overrides: Partial<FeatureObservation> = {}): FeatureObservation {
  return {
    feature: 'Fee Rules',
    located: 'path',
    url: 'https://app.example/app/zoo/fee-rules',
    loadMs: 2_000,
    views: [],
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    graphqlErrors: [],
    blockedWrites: [],
    unlabeledControls: [],
    menu: [],
    readOnly: true,
    probes: [],
    ...overrides,
  };
}

test.describe('observed findings', () => {
  test('a clean feature has none', () => {
    expect(observedFindings(observation(), 'https://app.example/')).toEqual([]);
  });

  test('turns what the browser saw into findings', () => {
    const findings = observedFindings(
      observation({
        loadMs: 15_000,
        failedRequests: [
          { method: 'GET', url: 'https://app.example/app/zoo/fee-rules', status: 404 },
          { method: 'HEAD', url: 'https://app.example/graphql', status: 400 },
          { method: 'POST', url: 'https://app.example/graphql', status: 500, operation: 'feeRules' },
          { method: 'GET', url: 'http://localhost:9100/bridge', failure: 'net::ERR_CONNECTION_REFUSED' },
          { method: 'GET', url: 'https://app.example/assets/x.js', failure: 'net::ERR_ABORTED' },
        ],
        graphqlErrors: [{ method: 'POST', url: 'https://app.example/graphql', operation: 'toursV2', errors: ['Not authorised'] }],
        unlabeledControls: [{ role: 'button', count: 14 }],
        menu: [{ label: 'B2B Reports', href: '/app/zoo/view-b2b-reports/undefined' }],
      }),
      'https://app.example/'
    );

    const titles = findings.map((finding) => `${finding.severity}: ${finding.title}`);

    expect(titles).toEqual([
      'High: API operation "toursV2" returned errors',
      "Medium: Opening the feature's URL directly returns HTTP 404",
      'Low: HEAD /graphql failed with HTTP 400',
      'High: POST /graphql (feeRules) failed with HTTP 500',
      "Medium: The page tries to reach a service on the user's own machine",
      'High: The feature takes 15.0s to be ready',
      'Medium: 14 button(s) have no accessible name',
      'Medium: 1 menu link(s) contain "undefined" or "null"',
    ]);
    expect(findings.every((finding) => finding.source === 'observed')).toBe(true);
  });

  test('an unavailable feature is Critical', () => {
    const [finding] = observedFindings(observation({ unavailableMessage: 'This feature is not available for your property.' }), 'https://app.example/');

    expect(finding.severity).toBe('Critical');
    expect(finding.evidence).toContain('not available for your property');
  });
});

const finding = (severity: Finding['severity'], source: Finding['source']): Finding => ({
  title: `${severity} ${source}`,
  severity,
  category: 'usability',
  evidence: 'e',
  recommendation: 'r',
  source,
});

const outcome = (status: TestOutcome['status']): TestOutcome => ({ title: status, intent: 'i', status, attempts: 1 });

test.describe('feature verdict', () => {
  const verified = Array.from({ length: 5 }, () => outcome('verified'));

  test('clean, well-tested feature is READY with High confidence', () => {
    expect(decideFeature([finding('Low', 'observed')], verified, true)).toMatchObject({ verdict: 'READY', confidence: 'High' });
  });

  test('observed High or a failing test blocks; an AI-review High alone does not', () => {
    expect(decideFeature([finding('High', 'observed')], verified, true).verdict).toBe('NOT_READY');
    expect(decideFeature([], [...verified, outcome('app-defect')], true).verdict).toBe('NOT_READY');
    expect(decideFeature([finding('High', 'ai-review')], verified, true).verdict).toBe('READY_WITH_ISSUES');
  });

  test('Medium findings make it READY_WITH_ISSUES', () => {
    expect(decideFeature([finding('Medium', 'observed')], verified, true).verdict).toBe('READY_WITH_ISSUES');
  });

  test('without AI, behaviour checks alone earn Medium at most', () => {
    const probes = decideFeature([], [outcome('verified'), outcome('verified'), outcome('verified')], false);
    expect(probes.confidence).toBe('Medium');
    expect(probes.reasons.join(' ')).toContain('Judged by 3 behaviour check(s), without AI');
  });

  test('without AI, or with few verified tests, confidence is Low and says why', () => {
    const noAi = decideFeature([], [], false);
    expect(noAi.confidence).toBe('Low');
    expect(noAi.reasons.join(' ')).toContain('No AI provider');

    const thin = decideFeature([], [outcome('verified'), outcome('rejected')], true);
    expect(thin.confidence).toBe('Low');
    expect(thin.reasons.join(' ')).toContain('Only 1 test');
  });
});

test.describe('verifier repairs without AI', () => {
  // Verbatim from a real run against an MUI admin app.
  const strictError = `Error: expect(locator).toBeVisible() failed

Locator: getByText('FILTERS')
Expected: visible
Error: strict mode violation: getByText('FILTERS') resolved to 2 elements:
    1) <span class="MuiButton-label">Save Filters</span> aka locator('button').filter({ hasText: 'Save Filters' })
    2) <p class="MuiTypography-root jss320 MuiTypography-body2">FILTERS</p> aka getByText('FILTERS', { exact: true })`;

  test('a strict-mode violation takes the alternative Playwright names', () => {
    const body = "await page.getByRole('button', { name: 'Filter Table' }).click(); await expect(page.getByText('FILTERS')).toBeVisible();";

    expect(strictModeFix(body, strictError)).toBe(
      "await page.getByRole('button', { name: 'Filter Table' }).click(); await expect(page.getByText('FILTERS', { exact: true })).toBeVisible();"
    );
  });

  test('no fix when the alternatives do not single out one element', () => {
    const ambiguous = `Error: strict mode violation: getByText('Status') resolved to 5 elements:
    1) <div>Status</div> aka getByTestId('headcol-3')
    2) <div>Status</div> aka getByTestId('MuiDataTableBodyCell-3-0').getByText('Status')`;

    expect(strictModeFix("await expect(page.getByText('Status')).toBeVisible();", ambiguous)).toBeUndefined();
    expect(strictModeFix('await expect(page).toHaveURL(/x/);', 'Error: Expected 1 Received 2')).toBeUndefined();
  });

  test('network blips are infrastructure, assertion failures are not', () => {
    expect(isInfrastructureError('Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://devshop.example/app')).toBe(true);
    expect(isInfrastructureError('Target page, context or browser has been closed')).toBe(true);
    expect(isInfrastructureError(strictError)).toBe(false);
  });

  test('locator candidates come from named roles and exact text', () => {
    const candidates = locatorCandidates(
      [
        '- button "View Columns"',
        '- combobox:',
        '  - textbox "Start typing to see suggestions"',
        '- row "Rule Name Tours Assigned Description"',
        '- columnheader "Status"',
        '- text: Rule Name *',
        '- paragraph: Toggle on the rows that should apply.',
        '- button "View Columns"',
      ].join('\n')
    );

    expect(candidates).toEqual([
      { kind: 'role', role: 'button', name: 'View Columns' },
      { kind: 'role', role: 'textbox', name: 'Start typing to see suggestions' },
      { kind: 'role', role: 'columnheader', name: 'Status' },
      { kind: 'text', name: 'Rule Name *' },
      { kind: 'text', name: 'Toggle on the rows that should apply.' },
    ]);
  });
});

test.describe('vacuity check', () => {
  test('splits one-line bodies into statements', () => {
    expect(statements("await page.getByRole('button').click(); await expect(page.getByText('A')).toBeVisible();")).toEqual([
      "await page.getByRole('button').click()",
      "await expect(page.getByText('A')).toBeVisible()",
    ]);
  });

  test('strips actions, keeping assertions', () => {
    // From a real run: typed into the account picker, then checked
    // a row that was visible all along.
    const body = "await page.getByRole('textbox', { name: 'Acme Workspace Dashboard' }).fill('Summer Sale');\nawait expect(page.getByText('Summer Sale')).toBeVisible();";

    expect(assertionsOnly(body)).toBe("await expect(page.getByText('Summer Sale')).toBeVisible();");
  });

  test('a pure presence check has nothing to strip', () => {
    expect(assertionsOnly("await expect(page.getByRole('grid')).toBeVisible();")).toBeUndefined();
    expect(assertionsOnly("await page.getByRole('button').click();")).toBeUndefined();
  });
});

test.describe('feature labels', () => {
  test('counters next to menu items are not part of the feature name', () => {
    expect(featureLabel('Cart (0)')).toBe('Cart');
    expect(featureLabel('Inbox 12')).toBe('Inbox');
    expect(featureLabel('Orders · 3')).toBe('Orders');
    expect(featureLabel('Notifications [99+]')).toBe('Notifications');
    expect(featureLabel('Discount Rules')).toBe('Discount Rules');
    expect(featureLabel('Top 10 Products')).toBe('Top 10 Products');
    expect(featureLabel('2024')).toBe('2024');
  });
});
