import fs from 'fs';

import { stagePaths } from './lib/paths';
import type { LoginStructure } from './lib/login-discovery';

interface Capability {
  name?: string;
  confidence?: string;
  evidence?: string;
}

interface TodoStructure {
  detected?: boolean;
  container?: string | null;
  item?: string | null;
  checkbox?: string | null;
  delete?: string | null;
  completed?: string | null;
}

interface ApplicationMap {
  generatedAt?: string;

  application?: {
    title?: string;
    url?: string;
    framework?: string;
    frameworkHints?: string[];
  };

  capabilities?: Capability[];

  todoStructure?: TodoStructure;

  loginStructure?: LoginStructure;

  dynamicDiscovery?: {
    enabled?: boolean;
    actions?: {
      action?: string;
      status?: string;
      evidence?: string;
      error?: string;
    }[];
  };
}

interface Scenario {
  id: number;
  title: string;
  priority: 'P0' | 'P1' | 'P2';
  type: 'Positive' | 'Negative' | 'Edge';
  description: string;
  mappedCapability: string;
  evidence: string;
  actions: string[];
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

// --------------------------------------------------
// PATHS
// --------------------------------------------------

const paths = stagePaths();

const dashboardDir = paths.outputDir;
const applicationMapFile = paths.applicationMap;
const riskFile = paths.riskAnalysis;
const outputFile = paths.scenarioMapping;

// --------------------------------------------------
// VALIDATION
// --------------------------------------------------

if (!fs.existsSync(applicationMapFile)) {
  console.error('');
  console.error(
    'Application map not found:'
  );
  console.error(applicationMapFile);
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
// LOAD FILES
// --------------------------------------------------

const applicationMap =
  JSON.parse(
    fs.readFileSync(
      applicationMapFile,
      'utf-8'
    )
  ) as ApplicationMap;

let requirement =
  'Application functionality';

if (fs.existsSync(riskFile)) {
  const riskAnalysis =
    JSON.parse(
      fs.readFileSync(
        riskFile,
        'utf-8'
      )
    );

  if (
    typeof riskAnalysis.requirement ===
    'string'
  ) {
    requirement =
      riskAnalysis.requirement;
  }
}

// --------------------------------------------------
// APPLICATION INFO
// --------------------------------------------------

const applicationTitle =
  applicationMap.application
    ?.title ||
  'Unknown Application';

const applicationUrl =
  applicationMap.application
    ?.url ||
  '';

const framework =
  applicationMap.application
    ?.framework ||
  'Unknown';

const capabilities =
  applicationMap.capabilities ||
  [];

const todoStructure =
  applicationMap.todoStructure ||
  {};

const exploratory =
  applicationMap.dynamicDiscovery
    ?.enabled === true;

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function hasCapability(
  ...names: string[]
): Capability | undefined {
  return capabilities.find(
    (capability) => {
      const capabilityName =
        String(
          capability.name || ''
        ).toLowerCase();

      return names.some(
        (name) =>
          capabilityName ===
          name.toLowerCase()
      );
    }
  );
}

function capabilityEvidence(
  capability: Capability | undefined
): string {
  return (
    capability?.evidence ||
    'Capability discovered from application map.'
  );
}

function hasDynamicEvidence(
  actionName: string
): boolean {
  return (
    applicationMap.dynamicDiscovery
      ?.actions
      ?.some(
        (action) =>
          action.action ===
            actionName &&
          action.status ===
            'passed'
      ) === true
  );
}

function createScenario(
  id: number,
  title: string,
  priority: Scenario['priority'],
  type: Scenario['type'],
  description: string,
  capability: Capability | undefined,
  actions: string[]
): Scenario {
  return {
    id,
    title,
    priority,
    type,
    description,
    mappedCapability:
      capability?.name ||
      'Application capability',
    evidence:
      capabilityEvidence(
        capability
      ),
    actions,
  };
}

// --------------------------------------------------
// LOGIN SCENARIOS
// --------------------------------------------------

/**
 * Scenarios for a structurally detected login form. Each negative
 * scenario exists only when its probe ran, and its evidence quotes what
 * the probe observed — that observation is what the test will assert.
 */
function loginScenarios(
  login: LoginStructure,
  capability: Capability
): Omit<Scenario, 'id'>[] {
  const field =
    login.identifierLabel ||
    'identifier';

  const base = (
    title: string,
    priority: Scenario['priority'],
    type: Scenario['type'],
    description: string,
    evidence: string,
    actions: string[]
  ): Omit<Scenario, 'id'> => ({
    title,
    priority,
    type,
    description,
    mappedCapability:
      capability.name ||
      'Authentication',
    evidence,
    actions,
  });

  const scenarios = [
    base(
      'Login Form Is Displayed',
      'P0',
      'Positive',
      'The login form renders with every control a user needs.',
      login.evidence.join('; '),
      [
        'Navigate to the login page.',
        `Verify the "${field}" field is visible.`,
        ...(login.password
          ? ['Verify the password field is visible.']
          : []),
        'Verify the submit control is visible.',
      ]
    ),
  ];

  if (login.password) {
    scenarios.push(
      base(
        'Password Is Masked',
        'P1',
        'Positive',
        'The password field hides what the user types.',
        'Password field detected on the login form.',
        [
          'Navigate to the login page.',
          'Verify the password field has type="password".',
        ]
      )
    );
  }

  const empty =
    login.probes.empty;

  if (
    empty?.stayedOnPage &&
    (empty.submitted || empty.submitDisabled)
  ) {
    scenarios.push(
      base(
        'Empty Credentials',
        'P1',
        'Negative',
        'An empty submission does not get past the login page.',
        empty.submitDisabled
          ? 'Probe: submit is disabled while the form is empty.'
          : empty.message
            ? `Probe: empty submit stayed on the page and showed "${empty.message}".`
            : 'Probe: empty submit stayed on the login page.',
        [
          'Navigate to the login page.',
          'Leave every field empty.',
          empty.submitDisabled
            ? 'Verify the submit control is disabled.'
            : 'Submit the form.',
          'Verify the user is still on the login page.',
        ]
      )
    );
  }

  const invalid =
    login.probes.invalid;

  if (
    invalid?.submitted &&
    invalid.stayedOnPage
  ) {
    scenarios.push(
      base(
        'Invalid Credentials',
        'P0',
        'Negative',
        'Credentials that match no account are rejected.',
        invalid.message
          ? `Probe: invalid submit stayed on the page and showed "${invalid.message}".`
          : 'Probe: invalid submit stayed on the login page.',
        [
          'Navigate to the login page.',
          `Enter a "${field}" that cannot belong to a real account.`,
          ...(login.password
            ? ['Enter an invalid password.']
            : []),
          'Submit the form.',
          ...(invalid.message
            ? [`Verify "${invalid.message}" is displayed.`]
            : []),
          'Verify the user is still on the login page.',
        ]
      )
    );
  }

  // Listed so the report shows the happy path as unverified, not absent.
  scenarios.push(
    base(
      'Successful Login',
      'P0',
      'Positive',
      'A user with valid credentials gets past the login page.',
      'Requires a test account; none is configured.',
      [
        'Navigate to the login page.',
        'Enter valid test-account credentials.',
        'Submit the form.',
        'Verify the user is authenticated.',
      ]
    )
  );

  return scenarios;
}

// --------------------------------------------------
// SCENARIO GENERATION
// --------------------------------------------------

function generateScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];

  let id = 1;

  // ==================================================
  // TODO / ENTITY CREATION
  // ==================================================

  const createTodo =
    hasCapability(
      'Create Todo',
      'Create Task'
    );

  if (createTodo) {
    scenarios.push(
      createScenario(
        id++,
        'Create Todo',
        'P0',
        'Positive',
        'User can create a new Todo/task successfully.',
        createTodo,
        [
          'Navigate to the application.',
          `Locate the discovered creation input using application discovery.`,
          'Enter valid Todo/task text.',
          'Submit the Todo/task.',
          'Verify the new entity appears in the application.',
        ]
      )
    );

    scenarios.push(
      createScenario(
        id++,
        'Create Multiple Todos',
        'P1',
        'Positive',
        'User can create multiple Todo/task entities.',
        createTodo,
        [
          'Navigate to the application.',
          'Create the first Todo/task.',
          'Create a second Todo/task.',
          'Verify both entities are displayed.',
          'Verify the entities remain distinct.',
        ]
      )
    );

    scenarios.push(
      createScenario(
        id++,
        'Create Empty Todo',
        'P1',
        'Negative',
        'Application handles an empty Todo/task submission correctly.',
        createTodo,
        [
          'Navigate to the application.',
          'Leave the creation input empty.',
          'Submit the Todo/task.',
          'Verify the application prevents or correctly handles empty input.',
        ]
      )
    );

    scenarios.push(
      createScenario(
        id++,
        'Create Todo With Special Characters',
        'P2',
        'Edge',
        'Application correctly handles special characters in Todo/task text.',
        createTodo,
        [
          'Navigate to the application.',
          'Enter Todo/task text containing special characters.',
          'Submit the entity.',
          'Verify the text is displayed correctly.',
        ]
      )
    );

    scenarios.push(
      createScenario(
        id++,
        'Create Very Long Todo',
        'P2',
        'Edge',
        'Application handles a very long Todo/task value.',
        createTodo,
        [
          'Navigate to the application.',
          'Enter a very long Todo/task value.',
          'Submit the entity.',
          'Verify the application remains stable.',
          'Verify the entity is displayed correctly.',
        ]
      )
    );
  }

  // ==================================================
  // COMPLETE / UPDATE STATE
  // ==================================================

  const completeTodo =
    hasCapability(
      'Complete Todo',
      'Complete Task',
      'Update Todo',
      'Update Task'
    );

  const completionWasExplored =
    hasDynamicEvidence(
      'DETECT_COMPLETED_STATE'
    );

  if (
    completeTodo ||
    (
      todoStructure.detected === true &&
      Boolean(
        todoStructure.checkbox
      )
    )
  ) {
    scenarios.push(
      createScenario(
        id++,
        'Complete Todo',
        'P1',
        'Positive',
        'User can mark a Todo/task as completed.',
        completeTodo,
        [
          'Navigate to the application.',
          'Create or locate a Todo/task.',
          `Locate the completion control using the discovered selector "${
            todoStructure.checkbox ||
            'discovered completion control'
          }".`,
          'Mark the Todo/task as completed.',
          `Verify the completed state ${
            todoStructure.completed
              ? `using "${todoStructure.completed}"`
              : 'using the discovered application state'
          }.`,
        ]
      )
    );
  }

  // ==================================================
  // DELETE
  // ==================================================

  const deleteTodo =
    hasCapability(
      'Delete Item',
      'Delete Todo',
      'Delete Task',
      'Remove Item',
      'Remove Todo'
    );

  if (
    deleteTodo ||
    (
      todoStructure.detected === true &&
      Boolean(
        todoStructure.delete
      )
    )
  ) {
    scenarios.push(
      createScenario(
        id++,
        'Delete Todo',
        'P1',
        'Positive',
        'User can delete/remove an existing Todo/task.',
        deleteTodo,
        [
          'Navigate to the application.',
          'Create or locate a Todo/task.',
          `Locate the delete control using the discovered selector "${
            todoStructure.delete ||
            'discovered delete control'
          }".`,
          'Delete the Todo/task.',
          'Verify the entity is no longer displayed.',
        ]
      )
    );
  }

  // ==================================================
  // AUTHENTICATION
  // ==================================================

  const authentication =
    hasCapability(
      'Authentication',
      'Login',
      'Sign In'
    );

  const login =
    applicationMap.loginStructure;

  if (
    authentication &&
    login?.detected === true
  ) {
    for (const scenario of loginScenarios(
      login,
      authentication
    )) {
      scenarios.push({
        ...scenario,
        id: id++,
      });
    }
  } else if (authentication) {
    scenarios.push(
      createScenario(
        id++,
        'Successful Login',
        'P0',
        'Positive',
        'User can authenticate with valid credentials.',
        authentication,
        [
          'Navigate to the login/authentication page.',
          'Enter valid credentials.',
          'Submit the authentication form.',
          'Verify successful authentication.',
        ]
      )
    );

    scenarios.push(
      createScenario(
        id++,
        'Invalid Credentials',
        'P0',
        'Negative',
        'Application rejects invalid authentication credentials.',
        authentication,
        [
          'Navigate to the login/authentication page.',
          'Enter invalid credentials.',
          'Submit the authentication form.',
          'Verify authentication is rejected.',
          'Verify an appropriate error is displayed.',
        ]
      )
    );

    scenarios.push(
      createScenario(
        id++,
        'Empty Credentials',
        'P1',
        'Negative',
        'Application validates empty authentication fields.',
        authentication,
        [
          'Navigate to the login/authentication page.',
          'Leave required fields empty.',
          'Submit the authentication form.',
          'Verify validation is displayed.',
        ]
      )
    );
  }

  // ==================================================
  // SEARCH
  // ==================================================

  const search =
    hasCapability(
      'Search'
    );

  if (search) {
    scenarios.push(
      createScenario(
        id++,
        'Search Valid Value',
        'P1',
        'Positive',
        'User can search using a valid value.',
        search,
        [
          'Navigate to the application.',
          'Locate the discovered search input.',
          'Enter a valid search value.',
          'Submit or trigger search.',
          'Verify relevant results are displayed.',
        ]
      )
    );

    scenarios.push(
      createScenario(
        id++,
        'Search Empty Value',
        'P2',
        'Edge',
        'Application handles an empty search correctly.',
        search,
        [
          'Navigate to the application.',
          'Leave the search input empty.',
          'Trigger search.',
          'Verify the application handles the empty search correctly.',
        ]
      )
    );
  }

  // ==================================================
  // PAYMENT
  // ==================================================

  const payment =
    hasCapability(
      'Payment',
      'Checkout'
    );

  if (payment) {
    scenarios.push(
      createScenario(
        id++,
        'Successful Payment',
        'P0',
        'Positive',
        'User can complete a valid payment flow.',
        payment,
        [
          'Navigate to the payment/checkout flow.',
          'Enter valid payment information.',
          'Submit the payment.',
          'Verify successful payment confirmation.',
        ]
      )
    );

    scenarios.push(
      createScenario(
        id++,
        'Invalid Payment',
        'P0',
        'Negative',
        'Application handles invalid payment information correctly.',
        payment,
        [
          'Navigate to the payment/checkout flow.',
          'Enter invalid payment information.',
          'Submit the payment.',
          'Verify payment is rejected.',
          'Verify an appropriate error is displayed.',
        ]
      )
    );

    scenarios.push(
      createScenario(
        id++,
        'Payment Failure',
        'P0',
        'Negative',
        'Application handles a payment service failure correctly.',
        payment,
        [
          'Navigate to the payment/checkout flow.',
          'Simulate or trigger payment service failure.',
          'Submit the payment.',
          'Verify the application handles the failure gracefully.',
        ]
      )
    );

    scenarios.push(
      createScenario(
        id++,
        'Payment Retry',
        'P1',
        'Edge',
        'User can retry a failed payment safely.',
        payment,
        [
          'Navigate to the payment/checkout flow.',
          'Trigger a payment failure.',
          'Retry the payment.',
          'Verify the retry is handled correctly.',
          'Verify duplicate charging does not occur.',
        ]
      )
    );
  }

  return scenarios;
}

// --------------------------------------------------
// GENERATE
// --------------------------------------------------

const scenarios =
  generateScenarios();

const mapping: ScenarioMapping = {
  generatedAt:
    new Date().toISOString(),

  requirement,

  application: {
    title:
      applicationTitle,
    url:
      applicationUrl,
    framework,
  },

  discovery: {
    exploratory,
    capabilitiesDetected:
      capabilities.length,
    todoStructureDetected:
      todoStructure.detected === true,
  },

  scenarios,

  summary: {
    total:
      scenarios.length,

    p0:
      scenarios.filter(
        (scenario) =>
          scenario.priority ===
          'P0'
      ).length,

    p1:
      scenarios.filter(
        (scenario) =>
          scenario.priority ===
          'P1'
      ).length,

    p2:
      scenarios.filter(
        (scenario) =>
          scenario.priority ===
          'P2'
      ).length,
  },
};

// --------------------------------------------------
// SAVE
// --------------------------------------------------

fs.writeFileSync(
  outputFile,
  JSON.stringify(
    mapping,
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
  'QYNTRA APPLICATION-AWARE SCENARIO MAPPER'
);
console.log(
  '======================================'
);
console.log('');

console.log(
  `Application : ${applicationTitle}`
);

console.log(
  `URL         : ${applicationUrl}`
);

console.log(
  `Framework   : ${framework}`
);

console.log(
  `Exploratory : ${
    exploratory
      ? 'YES'
      : 'NO'
  }`
);

console.log('');

console.log(
  'DISCOVERED CAPABILITIES'
);

if (
  capabilities.length === 0
) {
  console.log(
    '• None'
  );
} else {
  for (
    const capability of
      capabilities
  ) {
    console.log(
      `✓ ${capability.name} (${capability.confidence || 'unknown'})`
    );
  }
}

console.log('');

console.log(
  'DISCOVERED TODO STRUCTURE'
);

if (
  todoStructure.detected
) {
  console.log(
    `Container   : ${
      todoStructure.container ||
      'N/A'
    }`
  );

  console.log(
    `Item        : ${
      todoStructure.item ||
      'N/A'
    }`
  );

  console.log(
    `Complete    : ${
      todoStructure.checkbox ||
      'N/A'
    }`
  );

  console.log(
    `Delete      : ${
      todoStructure.delete ||
      'N/A'
    }`
  );

  console.log(
    `Completed   : ${
      todoStructure.completed ||
      'N/A'
    }`
  );
} else {
  console.log(
    'Not detected'
  );
}

console.log('');

console.log(
  'GENERATED SCENARIOS'
);

for (
  const scenario of scenarios
) {
  console.log(
    `${scenario.priority} ${scenario.title} [${scenario.type}]`
  );

  console.log(
    `   └─ ${scenario.mappedCapability}`
  );
}

console.log('');

console.log(
  'SCENARIO SUMMARY'
);

console.log(
  `Total : ${mapping.summary.total}`
);

console.log(
  `P0    : ${mapping.summary.p0}`
);

console.log(
  `P1    : ${mapping.summary.p1}`
);

console.log(
  `P2    : ${mapping.summary.p2}`
);

console.log('');

console.log(
  '✓ Scenario mapping saved'
);

console.log(
  outputFile
);

console.log('');

console.log(
  '======================================'
);

