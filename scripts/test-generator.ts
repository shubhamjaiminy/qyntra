import fs from 'fs';
import path from 'path';

interface Action {
  order: number;
  action: string;
  target?: string;
  value?: string;
  key?: string;
  condition?: string;
}

interface ScenarioPlan {
  id?: number;
  title: string;
  priority: string;
  type: string;
  description: string;
  actions: Action[];
}

interface ScenarioMapping {
  generatedAt: string;
  requirement: string;
  application: {
    title: string;
    url: string;
  };
  risk: {
    level: string;
    score: number;
  };
  scenarios: ScenarioPlan[];
}

const dashboardDirectory = path.join(
  process.cwd(),
  'qyntra-dashboard'
);

const generatedTestsDirectory = path.join(
  process.cwd(),
  'tests',
  'generated'
);

const mappingFile = path.join(
  dashboardDirectory,
  'scenario-mapping.json'
);

function readJson<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `File not found: ${filePath}`
    );
  }

  return JSON.parse(
    fs.readFileSync(filePath, 'utf8')
  ) as T;
}

function escapeSingleQuote(
  value: string
): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function escapeTemplateLiteral(
  value: string
): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function slugify(
  value: unknown
): string {
  const safeValue = String(
    value ?? 'generated-test'
  );

  const slug = safeValue
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'generated-test';
}

function cleanGeneratedTests(): void {
  fs.mkdirSync(
    generatedTestsDirectory,
    {
      recursive: true
    }
  );

  const files = fs
    .readdirSync(
      generatedTestsDirectory
    )
    .filter((file) =>
      file.endsWith('.spec.ts')
    );

  for (const file of files) {
    fs.unlinkSync(
      path.join(
        generatedTestsDirectory,
        file
      )
    );
  }
}

function targetToLocator(
  target: string
): string {
  const placeholderMatch =
    target.match(
      /^placeholder="(.*)"$/
    );

  if (placeholderMatch) {
    return `page.getByPlaceholder('${escapeSingleQuote(
      placeholderMatch[1]
    )}')`;
  }

  const ariaLabelMatch =
    target.match(
      /^aria-label="(.*)"$/
    );

  if (ariaLabelMatch) {
    return `page.getByLabel('${escapeSingleQuote(
      ariaLabelMatch[1]
    )}')`;
  }

  const nameMatch =
    target.match(
      /^name="(.*)"$/
    );

  if (nameMatch) {
    return `page.locator('[name="${escapeSingleQuote(
      nameMatch[1]
    )}"]')`;
  }

  return `page.getByText('${escapeSingleQuote(
    target
  )}')`;
}

function generateFillAction(
  action: Action
): string {
  if (!action.target) {
    return `  // Qyntra could not determine the fill target`;
  }

  const locator =
    targetToLocator(action.target);

  const value =
    action.value ?? '';

  return `  await ${locator}.fill('${escapeSingleQuote(
    value
  )}');`;
}

function generatePressAction(
  action: Action
): string {
  if (!action.target) {
    return `  // Qyntra could not determine the press target`;
  }

  const locator =
    targetToLocator(action.target);

  const key =
    action.key ?? 'Enter';

  return `  await ${locator}.press('${escapeSingleQuote(
    key
  )}');`;
}

function generateVerifyAction(
  action: Action
): string {
  if (!action.target) {
    return `  // Qyntra could not determine the verification target`;
  }

  const target =
    escapeSingleQuote(
      action.target
    );

  const condition =
    action.condition ?? 'visible';

  if (
    condition === 'not-visible'
  ) {
    return `  await expect(
    page.getByText('${target}')
  ).not.toBeVisible();`;
  }

  if (
    condition === 'completed'
  ) {
    return `  const completedTodo =
    page
      .locator('li')
      .filter({
        hasText: '${target}'
      });

  await expect(
    completedTodo.locator('.toggle')
  ).toBeChecked();`;
  }

  return `  await expect(
    page.getByText('${target}')
  ).toBeVisible();`;
}

function generateFindAction(
  action: Action
): string {
  if (!action.target) {
    return `  // Qyntra could not determine what to find`;
  }

  const target =
    escapeSingleQuote(
      action.target
    );

  return `  const todoItem =
    page
      .locator('li')
      .filter({
        hasText: '${target}'
      });

  await expect(todoItem).toBeVisible();`;
}

function generateCheckAction(
  action: Action
): string {
  const target =
    action.target ?? '';

  if (
    target.toLowerCase().includes(
      'checkbox'
    )
  ) {
    return `  await todoItem
    .getByRole('checkbox', {
      name: 'Toggle Todo'
    })
    .check();`;
  }

  return `  // Qyntra could not safely map this check action`;
}

function generateDeleteAction(action: Action): string {
  if (!action.target) {
    return `  // Qyntra could not determine what to delete`;
  }

  return `  await todoItem.hover();

  await todoItem.locator('button.destroy').click();`;
}

function generateInspectAction(
  action: Action
): string {
  if (!action.target) {
    return `  // Qyntra inspection target unavailable`;
  }

  return `  // Qyntra discovered:
  // ${escapeSingleQuote(
    action.target
  )}`;
}

function generateManualReviewAction(
  action: Action
): string {
  return `  // Qyntra manual review:
  // ${escapeSingleQuote(
    action.condition ??
      'Application-specific behavior required'
  )}`;
}

function generateAction(
  action: Action
): string {
  switch (
    action.action.toLowerCase()
  ) {
    case 'fill':
      return generateFillAction(
        action
      );

    case 'press':
      return generatePressAction(
        action
      );

    case 'verify':
      return generateVerifyAction(
        action
      );

    case 'find':
      return generateFindAction(
        action
      );

    case 'check':
      return generateCheckAction(
        action
      );

    case 'delete':
      return generateDeleteAction(
        action
      );

    case 'inspect':
      return generateInspectAction(
        action
      );

    case 'manual-review':
      return generateManualReviewAction(
        action
      );

    default:
      return `  // Qyntra unsupported action:
  // ${escapeSingleQuote(
    action.action
  )}`;
  }
}

function generateTest(
  scenario: ScenarioPlan,
  mapping: ScenarioMapping
): string {
  const actions =
    [...scenario.actions]
      .sort(
        (a, b) =>
          a.order - b.order
      );

  const generatedActions =
    actions
      .map(generateAction)
      .join('\n\n');

  return `import {
  test,
  expect
} from '@playwright/test';

/**
 * =========================================
 * QYNTRA GENERATED TEST
 * =========================================
 *
 * Requirement:
 * ${escapeSingleQuote(
   mapping.requirement
 )}
 *
 * Application:
 * ${escapeSingleQuote(
   mapping.application.title
 )}
 *
 * Application URL:
 * ${escapeSingleQuote(
   mapping.application.url
 )}
 *
 * Risk:
 * ${escapeSingleQuote(
   mapping.risk.level
 )} (${mapping.risk.score}/10)
 *
 * Scenario:
 * ${escapeSingleQuote(
   scenario.title
 )}
 *
 * Priority:
 * ${escapeSingleQuote(
   scenario.priority
 )}
 *
 * Type:
 * ${escapeSingleQuote(
   scenario.type
 )}
 *
 * Generated by Qyntra
 * =========================================
 */

test(
  '${escapeSingleQuote(
    scenario.title
  )}',
  async ({ page }) => {
   await page.goto('https://demo.playwright.dev/todomvc');

${generatedActions}
  }
);
`;
}

function main(): void {
  console.log('');
  console.log(
    '======================================'
  );
  console.log(
    'QYNTRA ACTION-PLAN TEST GENERATOR'
  );
  console.log(
    '======================================'
  );
  console.log('');

  if (
    !fs.existsSync(mappingFile)
  ) {
    throw new Error(
      'scenario-mapping.json not found. Run npm run map:scenarios first.'
    );
  }

  const mapping =
    readJson<ScenarioMapping>(
      mappingFile
    );

  if (
    !Array.isArray(
      mapping.scenarios
    )
  ) {
    throw new Error(
      'Invalid scenario-mapping.json: scenarios must be an array.'
    );
  }

  cleanGeneratedTests();

  console.log(
    `Requirement : ${mapping.requirement}`
  );

  console.log(
    `Application : ${mapping.application.title}`
  );

  console.log(
    `Risk        : ${mapping.risk.level}`
  );

  console.log(
    `Risk Score  : ${mapping.risk.score}/10`
  );

  console.log(
    `Scenarios   : ${mapping.scenarios.length}`
  );

  console.log('');
  console.log(
    'Generating tests from action plans...'
  );
  console.log('');

  let generated = 0;

  for (
    const scenario of mapping.scenarios
  ) {
    const filename =
      `${slugify(
        scenario.title
      )}.spec.ts`;

    const filePath =
      path.join(
        generatedTestsDirectory,
        filename
      );

    const testCode =
      generateTest(
        scenario,
        mapping
      );

    fs.writeFileSync(
      filePath,
      testCode,
      'utf8'
    );

    generated++;

    console.log(
      `✓ ${scenario.priority} ${scenario.title} → ${filename}`
    );
  }

  console.log('');
  console.log(
    '======================================'
  );
  console.log(
    'QYNTRA GENERATION RESULT'
  );
  console.log(
    '======================================'
  );

  console.log(
    `Application   : ${mapping.application.title}`
  );

  console.log(
    `Risk          : ${mapping.risk.level}`
  );

  console.log(
    `Score         : ${mapping.risk.score}/10`
  );

  console.log(
    `Scenarios     : ${mapping.scenarios.length}`
  );

  console.log(
    `Generated     : ${generated}`
  );

  console.log('');

  console.log(
    `Tests saved to: ${generatedTestsDirectory}`
  );

  console.log('');
}

try {
  main();
} catch (error) {
  console.error('');
  console.error(
    'QYNTRA TEST GENERATION FAILED'
  );
  console.error('');
  console.error(error);
  process.exit(1);
}