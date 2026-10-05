import fs from 'fs';
import path from 'path';

import { stagePaths } from './lib/paths';

interface Scenario {
  id: number;
  title: string;
  priority: string;
  type: string;
  description: string;
  mappedCapability?: string;
  evidence?: string;
  actions?: string[];
}

interface ScenarioMapping {
  generatedAt: string;
  requirement: string;

  application: {
    title: string;
    url: string;
    framework: string;
  };

  discovery: {
    exploratory: boolean;
    capabilitiesDetected: number;
    todoStructureDetected: boolean;
  };

  scenarios: Scenario[];

  summary: {
    total: number;
    p0: number;
    p1: number;
    p2: number;
  };
}

interface ApplicationMap {
  application?: {
    title?: string;
    url?: string;
    framework?: string;
  };

  capabilities?: {
    name?: string;
    confidence?: string;
    evidence?: string;
  }[];

  todoStructure?: {
    detected?: boolean;
    container?: string | null;
    item?: string | null;
    checkbox?: string | null;
    delete?: string | null;
    completed?: string | null;
  };

  dynamicDiscovery?: {
    enabled?: boolean;
  };
}

interface GeneratedTest {
  scenarioId: number;
  scenario: string;
  file: string;
  capability: string;
  priority: string;
  type: string;
  status: 'GENERATED' | 'SKIPPED';
  reason?: string;
}

// --------------------------------------------------
// PATHS
// --------------------------------------------------

const paths = stagePaths();

const dashboardDir = paths.outputDir;
const generatedDir = paths.generatedTests;
const scenarioMappingFile = paths.scenarioMapping;
const applicationMapFile = paths.applicationMap;
const summaryFile = paths.generationSummary;

// --------------------------------------------------
// VALIDATION
// --------------------------------------------------

if (
  !fs.existsSync(
    scenarioMappingFile
  )
) {
  console.error('');
  console.error(
    'Scenario mapping not found:'
  );
  console.error(
    scenarioMappingFile
  );
  console.error('');
  console.error(
    'Run:'
  );
  console.error(
    'npm run map:scenarios'
  );
  console.error('');
  process.exit(1);
}

if (
  !fs.existsSync(
    applicationMapFile
  )
) {
  console.error('');
  console.error(
    'Application map not found:'
  );
  console.error(
    applicationMapFile
  );
  console.error('');
  console.error(
    'Run discovery first:'
  );
  console.error(
    'npm run discover -- "https://example.com" --explore'
  );
  console.error('');
  process.exit(1);
}

// --------------------------------------------------
// LOAD
// --------------------------------------------------

const mapping =
  JSON.parse(
    fs.readFileSync(
      scenarioMappingFile,
      'utf-8'
    )
  ) as ScenarioMapping;

const application =
  JSON.parse(
    fs.readFileSync(
      applicationMapFile,
      'utf-8'
    )
  ) as ApplicationMap;

const scenarios =
  mapping.scenarios || [];

const appUrl =
  application.application?.url ||
  mapping.application.url;

const todo =
  application.todoStructure || {};

const todoDetected =
  todo.detected === true;

// --------------------------------------------------
// CLEAN GENERATED DIRECTORY
// --------------------------------------------------

fs.mkdirSync(
  generatedDir,
  {
    recursive: true,
  }
);

const oldFiles =
  fs.readdirSync(
    generatedDir
  );

for (
  const file of oldFiles
) {
  if (
    file.endsWith('.spec.ts')
  ) {
    fs.unlinkSync(
      path.join(
        generatedDir,
        file
      )
    );
  }
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function escapeSingleQuotes(
  value: string
): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function escapeTemplate(
  value: string
): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function slugify(
  value: string
): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(
      /^-+|-+$/g,
      ''
    );
}

function getCapability(
  scenario: Scenario
): string {
  return (
    scenario.mappedCapability ||
    'Application capability'
  );
}

function hasTodoCapability(
  scenario: Scenario
): boolean {
  const capability =
    getCapability(
      scenario
    ).toLowerCase();

  return (
    capability.includes('todo') ||
    capability.includes('task') ||
    todoDetected
  );
}

// --------------------------------------------------
// DISCOVERED SELECTORS
// --------------------------------------------------

const createInputSelector =
  (() => {
    const capability =
      application.capabilities?.find(
        (item) =>
          item.name
            ?.toLowerCase()
            .includes(
              'create todo'
            )
      );

    void capability;

    return (
      application
        .application
        ? undefined
        : undefined
    );
  })();

// We derive the actual creation selector
// from the application map's discovered inputs.
const discoveredInputs =
  (
    application as ApplicationMap & {
      inputs?: {
        selector?: string;
        purpose?: string;
      }[];
    }
  ).inputs || [];

const todoInput =
  discoveredInputs.find(
    (input) =>
      input.purpose ===
      'CREATE_TODO'
  );

const resolvedCreateSelector =
  todoInput?.selector ||
  'input[placeholder="What needs to be done?"]';

const resolvedItemSelector =
  todo.item ||
  'li';

const resolvedCheckboxSelector =
  todo.checkbox ||
  'input.toggle';

const resolvedDeleteSelector =
  todo.delete ||
  'button.destroy';

const resolvedCompletedSelector =
  todo.completed ||
  'li.completed';

// --------------------------------------------------
// TEST BUILDERS
// --------------------------------------------------

function createHeader(
  scenario: Scenario
): string {
  return `/**
 * QYNTRA GENERATED TEST
 *
 * Requirement : ${escapeTemplate(
   mapping.requirement
 )}
 * Application : ${escapeTemplate(
   mapping.application.title
 )}
 * URL         : ${escapeTemplate(
   appUrl
 )}
 *
 * Scenario    : ${escapeTemplate(
   scenario.title
 )}
 * Priority    : ${scenario.priority}
 * Type        : ${scenario.type}
 * Capability  : ${escapeTemplate(
   getCapability(scenario)
 )}
 *
 * Generated by Qyntra Test Generator v3
 */

import { test, expect } from '@playwright/test';

// Session saved by \`qyntra login\` / \`qyntra run\` for apps behind a login.
// Conditional so a storageState in playwright.config.ts is not overridden.
if (process.env.QYNTRA_STORAGE_STATE) {
  test.use({ storageState: process.env.QYNTRA_STORAGE_STATE });
}

`;
}

// --------------------------------------------------
// CREATE TODO
// --------------------------------------------------

function generateCreateTodoTest(
  scenario: Scenario
): string {
  return `${createHeader(
    scenario
  )}test('${escapeSingleQuotes(
    scenario.title
  )}', async ({ page }) => {
  await page.goto('${escapeSingleQuotes(
    appUrl
  )}');

  const todoInput = page.locator(
    '${escapeSingleQuotes(
      resolvedCreateSelector
    )}'
  );

  await expect(todoInput).toBeVisible();

  const todoText =
    'Qyntra generated todo';

  await todoInput.fill(todoText);
  await todoInput.press('Enter');

  const todoItem = page
    .locator('${escapeSingleQuotes(
      resolvedItemSelector
    )}')
    .filter({
      hasText: todoText,
    });

  await expect(todoItem).toBeVisible();
});
`;
}

// --------------------------------------------------
// MULTIPLE TODOS
// --------------------------------------------------

function generateMultipleTodoTest(
  scenario: Scenario
): string {
  return `${createHeader(
    scenario
  )}test('${escapeSingleQuotes(
    scenario.title
  )}', async ({ page }) => {
  await page.goto('${escapeSingleQuotes(
    appUrl
  )}');

  const todoInput = page.locator(
    '${escapeSingleQuotes(
      resolvedCreateSelector
    )}'
  );

  await expect(todoInput).toBeVisible();

  const firstTodo =
    'Qyntra todo one';

  const secondTodo =
    'Qyntra todo two';

  await todoInput.fill(firstTodo);
  await todoInput.press('Enter');

  await todoInput.fill(secondTodo);
  await todoInput.press('Enter');

  const firstItem = page
    .locator('${escapeSingleQuotes(
      resolvedItemSelector
    )}')
    .filter({
      hasText: firstTodo,
    });

  const secondItem = page
    .locator('${escapeSingleQuotes(
      resolvedItemSelector
    )}')
    .filter({
      hasText: secondTodo,
    });

  await expect(firstItem).toBeVisible();
  await expect(secondItem).toBeVisible();
});
`;
}

// --------------------------------------------------
// EMPTY TODO
// --------------------------------------------------

function generateEmptyTodoTest(
  scenario: Scenario
): string {
  return `${createHeader(
    scenario
  )}test('${escapeSingleQuotes(
    scenario.title
  )}', async ({ page }) => {
  await page.goto('${escapeSingleQuotes(
    appUrl
  )}');

  const todoInput = page.locator(
    '${escapeSingleQuotes(
      resolvedCreateSelector
    )}'
  );

  await expect(todoInput).toBeVisible();

  const beforeCount =
    await page
      .locator('${escapeSingleQuotes(
        resolvedItemSelector
      )}')
      .count();

  await todoInput.fill('');
  await todoInput.press('Enter');

  const afterCount =
    await page
      .locator('${escapeSingleQuotes(
        resolvedItemSelector
      )}')
      .count();

  expect(afterCount).toBe(
    beforeCount
  );
});
`;
}

// --------------------------------------------------
// SPECIAL CHARACTERS
// --------------------------------------------------

function generateSpecialCharacterTest(
  scenario: Scenario
): string {
  return `${createHeader(
    scenario
  )}test('${escapeSingleQuotes(
    scenario.title
  )}', async ({ page }) => {
  await page.goto('${escapeSingleQuotes(
    appUrl
  )}');

  const todoInput = page.locator(
    '${escapeSingleQuotes(
      resolvedCreateSelector
    )}'
  );

  const todoText =
    'Qyntra <test> & "special"';

  await todoInput.fill(todoText);
  await todoInput.press('Enter');

  const todoItem = page
    .locator('${escapeSingleQuotes(
      resolvedItemSelector
    )}')
    .filter({
      hasText: todoText,
    });

  await expect(todoItem).toBeVisible();
});
`;
}

// --------------------------------------------------
// LONG TODO
// --------------------------------------------------

function generateLongTodoTest(
  scenario: Scenario
): string {
  return `${createHeader(
    scenario
  )}test('${escapeSingleQuotes(
    scenario.title
  )}', async ({ page }) => {
  await page.goto('${escapeSingleQuotes(
    appUrl
  )}');

  const todoInput = page.locator(
    '${escapeSingleQuotes(
      resolvedCreateSelector
    )}'
  );

  const todoText =
    'Qyntra long todo '.repeat(20);

  await todoInput.fill(todoText);
  await todoInput.press('Enter');

  const todoItem = page
    .locator('${escapeSingleQuotes(
      resolvedItemSelector
    )}')
    .filter({
      hasText: todoText,
    });

  await expect(todoItem).toBeVisible();
});
`;
}

// --------------------------------------------------
// COMPLETE TODO
// --------------------------------------------------

function generateCompleteTodoTest(
  scenario: Scenario
): string {
  return `${createHeader(
    scenario
  )}test('${escapeSingleQuotes(
    scenario.title
  )}', async ({ page }) => {
  await page.goto('${escapeSingleQuotes(
    appUrl
  )}');

  const todoInput = page.locator(
    '${escapeSingleQuotes(
      resolvedCreateSelector
    )}'
  );

  const todoText =
    'Qyntra task to complete';

  await todoInput.fill(todoText);
  await todoInput.press('Enter');

  const todoItem = page
    .locator('${escapeSingleQuotes(
      resolvedItemSelector
    )}')
    .filter({
      hasText: todoText,
    });

  await expect(todoItem).toBeVisible();

  const checkbox = todoItem.locator(
    '${escapeSingleQuotes(
      resolvedCheckboxSelector
    )}'
  );

  await expect(checkbox).toBeVisible();

  await checkbox.check();

  await expect(
    todoItem
  ).toHaveClass(
    /completed/
  );
});
`;
}

// --------------------------------------------------
// DELETE TODO
// --------------------------------------------------

function generateDeleteTodoTest(
  scenario: Scenario
): string {
  return `${createHeader(
    scenario
  )}test('${escapeSingleQuotes(
    scenario.title
  )}', async ({ page }) => {
  await page.goto('${escapeSingleQuotes(
    appUrl
  )}');

  const todoInput = page.locator(
    '${escapeSingleQuotes(
      resolvedCreateSelector
    )}'
  );

  const todoText =
    'Qyntra task to delete';

  await todoInput.fill(todoText);
  await todoInput.press('Enter');

  const todoItem = page
    .locator('${escapeSingleQuotes(
      resolvedItemSelector
    )}')
    .filter({
      hasText: todoText,
    });

  await expect(todoItem).toBeVisible();

  await todoItem.hover();

  const deleteButton =
    todoItem.locator(
      '${escapeSingleQuotes(
        resolvedDeleteSelector
      )}'
    );

  await expect(
    deleteButton
  ).toBeVisible();

  await deleteButton.click();

  await expect(
    todoItem
  ).not.toBeVisible();
});
`;
}

// --------------------------------------------------
// GENERIC APPLICATION TEST
// --------------------------------------------------

function generateGenericTest(
  scenario: Scenario
): string {
  const actions =
    scenario.actions || [];

  const actionComments =
    actions
      .map(
        (action) =>
          `  // ${action}`
      )
      .join('\n');

  return `${createHeader(
    scenario
  )}test('${escapeSingleQuotes(
    scenario.title
  )}', async ({ page }) => {
  await page.goto('${escapeSingleQuotes(
    appUrl
  )}');

${actionComments}

  // Qyntra discovered this scenario,
  // but does not have enough application-specific
  // evidence to safely invent selectors or assertions.

  await expect(page).toHaveURL(
    '${escapeSingleQuotes(
      appUrl
    )}'
  );
});
`;
}

// --------------------------------------------------
// ROUTER
// --------------------------------------------------

function generateTest(
  scenario: Scenario
): {
  content: string;
  generated: boolean;
  reason?: string;
} {
  const title =
    scenario.title
      .toLowerCase();

  const capability =
    getCapability(
      scenario
    ).toLowerCase();

  if (
    todoDetected ||
    hasTodoCapability(
      scenario
    )
  ) {
    if (
      title ===
      'create todo'
    ) {
      return {
        content:
          generateCreateTodoTest(
            scenario
          ),
        generated: true,
      };
    }

    if (
      title ===
      'create multiple todos'
    ) {
      return {
        content:
          generateMultipleTodoTest(
            scenario
          ),
        generated: true,
      };
    }

    if (
      title ===
      'create empty todo'
    ) {
      return {
        content:
          generateEmptyTodoTest(
            scenario
          ),
        generated: true,
      };
    }

    if (
      title.includes(
        'special characters'
      )
    ) {
      return {
        content:
          generateSpecialCharacterTest(
            scenario
          ),
        generated: true,
      };
    }

    if (
      title.includes(
        'very long'
      )
    ) {
      return {
        content:
          generateLongTodoTest(
            scenario
          ),
        generated: true,
      };
    }

    if (
      title ===
        'complete todo' ||
      capability.includes(
        'complete todo'
      )
    ) {
      if (
        !todo.checkbox
      ) {
        return {
          content: '',
          generated: false,
          reason:
            'Completion control was not discovered.',
        };
      }

      return {
        content:
          generateCompleteTodoTest(
            scenario
          ),
        generated: true,
      };
    }

    if (
      title ===
        'delete todo' ||
      capability.includes(
        'delete'
      )
    ) {
      if (
        !todo.delete
      ) {
        return {
          content: '',
          generated: false,
          reason:
            'Delete control was not discovered.',
        };
      }

      return {
        content:
          generateDeleteTodoTest(
            scenario
          ),
        generated: true,
      };
    }
  }

  return {
    content:
      generateGenericTest(
        scenario
      ),
    generated: true,
  };
}

// --------------------------------------------------
// GENERATE ALL
// --------------------------------------------------

const results:
  GeneratedTest[] = [];

for (
  const scenario of scenarios
) {
  const slug =
    slugify(
      scenario.title
    );

  const fileName =
    `${String(
      scenario.id
    ).padStart(
      2,
      '0'
    )}-${slug}.spec.ts`;

  const filePath =
    path.join(
      generatedDir,
      fileName
    );

  const generated =
    generateTest(
      scenario
    );

  if (
    generated.generated
  ) {
    fs.writeFileSync(
      filePath,
      generated.content,
      'utf-8'
    );

    results.push({
      scenarioId:
        scenario.id,
      scenario:
        scenario.title,
      file:
        `generated/${fileName}`,
      capability:
        getCapability(
          scenario
        ),
      priority:
        scenario.priority,
      type:
        scenario.type,
      status:
        'GENERATED',
    });
  } else {
    results.push({
      scenarioId:
        scenario.id,
      scenario:
        scenario.title,
      file:
        '',
      capability:
        getCapability(
          scenario
        ),
      priority:
        scenario.priority,
      type:
        scenario.type,
      status:
        'SKIPPED',
      reason:
        generated.reason,
    });
  }
}

// --------------------------------------------------
// GENERATION SUMMARY
// --------------------------------------------------

const generatedCount =
  results.filter(
    (item) =>
      item.status ===
      'GENERATED'
  ).length;

const skippedCount =
  results.filter(
    (item) =>
      item.status ===
      'SKIPPED'
  ).length;

const summary = {
  generatedAt:
    new Date().toISOString(),

  generator:
    'Qyntra Test Generator v3',

  requirement:
    mapping.requirement,

  application: {
    title:
      mapping.application
        .title,

    url:
      appUrl,

    framework:
      mapping.application
        .framework,
  },

  discovery: {
    exploratory:
      mapping.discovery
        .exploratory,

    capabilitiesDetected:
      mapping.discovery
        .capabilitiesDetected,

    todoStructureDetected:
      mapping.discovery
        .todoStructureDetected,
  },

  summary: {
    scenarios:
      scenarios.length,

    generated:
      generatedCount,

    skipped:
      skippedCount,
  },

  files:
    results,
};

fs.writeFileSync(
  summaryFile,
  JSON.stringify(
    summary,
    null,
    2
  ),
  'utf-8'
);

// --------------------------------------------------
// CONSOLE
// --------------------------------------------------

console.log('');
console.log(
  '======================================'
);

console.log(
  'QYNTRA APPLICATION-AWARE TEST GENERATOR'
);

console.log(
  '======================================'
);

console.log('');

console.log(
  `Requirement : ${mapping.requirement}`
);

console.log(
  `Application : ${mapping.application.title}`
);

console.log(
  `URL         : ${appUrl}`
);

console.log(
  `Framework   : ${mapping.application.framework}`
);

console.log(
  `Exploratory : ${
    mapping.discovery.exploratory
      ? 'YES'
      : 'NO'
  }`
);

console.log('');

console.log(
  'DISCOVERED SELECTORS'
);

console.log(
  `Create      : ${resolvedCreateSelector}`
);

console.log(
  `Item        : ${resolvedItemSelector}`
);

console.log(
  `Complete    : ${resolvedCheckboxSelector}`
);

console.log(
  `Delete      : ${resolvedDeleteSelector}`
);

console.log(
  `Completed   : ${resolvedCompletedSelector}`
);

console.log('');

console.log(
  'GENERATING TESTS'
);

for (
  const result of results
) {
  if (
    result.status ===
    'GENERATED'
  ) {
    console.log(
      `✓ ${result.scenario}`
    );

    console.log(
      `  └─ ${result.file}`
    );
  } else {
    console.log(
      `⚠ ${result.scenario}`
    );

    console.log(
      `  └─ SKIPPED: ${result.reason}`
    );
  }
}

console.log('');

console.log(
  'GENERATION SUMMARY'
);

console.log(
  `Scenarios : ${scenarios.length}`
);

console.log(
  `Generated : ${generatedCount}`
);

console.log(
  `Skipped   : ${skippedCount}`
);

console.log('');

console.log(
  '✓ Generation summary saved'
);

console.log(
  summaryFile
);

console.log('');

console.log(
  '======================================'
);
