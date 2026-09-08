import fs from 'fs';
import path from 'path';

interface Scenario {
  id?: number;
  priority?: string;
  title?: string;
  name?: string;
  description?: string;
  type?: string;
}

interface RiskAnalysis {
  requirement: string;
  riskLevel: string;
  riskScore: number;
  scenarios: Scenario[];
}

interface ApplicationInput {
  type: string;
  name: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
}

interface ApplicationButton {
  text: string;
  ariaLabel: string | null;
}

interface ApplicationMap {
  url: string;
  title: string;
  headings: string[];
  inputs: ApplicationInput[];
  buttons: ApplicationButton[];
  links: {
    text: string;
    href: string;
  }[];
  textareas: {
    name: string | null;
    placeholder: string | null;
    ariaLabel: string | null;
  }[];
  selects: {
    name: string | null;
    ariaLabel: string | null;
  }[];
  forms: number;
}

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

const riskFile = path.join(
  dashboardDirectory,
  'risk-analysis.json'
);

const applicationMapFile = path.join(
  dashboardDirectory,
  'application-map.json'
);

const outputFile = path.join(
  dashboardDirectory,
  'scenario-mapping.json'
);

function readJson<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  return JSON.parse(
    fs.readFileSync(filePath, 'utf8')
  ) as T;
}

function getTitle(scenario: Scenario): string {
  return (
    scenario.title?.trim() ||
    scenario.name?.trim() ||
    scenario.description?.trim() ||
    `Generated scenario ${scenario.id ?? 'unknown'}`
  );
}

function getDescription(scenario: Scenario): string {
  return (
    scenario.description?.trim() ||
    getTitle(scenario)
  );
}

function getPriority(scenario: Scenario): string {
  return scenario.priority?.trim() || 'P2';
}

function getType(scenario: Scenario): string {
  return scenario.type?.trim() || 'Generic';
}

function findTodoInput(
  application: ApplicationMap
): ApplicationInput | null {
  const keywords = [
    'todo',
    'task',
    'what needs to be done',
    'title',
    'description'
  ];

  for (const keyword of keywords) {
    const input = application.inputs.find((item) => {
      const searchable = [
        item.placeholder,
        item.name,
        item.ariaLabel,
        item.type
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return searchable.includes(keyword);
    });

    if (input) {
      return input;
    }
  }

  return application.inputs[0] ?? null;
}

function getInputTarget(
  input: ApplicationInput
): string {
  if (input.ariaLabel) {
    return `aria-label="${input.ariaLabel}"`;
  }

  if (input.placeholder) {
    return `placeholder="${input.placeholder}"`;
  }

  if (input.name) {
    return `name="${input.name}"`;
  }

  return `type="${input.type}"`;
}

function createTodoActions(
  application: ApplicationMap
): Action[] {
  const input = findTodoInput(application);

  if (!input) {
    return [
      {
        order: 1,
        action: 'manual-review',
        condition:
          'No suitable text input discovered'
      }
    ];
  }

  const target = getInputTarget(input);

  return [
    {
      order: 1,
      action: 'fill',
      target,
      value: 'Qyntra test task'
    },
    {
      order: 2,
      action: 'press',
      target,
      key: 'Enter'
    },
    {
      order: 3,
      action: 'verify',
      target: 'Qyntra test task',
      condition: 'visible'
    }
  ];
}

function createMultipleTodoActions(
  application: ApplicationMap
): Action[] {
  const input = findTodoInput(application);

  if (!input) {
    return [
      {
        order: 1,
        action: 'manual-review',
        condition:
          'No suitable text input discovered'
      }
    ];
  }

  const target = getInputTarget(input);

  return [
    {
      order: 1,
      action: 'fill',
      target,
      value: 'Qyntra task one'
    },
    {
      order: 2,
      action: 'press',
      target,
      key: 'Enter'
    },
    {
      order: 3,
      action: 'fill',
      target,
      value: 'Qyntra task two'
    },
    {
      order: 4,
      action: 'press',
      target,
      key: 'Enter'
    },
    {
      order: 5,
      action: 'verify',
      target: 'Qyntra task one',
      condition: 'visible'
    },
    {
      order: 6,
      action: 'verify',
      target: 'Qyntra task two',
      condition: 'visible'
    }
  ];
}

function createEmptyTodoActions(
  application: ApplicationMap
): Action[] {
  const input = findTodoInput(application);

  if (!input) {
    return [
      {
        order: 1,
        action: 'manual-review',
        condition:
          'No suitable text input discovered'
      }
    ];
  }

  return [
    {
      order: 1,
      action: 'press',
      target: getInputTarget(input),
      key: 'Enter'
    },
    {
      order: 2,
      action: 'verify',
      target: 'Qyntra test task',
      condition: 'not-visible'
    }
  ];
}

function createCompleteTodoActions(
  application: ApplicationMap
): Action[] {
  const input = findTodoInput(application);

  if (!input) {
    return [
      {
        order: 1,
        action: 'manual-review',
        condition:
          'No suitable text input discovered'
      }
    ];
  }

  const target = getInputTarget(input);

  return [
    {
      order: 1,
      action: 'fill',
      target,
      value: 'Qyntra task to complete'
    },
    {
      order: 2,
      action: 'press',
      target,
      key: 'Enter'
    },
    {
      order: 3,
      action: 'find',
      target: 'Qyntra task to complete'
    },
    {
      order: 4,
      action: 'check',
      target: 'Todo checkbox'
    },
    {
      order: 5,
      action: 'verify',
      target: 'Qyntra task to complete',
      condition: 'completed'
    }
  ];
}

function createDeleteTodoActions(
  application: ApplicationMap
): Action[] {
  const input = findTodoInput(application);

  if (!input) {
    return [
      {
        order: 1,
        action: 'manual-review',
        condition:
          'No suitable text input discovered'
      }
    ];
  }

  const target = getInputTarget(input);

  return [
    {
      order: 1,
      action: 'fill',
      target,
      value: 'Qyntra task to delete'
    },
    {
      order: 2,
      action: 'press',
      target,
      key: 'Enter'
    },
    {
      order: 3,
      action: 'find',
      target: 'Qyntra task to delete'
    },
    {
      order: 4,
      action: 'delete',
      target: 'Qyntra task to delete'
    },
    {
      order: 5,
      action: 'verify',
      target: 'Qyntra task to delete',
      condition: 'not-visible'
    }
  ];
}

function createSpecialCharacterActions(
  application: ApplicationMap
): Action[] {
  const input = findTodoInput(application);

  if (!input) {
    return [
      {
        order: 1,
        action: 'manual-review',
        condition:
          'No suitable text input discovered'
      }
    ];
  }

  const target = getInputTarget(input);

  return [
    {
      order: 1,
      action: 'fill',
      target,
      value: `Qyntra <test> "special" & symbols`
    },
    {
      order: 2,
      action: 'press',
      target,
      key: 'Enter'
    },
    {
      order: 3,
      action: 'verify',
      target: `Qyntra <test> "special" & symbols`,
      condition: 'visible'
    }
  ];
}

function createLongTextActions(
  application: ApplicationMap
): Action[] {
  const input = findTodoInput(application);

  if (!input) {
    return [
      {
        order: 1,
        action: 'manual-review',
        condition:
          'No suitable text input discovered'
      }
    ];
  }

  const target = getInputTarget(input);

  return [
    {
      order: 1,
      action: 'fill',
      target,
      value:
        'Qyntra '.repeat(50).trim()
    },
    {
      order: 2,
      action: 'press',
      target,
      key: 'Enter'
    },
    {
      order: 3,
      action: 'verify',
      target:
        'Qyntra '.repeat(50).trim(),
      condition: 'visible'
    }
  ];
}

function createGenericActions(
  application: ApplicationMap
): Action[] {
  const input = findTodoInput(application);

  if (!input) {
    return [
      {
        order: 1,
        action: 'manual-review',
        condition:
          'No suitable input discovered'
      }
    ];
  }

  return [
    {
      order: 1,
      action: 'inspect',
      target: getInputTarget(input)
    },
    {
      order: 2,
      action: 'manual-review',
      condition:
        'Scenario requires application-specific behavior'
    }
  ];
}

function mapScenario(
  scenario: Scenario,
  application: ApplicationMap
): ScenarioPlan {
  const title = getTitle(scenario);
  const normalized = title.toLowerCase();

  let actions: Action[];

  if (
    normalized.includes('multiple')
  ) {
    actions = createMultipleTodoActions(
      application
    );
  } else if (
    normalized.includes('empty')
  ) {
    actions = createEmptyTodoActions(
      application
    );
  } else if (
    normalized.includes('complete')
  ) {
    actions = createCompleteTodoActions(
      application
    );
  } else if (
    normalized.includes('delete')
  ) {
    actions = createDeleteTodoActions(
      application
    );
  } else if (
    normalized.includes('special')
  ) {
    actions = createSpecialCharacterActions(
      application
    );
  } else if (
    normalized.includes('long')
  ) {
    actions = createLongTextActions(
      application
    );
  } else if (
    normalized.includes('create')
  ) {
    actions = createTodoActions(
      application
    );
  } else {
    actions = createGenericActions(
      application
    );
  }

  return {
    id: scenario.id,
    title,
    priority: getPriority(scenario),
    type: getType(scenario),
    description: getDescription(scenario),
    actions
  };
}

function main(): void {
  console.log('');
  console.log('======================================');
  console.log('QYNTRA SCENARIO MAPPER');
  console.log('======================================');
  console.log('');

  const risk =
    readJson<RiskAnalysis>(riskFile);

  const application =
    readJson<ApplicationMap>(
      applicationMapFile
    );

  console.log(
    `Requirement : ${risk.requirement}`
  );

  console.log(
    `Application : ${application.title}`
  );

  console.log(
    `Risk        : ${risk.riskLevel}`
  );

  console.log(
    `Scenarios   : ${risk.scenarios.length}`
  );

  console.log('');
  console.log(
    'Mapping scenarios to application actions...'
  );
  console.log('');

  const scenarios =
    risk.scenarios.map(
      (scenario) =>
        mapScenario(
          scenario,
          application
        )
    );

  const mapping: ScenarioMapping = {
    generatedAt:
      new Date().toISOString(),

    requirement:
      risk.requirement,

    application: {
      title:
        application.title,
      url:
        application.url
    },

    risk: {
      level:
        risk.riskLevel,
      score:
        risk.riskScore
    },

    scenarios
  };

  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      mapping,
      null,
      2
    ),
    'utf8'
  );

  for (const scenario of scenarios) {
    console.log(
      `✓ ${scenario.priority} ${scenario.title}`
    );

    for (const action of scenario.actions) {
      const target =
        action.target
          ? ` → ${action.target}`
          : '';

      console.log(
        `   ${action.order}. ${action.action}${target}`
      );
    }

    console.log('');
  }

  console.log('======================================');
  console.log('QYNTRA MAPPING RESULT');
  console.log('======================================');
  console.log(
    `Mapped scenarios : ${scenarios.length}`
  );
  console.log(
    `Application      : ${application.title}`
  );
  console.log('');
  console.log(
    `Saved to: ${outputFile}`
  );
  console.log('');
}

try {
  main();
} catch (error) {
  console.error('');
  console.error(
    'QYNTRA SCENARIO MAPPING FAILED'
  );
  console.error('');
  console.error(error);
  process.exit(1);
}