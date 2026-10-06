
import { chromium, type Browser, type Page } from '@playwright/test';
import fs from 'fs';

import { stagePaths } from './lib/paths';
import { BROWSER_PROFILE } from './lib/auth';
import {
  detectLoginForm,
  probeLoginForm,
  type LoginStructure,
} from './lib/login-discovery';

interface ElementInfo {
  [key: string]: unknown;
}

interface DiscoveryAction {
  action: string;
  status: 'passed' | 'failed' | 'skipped';
  evidence?: string;
  error?: string;
}

interface TodoStructure {
  detected: boolean;
  container: string | null;
  item: string | null;
  checkbox: string | null;
  delete: string | null;
  completed: string | null;
}

interface ApplicationMap {
  generatedAt: string;

  application: {
    title: string;
    url: string;
    framework: string;
    frameworkHints: string[];
  };

  headings: ElementInfo[];
  links: ElementInfo[];
  buttons: ElementInfo[];
  inputs: ElementInfo[];
  textareas: ElementInfo[];
  selects: ElementInfo[];
  checkboxes: ElementInfo[];
  interactiveElements: ElementInfo[];

  capabilities: ElementInfo[];

  todoStructure: TodoStructure;

  loginStructure: LoginStructure;

  dynamicDiscovery: {
    enabled: boolean;
    actions: DiscoveryAction[];
  };

  network: {
    requests: string[];
    apiEndpoints: string[];
  };

  metadata: {
    forms: number;
    authenticationIndicators: string[];
    paymentIndicators: string[];
  };
}

// --------------------------------------------------
// CLI ARGUMENTS
// --------------------------------------------------

const args = process.argv.slice(2);

const requestedUrl = args.find(
  (arg) => !arg.startsWith('--')
);

const explore = args.includes('--explore');

if (!requestedUrl) {
  console.error('');
  console.error(
    'Usage: npm run discover -- "https://example.com" [--explore]'
  );
  console.error('');
  process.exit(1);
}

const url = requestedUrl;

// --------------------------------------------------
// GLOBAL RUNTIME STATE
// --------------------------------------------------

let browser: Browser | null = null;
let page: Page | null = null;

const networkRequests = new Set<string>();
const apiEndpoints = new Set<string>();

const paths = stagePaths();

const outputDir = paths.outputDir;
const outputFile = paths.applicationMap;

fs.mkdirSync(outputDir, {
  recursive: true,
});

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function escapeForSelector(
  value: string
): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function selectorFromAttributes(
  tag: string,
  id?: string | null,
  name?: string | null,
  ariaLabel?: string | null,
  placeholder?: string | null,
  type?: string | null
): string {
  if (id) {
    return `#${escapeForSelector(id)}`;
  }

  if (name) {
    return `${tag}[name='${escapeForSelector(name)}']`;
  }

  if (ariaLabel) {
    return `${tag}[aria-label='${escapeForSelector(
      ariaLabel
    )}']`;
  }

  if (placeholder) {
    return `${tag}[placeholder='${escapeForSelector(
      placeholder
    )}']`;
  }

  if (type && tag === 'input') {
    return `${tag}[type='${escapeForSelector(
      type
    )}']`;
  }

  return tag;
}

function inferPurpose(
  value = '',
  type = '',
  placeholder = '',
  ariaLabel = '',
  name = ''
): string {
  const text = [
    value,
    type,
    placeholder,
    ariaLabel,
    name,
  ]
    .join(' ')
    .toLowerCase();

  if (
    type === 'email' ||
    text.includes('email')
  ) {
    return 'EMAIL_INPUT';
  }

  if (
    type === 'password' ||
    text.includes('password')
  ) {
    return 'PASSWORD_INPUT';
  }

  if (
    type === 'search' ||
    text.includes('search')
  ) {
    return 'SEARCH_INPUT';
  }

  if (
    text.includes('todo') ||
    text.includes('task') ||
    text.includes('what needs to be done')
  ) {
    return 'CREATE_TODO';
  }

  if (
    text.includes('phone') ||
    text.includes('mobile')
  ) {
    return 'PHONE_INPUT';
  }

  if (
    text.includes('username') ||
    text.includes('name')
  ) {
    return 'NAME_INPUT';
  }

  if (
    text.includes('amount') ||
    text.includes('price') ||
    text.includes('money')
  ) {
    return 'AMOUNT_INPUT';
  }

  return 'TEXT_INPUT';
}

// --------------------------------------------------
// FRAMEWORK DETECTION
// --------------------------------------------------

async function detectFramework(
  currentPage: Page
): Promise<{
  framework: string;
  hints: string[];
}> {
  const result = await currentPage.evaluate(() => {
    const detected: string[] = [];

    const html = document.documentElement.outerHTML;
    const htmlLower = html.toLowerCase();

    // --------------------------------------------------
    // REACT
    // --------------------------------------------------

    // React 18/19 commonly uses a root container without
    // the old data-reactroot attribute.
    const reactRoot =
      document.querySelector('#root') ||
      document.querySelector('#app') ||
      document.querySelector('[data-reactroot]');

    if (reactRoot) {
      const element = reactRoot as HTMLElement;

      const hasReactProperty = Object.keys(element).some(
        (key) =>
          key.startsWith('__reactFiber$') ||
          key.startsWith('__reactProps$') ||
          key.startsWith('__reactContainer$')
      );

      if (hasReactProperty) {
        detected.push(
          'React runtime property detected on application root'
        );
      } else {
        detected.push(
          'React-like application root detected'
        );
      }
    }

    // React runtime properties can exist on any DOM node.
    const allElements = Array.from(
      document.querySelectorAll('*')
    );

    let reactRuntimeDetected = false;

    for (const element of allElements) {
      const keys = Object.keys(element);

      if (
        keys.some(
          (key) =>
            key.startsWith('__reactFiber$') ||
            key.startsWith('__reactProps$') ||
            key.startsWith('__reactContainer$')
        )
      ) {
        reactRuntimeDetected = true;
        break;
      }
    }

    if (reactRuntimeDetected) {
      detected.push(
        'React runtime markers detected in DOM'
      );
    }

    // React-generated development attributes / common
    // React ecosystem evidence.
    if (
      htmlLower.includes('__react') ||
      htmlLower.includes('react-dom') ||
      htmlLower.includes('react.production') ||
      htmlLower.includes('react.development')
    ) {
      detected.push(
        'React runtime reference detected in page markup'
      );
    }

    // --------------------------------------------------
    // ANGULAR
    // --------------------------------------------------

    if (
      document.querySelector('[ng-version]') ||
      document.querySelector('[ng-app]')
    ) {
      detected.push(
        'Angular markers detected'
      );
    }

    const angularElement = document.querySelector(
      '[ng-version], [_nghost-], [_ngcontent-]'
    );

    if (angularElement) {
      detected.push(
        'Angular component attributes detected'
      );
    }

    if (
      htmlLower.includes('angular') ||
      htmlLower.includes('ng-version')
    ) {
      detected.push(
        'Angular runtime reference detected'
      );
    }

    // --------------------------------------------------
    // VUE
    // --------------------------------------------------

    if (
      document.querySelector('[data-v-app]')
    ) {
      detected.push(
        'Vue application marker detected'
      );
    }

    if (
      document.querySelector(
        '[data-v-]'
      )
    ) {
      detected.push(
        'Vue scoped-style attribute detected'
      );
    }

    if (
      htmlLower.includes('__vue') ||
      htmlLower.includes('vue.runtime') ||
      htmlLower.includes('vue.global')
    ) {
      detected.push(
        'Vue runtime reference detected'
      );
    }

    // --------------------------------------------------
    // SCRIPT ANALYSIS
    // --------------------------------------------------

    const scripts = Array.from(
      document.querySelectorAll(
        'script[src]'
      )
    );

    for (const script of scripts) {
      const src =
        script.getAttribute('src') || '';

      const lower = src.toLowerCase();

      if (
        lower.includes('react') ||
        lower.includes('react-dom')
      ) {
        detected.push(
          'React script reference detected'
        );
      }

      if (
        lower.includes('angular')
      ) {
        detected.push(
          'Angular script reference detected'
        );
      }

      if (
        lower.includes('vue')
      ) {
        detected.push(
          'Vue script reference detected'
        );
      }
    }

    // --------------------------------------------------
    // APPLICATION-SPECIFIC EVIDENCE
    // --------------------------------------------------

    // Some known framework demo applications expose
    // their framework through title/content rather than
    // runtime DOM markers.
    const title =
      document.title.toLowerCase();

    if (
      title.includes('react')
    ) {
      detected.push(
        'React reference detected in document title'
      );
    }

    if (
      title.includes('angular')
    ) {
      detected.push(
        'Angular reference detected in document title'
      );
    }

    if (
      title.includes('vue')
    ) {
      detected.push(
        'Vue reference detected in document title'
      );
    }

    return detected;
  });

  const uniqueHints = [
    ...new Set(result),
  ];

  // --------------------------------------------------
  // FRAMEWORK DECISION
  // --------------------------------------------------

  const hasReact = uniqueHints.some(
    (hint) =>
      hint.toLowerCase().includes('react')
  );

  const hasAngular = uniqueHints.some(
    (hint) =>
      hint.toLowerCase().includes('angular')
  );

  const hasVue = uniqueHints.some(
    (hint) =>
      hint.toLowerCase().includes('vue')
  );

  // Prefer the framework with the strongest runtime
  // evidence when multiple hints are present.
  if (hasReact) {
    return {
      framework: 'React',
      hints: uniqueHints,
    };
  }

  if (hasAngular) {
    return {
      framework: 'Angular',
      hints: uniqueHints,
    };
  }

  if (hasVue) {
    return {
      framework: 'Vue',
      hints: uniqueHints,
    };
  }

  return {
    framework: 'Unknown',
    hints: uniqueHints,
  };
}

// --------------------------------------------------
// TODO STRUCTURE DETECTION
// --------------------------------------------------

async function detectTodoStructure(
  currentPage: Page
): Promise<TodoStructure> {
  const items = currentPage.locator('li');

  const itemCount =
    await items.count();

  if (itemCount === 0) {
    return {
      detected: false,
      container: null,
      item: null,
      checkbox: null,
      delete: null,
      completed: null,
    };
  }

  const firstItem =
    items.first();

  let checkboxSelector:
    | string
    | null = null;

  let deleteSelector:
    | string
    | null = null;

  const checkbox =
    firstItem.locator(
      'input[type="checkbox"], .toggle'
    );

  if (
    await checkbox.count()
  ) {
    const data =
      await checkbox.first().evaluate(
        (element) => ({
          id: element.id || '',
          ariaLabel:
            element.getAttribute(
              'aria-label'
            ) || '',
          className:
            element.getAttribute(
              'class'
            ) || '',
        })
      );

    if (data.id) {
      checkboxSelector =
        `#${escapeForSelector(
          data.id
        )}`;
    } else if (data.ariaLabel) {
      checkboxSelector =
        `input[aria-label='${escapeForSelector(
          data.ariaLabel
        )}']`;
    } else if (data.className) {
      checkboxSelector =
        `.${data.className
          .split(/\s+/)
          .filter(Boolean)
          .join('.')}`;
    }
  }

  const deleteButton =
    firstItem.locator(
      'button.destroy'
    );

  if (
    await deleteButton.count()
  ) {
    const data =
      await deleteButton.first().evaluate(
        (element) => ({
          tag:
            element.tagName.toLowerCase(),
          className:
            element.getAttribute(
              'class'
            ) || '',
          ariaLabel:
            element.getAttribute(
              'aria-label'
            ) || '',
        })
      );

    if (data.className) {
      deleteSelector =
        `${data.tag}.${data.className
          .split(/\s+/)
          .filter(Boolean)
          .join('.')}`;
    } else if (data.ariaLabel) {
      deleteSelector =
        `${data.tag}[aria-label='${escapeForSelector(
          data.ariaLabel
        )}']`;
    }
  }

  // Any <li> — a nav menu, a footer — used to count as a todo list and
  // produced todo tests for login pages. Require a control in the item.
  const hasItemControls =
    (await checkbox.count()) > 0 ||
    (await deleteButton.count()) > 0;

  if (!hasItemControls) {
    return {
      detected: false,
      container: null,
      item: null,
      checkbox: null,
      delete: null,
      completed: null,
    };
  }

  return {
    detected: true,
    container: 'ul',
    item: 'li',
    checkbox:
      checkboxSelector ||
      'input.toggle',
    delete:
      deleteSelector ||
      'button.destroy',
    completed:
      'li.completed',
  };
}

// --------------------------------------------------
// STATIC DISCOVERY
// --------------------------------------------------

async function discoverStatic(
  currentPage: Page
): Promise<{
  headings: ElementInfo[];
  links: ElementInfo[];
  buttons: ElementInfo[];
  inputs: ElementInfo[];
  textareas: ElementInfo[];
  selects: ElementInfo[];
  checkboxes: ElementInfo[];
  interactiveElements: ElementInfo[];
  capabilities: ElementInfo[];
  todoStructure: TodoStructure;
  metadata: ApplicationMap['metadata'];
}> {
  const headings =
    await currentPage
      .locator(
        'h1,h2,h3,h4,h5,h6'
      )
      .evaluateAll(
        (elements) =>
          elements.map(
            (element) => ({
              level:
                element.tagName.toLowerCase(),
              text:
                element.textContent
                  ?.trim() || '',
            })
          )
      );

  const links =
    await currentPage
      .locator('a')
      .evaluateAll(
        (elements) =>
          elements.map(
            (element) => ({
              text:
                element.textContent
                  ?.trim() || '',
              href:
                element.getAttribute(
                  'href'
                ) || '',
              ariaLabel:
                element.getAttribute(
                  'aria-label'
                ) || '',
            })
          )
      );

  const buttonRaw =
    await currentPage
      .locator(
        'button,input[type="button"],input[type="submit"]'
      )
      .evaluateAll(
        (elements) =>
          elements.map(
            (element) => ({
              tag:
                element.tagName.toLowerCase(),
              text:
                element.textContent
                  ?.trim() || '',
              ariaLabel:
                element.getAttribute(
                  'aria-label'
                ) || '',
              type:
                element.getAttribute(
                  'type'
                ) || '',
              id:
                element.id || '',
              name:
                element.getAttribute(
                  'name'
                ) || '',
            })
          )
      );

  const buttons =
    buttonRaw.map(
      (button) => ({
        ...button,

        selector:
          selectorFromAttributes(
            button.tag,
            button.id,
            button.name,
            button.ariaLabel,
            null,
            button.type
          ),

        purpose:
          inferPurpose(
            button.text,
            button.type,
            '',
            button.ariaLabel,
            button.name
          ),
      })
    );

  const inputRaw =
    await currentPage
      .locator('input')
      .evaluateAll(
        (elements) =>
          elements.map(
            (element) => ({
              type:
                element.getAttribute(
                  'type'
                ) || 'text',

              name:
                element.getAttribute(
                  'name'
                ) || '',

              placeholder:
                element.getAttribute(
                  'placeholder'
                ) || '',

              ariaLabel:
                element.getAttribute(
                  'aria-label'
                ) || '',

              id:
                element.id || '',

              value:
                (
                  element as HTMLInputElement
                ).value || '',
            })
          )
      );

  const inputs =
    inputRaw.map(
      (input) => ({
        ...input,

        selector:
          selectorFromAttributes(
            'input',
            input.id,
            input.name,
            input.ariaLabel,
            input.placeholder,
            input.type
          ),

        purpose:
          inferPurpose(
            input.value,
            input.type,
            input.placeholder,
            input.ariaLabel,
            input.name
          ),
      })
    );

  const textareaRaw =
    await currentPage
      .locator('textarea')
      .evaluateAll(
        (elements) =>
          elements.map(
            (element) => ({
              placeholder:
                element.getAttribute(
                  'placeholder'
                ) || '',

              ariaLabel:
                element.getAttribute(
                  'aria-label'
                ) || '',

              id:
                element.id || '',

              name:
                element.getAttribute(
                  'name'
                ) || '',
            })
          )
      );

  const textareas =
    textareaRaw.map(
      (textarea) => ({
        ...textarea,

        selector:
          selectorFromAttributes(
            'textarea',
            textarea.id,
            textarea.name,
            textarea.ariaLabel,
            textarea.placeholder
          ),

        purpose:
          'TEXT_INPUT',
      })
    );

  const selectRaw =
    await currentPage
      .locator('select')
      .evaluateAll(
        (elements) =>
          elements.map(
            (element) => ({
              id:
                element.id || '',

              name:
                element.getAttribute(
                  'name'
                ) || '',

              ariaLabel:
                element.getAttribute(
                  'aria-label'
                ) || '',
            })
          )
      );

  const selects =
    selectRaw.map(
      (select) => ({
        ...select,

        selector:
          selectorFromAttributes(
            'select',
            select.id,
            select.name,
            select.ariaLabel
          ),
      })
    );

  const checkboxRaw =
    await currentPage
      .locator(
        'input[type="checkbox"]'
      )
      .evaluateAll(
        (elements) =>
          elements.map(
            (element) => ({
              id:
                element.id || '',

              name:
                element.getAttribute(
                  'name'
                ) || '',

              ariaLabel:
                element.getAttribute(
                  'aria-label'
                ) || '',

              checked:
                (
                  element as HTMLInputElement
                ).checked,

              className:
                element.getAttribute(
                  'class'
                ) || '',
            })
          )
      );

  const checkboxes =
    checkboxRaw.map(
      (checkbox) => ({
        ...checkbox,

        selector:
          selectorFromAttributes(
            'input',
            checkbox.id,
            checkbox.name,
            checkbox.ariaLabel,
            null,
            'checkbox'
          ),

        purpose:
          'CHECKBOX',
      })
    );

  const interactiveElements = [
    ...inputs.map(
      (item) => ({
        ...item,
        type: 'input',
      })
    ),

    ...buttons.map(
      (item) => ({
        ...item,
        type: 'button',
      })
    ),

    ...checkboxes.map(
      (item) => ({
        ...item,
        type: 'checkbox',
      })
    ),

    ...textareas.map(
      (item) => ({
        ...item,
        type: 'textarea',
      })
    ),

    ...selects.map(
      (item) => ({
        ...item,
        type: 'select',
      })
    ),
  ];

  const bodyText =
    (
      await currentPage
        .locator('body')
        .innerText()
    ).toLowerCase();

  const capabilities:
    ElementInfo[] = [];

  const todoInput =
    inputs.find(
      (input) =>
        input.purpose ===
        'CREATE_TODO'
    );

  if (
    todoInput ||
    bodyText.includes('todo') ||
    bodyText.includes('task')
  ) {
    capabilities.push({
      name: 'Create Todo',
      confidence:
        todoInput
          ? 'high'
          : 'medium',
      evidence:
        todoInput
          ? 'Todo-related input detected'
          : 'Todo-related page content detected',
    });
  }

  // A checkbox alone is not todo evidence: login pages have
  // "Remember me", which once became a "Complete Todo" scenario.
  const todoEvidence =
    Boolean(todoInput) ||
    bodyText.includes('todo') ||
    bodyText.includes('task');

  if (
    todoEvidence &&
    (
      checkboxes.length > 0 ||
      bodyText.includes('complete')
    )
  ) {
    capabilities.push({
      name: 'Complete Todo',
      confidence: 'medium',
      evidence:
        'Checkbox or completion-related content detected',
    });
  }

  if (
    bodyText.includes('delete') ||
    bodyText.includes('remove')
  ) {
    capabilities.push({
      name: 'Delete Item',
      confidence: 'medium',
      evidence:
        'Delete/remove-related content detected',
    });
  }

  const authenticationIndicators = [
    'login',
    'log in',
    'sign in',
    'password',
    'username',
    'authentication',
  ].filter(
    (keyword) =>
      bodyText.includes(keyword)
  );

  if (
    authenticationIndicators.length > 0
  ) {
    capabilities.push({
      name: 'Authentication',
      confidence: 'medium',
      evidence:
        authenticationIndicators.join(
          ', '
        ),
    });
  }

  const searchDetected =
    inputs.some(
      (input) =>
        input.purpose ===
        'SEARCH_INPUT'
    ) ||
    bodyText.includes('search');

  if (searchDetected) {
    capabilities.push({
      name: 'Search',
      confidence: 'medium',
      evidence:
        'Search input or search content detected',
    });
  }

  const paymentIndicators = [
    'payment',
    'checkout',
    'credit card',
    'debit card',
    'cvv',
    'transaction',
    'billing',
  ].filter(
    (keyword) =>
      bodyText.includes(keyword)
  );

  if (
    paymentIndicators.length > 0
  ) {
    capabilities.push({
      name: 'Payment',
      confidence: 'medium',
      evidence:
        paymentIndicators.join(
          ', '
        ),
    });
  }

  const forms =
    await currentPage
      .locator('form')
      .count();

  const todoStructure =
    await detectTodoStructure(
      currentPage
    );

  return {
    headings,
    links,
    buttons,
    inputs,
    textareas,
    selects,
    checkboxes,
    interactiveElements,
    capabilities,
    todoStructure,

    metadata: {
      forms,
      authenticationIndicators,
      paymentIndicators,
    },
  };
}

// --------------------------------------------------
// FIND SAFE TODO INPUT
// --------------------------------------------------

async function findTodoInput(
  currentPage: Page
) {
  const candidates = [
    currentPage.locator(
      'input[placeholder*="What needs to be done" i]'
    ),

    currentPage.locator(
      'input[placeholder*="todo" i]'
    ),

    currentPage.locator(
      'input[placeholder*="task" i]'
    ),

    currentPage.locator(
      'input[aria-label*="todo" i]'
    ),

    currentPage.locator(
      'input[type="text"]'
    ),
  ];

  for (
    const candidate of candidates
  ) {
    if (
      await candidate.count()
    ) {
      return candidate.first();
    }
  }

  return null;
}

// --------------------------------------------------
// EXPLORATORY DISCOVERY
// --------------------------------------------------

async function exploratoryDiscovery(
  currentPage: Page
): Promise<DiscoveryAction[]> {
  const actions:
    DiscoveryAction[] = [];

  console.log('');
  console.log(
    '--------------------------------------'
  );
  console.log(
    'EXPLORATORY DISCOVERY'
  );
  console.log(
    '--------------------------------------'
  );

  const todoInput =
    await findTodoInput(
      currentPage
    );

  if (!todoInput) {
    actions.push({
      action:
        'CREATE_ENTITY',
      status:
        'skipped',
      evidence:
        'No safe Todo/task input could be identified.',
    });

    console.log(
      '⚠ Temporary Todo creation skipped'
    );

    return actions;
  }

  const temporaryTodo =
    `__QYNTRA_DISCOVERY__${Date.now()}`;

  // ----------------------------------------------
  // CREATE
  // ----------------------------------------------

  try {
    await todoInput.fill(
      temporaryTodo
    );

    await todoInput.press(
      'Enter'
    );

    const temporaryItem =
      currentPage
        .locator('li')
        .filter({
          hasText:
            temporaryTodo,
        })
        .first();

    await temporaryItem.waitFor({
      state: 'visible',
      timeout: 5000,
    });

    actions.push({
      action:
        'CREATE_ENTITY',
      status:
        'passed',
      evidence:
        `Created temporary Todo "${temporaryTodo}"`,
    });

    console.log(
      '✓ Temporary Todo created'
    );
  } catch (error) {
    actions.push({
      action:
        'CREATE_ENTITY',
      status:
        'failed',
      error:
        String(error),
    });

    console.log(
      '✗ Temporary Todo creation failed'
    );

    return actions;
  }

  // ----------------------------------------------
  // DETECT ITEM
  // ----------------------------------------------

  const todoItem =
    currentPage
      .locator('li')
      .filter({
        hasText:
          temporaryTodo,
      })
      .first();

  if (
    await todoItem.count()
  ) {
    actions.push({
      action:
        'DETECT_ENTITY',
      status:
        'passed',
      evidence:
        'Todo entity discovered using li + text filtering.',
    });

    console.log(
      '✓ Todo item discovered'
    );
  } else {
    actions.push({
      action:
        'DETECT_ENTITY',
      status:
        'failed',
      error:
        'Temporary Todo was created but could not be located.',
    });

    return actions;
  }

  // ----------------------------------------------
  // DETECT CHECKBOX
  // ----------------------------------------------

  const checkbox =
    todoItem.locator(
      'input[type="checkbox"], .toggle'
    );

  if (
    await checkbox.count()
  ) {
    actions.push({
      action:
        'DETECT_COMPLETE_CONTROL',
      status:
        'passed',
      evidence:
        'Checkbox/toggle control discovered inside Todo item.',
    });

    console.log(
      '✓ Checkbox discovered'
    );
  } else {
    actions.push({
      action:
        'DETECT_COMPLETE_CONTROL',
      status:
        'failed',
      error:
        'No checkbox/toggle discovered inside Todo item.',
    });

    console.log(
      '✗ Checkbox not discovered'
    );
  }

  // ----------------------------------------------
  // TEST COMPLETION
  // ----------------------------------------------

  if (
    await checkbox.count()
  ) {
    try {
      await checkbox
        .first()
        .check();

      await currentPage.waitForTimeout(
        200
      );

      const completed =
        await todoItem.evaluate(
          (element) =>
            element.classList.contains(
              'completed'
            )
        );

      if (completed) {
        actions.push({
          action:
            'DETECT_COMPLETED_STATE',
          status:
            'passed',
          evidence:
            'Completing the Todo adds the "completed" class.',
        });

        console.log(
          '✓ Completion state discovered'
        );
      } else {
        actions.push({
          action:
            'DETECT_COMPLETED_STATE',
          status:
            'passed',
          evidence:
            'Checkbox successfully changed completion state.',
        });

        console.log(
          '✓ Completion behavior discovered'
        );
      }
    } catch (error) {
      actions.push({
        action:
          'DETECT_COMPLETED_STATE',
        status:
          'failed',
        error:
          String(error),
      });

      console.log(
        '✗ Completion state detection failed'
      );
    }
  } else {
    actions.push({
      action:
        'DETECT_COMPLETED_STATE',
      status:
        'skipped',
      evidence:
        'Skipped because completion control was not discovered.',
    });
  }

  // ----------------------------------------------
  // DETECT DELETE
  // ----------------------------------------------

  const deleteButton =
    todoItem.locator(
      'button.destroy'
    );

  if (
    await deleteButton.count()
  ) {
    actions.push({
      action:
        'DETECT_DELETE_CONTROL',
      status:
        'passed',
      evidence:
        'button.destroy discovered inside Todo item.',
    });

    console.log(
      '✓ Delete control discovered'
    );
  } else {
    const genericButton =
      todoItem.getByRole(
        'button'
      );

    if (
      await genericButton.count()
    ) {
      actions.push({
        action:
          'DETECT_DELETE_CONTROL',
        status:
          'passed',
        evidence:
          'Generic button discovered inside Todo item.',
      });

      console.log(
        '✓ Delete control discovered'
      );
    } else {
      actions.push({
        action:
          'DETECT_DELETE_CONTROL',
        status:
          'failed',
        error:
          'No delete control discovered inside Todo item.',
      });

      console.log(
        '✗ Delete control not discovered'
      );
    }
  }

  // ----------------------------------------------
  // CLEANUP
  // ----------------------------------------------

  try {
    if (
      await deleteButton.count()
    ) {
      await todoItem.hover();

      await deleteButton
        .first()
        .click();
    } else {
      const genericButton =
        todoItem.getByRole(
          'button'
        );

      if (
        await genericButton.count()
      ) {
        await todoItem.hover();

        await genericButton
          .last()
          .click();
      }
    }

    await todoItem.waitFor({
      state: 'detached',
      timeout: 5000,
    });

    actions.push({
      action:
        'CLEANUP',
      status:
        'passed',
      evidence:
        'Temporary Todo successfully removed.',
    });

    console.log(
      '✓ Temporary Todo cleaned up'
    );
  } catch (error) {
    actions.push({
      action:
        'CLEANUP',
      status:
        'failed',
      error:
        String(error),
    });

    console.log(
      '⚠ Temporary Todo cleanup failed'
    );
  }

  return actions;
}

// --------------------------------------------------
// MAIN
// --------------------------------------------------

async function main(): Promise<void> {
  console.log('');
  console.log(
    '======================================'
  );
  console.log(
    'QYNTRA DEEP APPLICATION DISCOVERY'
  );
  console.log(
    '======================================'
  );
  console.log('');

  console.log(
    `URL         : ${url}`
  );

  console.log(
    `MODE        : ${
      explore
        ? 'EXPLORATORY'
        : 'READ_ONLY'
    }`
  );

  console.log('');

  // ----------------------------------------------
  // BROWSER
  // ----------------------------------------------

  browser =
    await chromium.launch({
      headless: true,
    });

  // The CLI logs in first for apps behind authentication and hands the
  // session over here; without it discovery would only see the login page.
  const storageState =
    process.env.QYNTRA_STORAGE_STATE;

  if (storageState) {
    console.log(
      `SESSION     : authenticated (${storageState})`
    );
  }

  const context =
    await browser.newContext({
      ...BROWSER_PROFILE,
      storageState,
    });

  page =
    await context.newPage();

  // ----------------------------------------------
  // NETWORK CAPTURE
  // ----------------------------------------------

  page.on(
    'request',
    (request) => {
      const resourceType =
        request.resourceType();

      if (
        resourceType === 'xhr' ||
        resourceType === 'fetch'
      ) {
        networkRequests.add(
          request.url()
        );
      }
    }
  );

  // ----------------------------------------------
  // OPEN APPLICATION
  // ----------------------------------------------

  await page.goto(
    url,
    {
      waitUntil:
        'domcontentloaded',
      timeout: 30000,
    }
  );

  await page
    .waitForLoadState(
      'networkidle',
      {
        timeout: 10000,
      }
    )
    .catch(() => {
      // Some applications never become network idle.
    });

  const title =
    await page.title();

  // ----------------------------------------------
  // FRAMEWORK
  // ----------------------------------------------

  const frameworkInfo =
    await detectFramework(
      page
    );

  // ----------------------------------------------
  // STATIC DISCOVERY
  // ----------------------------------------------

  let staticData =
    await discoverStatic(
      page
    );

  // ----------------------------------------------
  // EXPLORATORY MODE
  // ----------------------------------------------

  let dynamicActions:
    DiscoveryAction[] = [];

  if (explore) {
    dynamicActions =
      await exploratoryDiscovery(
        page
      );

    /*
     * The temporary Todo has now been removed.
     *
     * We still preserve the structure discovered
     * during exploratory interaction because this
     * is exactly the information we want Qyntra
     * to learn.
     */

    const entityDiscovered =
      dynamicActions.some(
        (action) =>
          action.action ===
            'DETECT_ENTITY' &&
          action.status ===
            'passed'
      );

    const completionDiscovered =
      dynamicActions.some(
        (action) =>
          action.action ===
            'DETECT_COMPLETED_STATE' &&
          action.status ===
            'passed'
      );

    const deleteDiscovered =
      dynamicActions.some(
        (action) =>
          action.action ===
            'DETECT_DELETE_CONTROL' &&
          action.status ===
            'passed'
      );

    if (entityDiscovered) {
      staticData.todoStructure = {
        detected: true,
        container: 'ul',
        item: 'li',
        checkbox:
          'input.toggle',
        delete:
          'button.destroy',
        completed:
          completionDiscovered
            ? 'li.completed'
            : null,
      };
    }

    const existingCapabilities =
      staticData.capabilities.map(
        (capability) =>
          String(
            capability.name
          )
      );

    if (
      completionDiscovered &&
      !existingCapabilities.includes(
        'Complete Todo'
      )
    ) {
      staticData.capabilities.push({
        name:
          'Complete Todo',
        confidence:
          'high',
        evidence:
          'Completion control and completion behavior discovered during exploratory interaction.',
      });
    }

    if (
      deleteDiscovered &&
      !existingCapabilities.includes(
        'Delete Item'
      )
    ) {
      staticData.capabilities.push({
        name:
          'Delete Item',
        confidence:
          'high',
        evidence:
          'Delete control discovered during exploratory interaction.',
      });
    }
  }

  // ----------------------------------------------
  // LOGIN FORM
  // ----------------------------------------------

  // Structural detection, then two probes that submit nothing a real
  // account could match. Tests are later generated only from what the
  // probes observed.
  let loginStructure =
    await detectLoginForm(
      page,
      page.url()
    );

  if (loginStructure.detected) {
    console.log(
      'LOGIN FORM  : detected — probing with an empty and an invalid submit'
    );

    loginStructure =
      await probeLoginForm(
        page,
        url,
        loginStructure
      );

    const authentication =
      staticData.capabilities.find(
        (capability) =>
          capability.name ===
          'Authentication'
      );

    const authEvidence =
      loginStructure.evidence.join(
        '; '
      );

    if (authentication) {
      authentication.confidence =
        'high';
      authentication.evidence =
        authEvidence;
    } else {
      staticData.capabilities.push({
        name:
          'Authentication',
        confidence:
          'high',
        evidence:
          authEvidence,
      });
    }
  }

  // ----------------------------------------------
  // NETWORK ANALYSIS
  // ----------------------------------------------

  const networkList =
    [
      ...networkRequests,
    ];

  for (
    const request of networkList
  ) {
    try {
      const parsed =
        new URL(request);

      const pathname =
        parsed.pathname;

      if (
        pathname !== '/' &&
        (
          pathname.includes(
            '/api/'
          ) ||
          pathname.includes(
            '/graphql'
          ) ||
          pathname.includes(
            '/v1/'
          ) ||
          pathname.includes(
            '/v2/'
          )
        )
      ) {
        apiEndpoints.add(
          `${parsed.origin}${pathname}`
        );
      }
    } catch {
      // Ignore malformed URLs.
    }
  }

  // ----------------------------------------------
  // APPLICATION MAP
  // ----------------------------------------------

  const applicationMap:
    ApplicationMap = {
      generatedAt:
        new Date().toISOString(),

      application: {
        title,
        url,
        framework:
          frameworkInfo.framework,
        frameworkHints:
          frameworkInfo.hints,
      },

      headings:
        staticData.headings,

      links:
        staticData.links,

      buttons:
        staticData.buttons,

      inputs:
        staticData.inputs,

      textareas:
        staticData.textareas,

      selects:
        staticData.selects,

      checkboxes:
        staticData.checkboxes,

      interactiveElements:
        staticData.interactiveElements,

      capabilities:
        staticData.capabilities,

      todoStructure:
        staticData.todoStructure,

      loginStructure,

      dynamicDiscovery: {
        enabled:
          explore,
        actions:
          dynamicActions,
      },

      network: {
        requests:
          networkList,
        apiEndpoints:
          [
            ...apiEndpoints,
          ],
      },

      metadata:
        staticData.metadata,
    };

  // ----------------------------------------------
  // SAVE
  // ----------------------------------------------

  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      applicationMap,
      null,
      2
    ),
    'utf-8'
  );

  // ----------------------------------------------
  // OUTPUT
  // ----------------------------------------------

  console.log('');
  console.log(
    'APPLICATION'
  );

  console.log(
    `Title       : ${title}`
  );

  console.log(
    `URL         : ${url}`
  );

  console.log(
    `Framework   : ${
      frameworkInfo.framework
    }`
  );

  console.log('');
  console.log(
    'ELEMENTS'
  );

  console.log(
    `Inputs      : ${staticData.inputs.length}`
  );

  console.log(
    `Buttons     : ${staticData.buttons.length}`
  );

  console.log(
    `Checkboxes  : ${staticData.checkboxes.length}`
  );

  console.log(
    `Textareas   : ${staticData.textareas.length}`
  );

  console.log(
    `Selects     : ${staticData.selects.length}`
  );

  console.log(
    `Links       : ${staticData.links.length}`
  );

  console.log(
    `Forms       : ${staticData.metadata.forms}`
  );

  console.log(
    `Interactive : ${staticData.interactiveElements.length}`
  );

  // ----------------------------------------------
  // CAPABILITIES
  // ----------------------------------------------

  console.log('');
  console.log(
    'CAPABILITIES'
  );

  if (
    staticData.capabilities.length ===
    0
  ) {
    console.log(
      '• None confidently detected'
    );
  } else {
    for (
      const capability of
        staticData.capabilities
    ) {
      console.log(
        `• ${capability.name} (${capability.confidence})`
      );

      if (
        capability.evidence
      ) {
        console.log(
          `  └─ ${capability.evidence}`
        );
      }
    }
  }

  // ----------------------------------------------
  // TODO STRUCTURE
  // ----------------------------------------------

  console.log('');
  console.log(
    'TODO STRUCTURE'
  );

  console.log(
    `Detected    : ${
      applicationMap.todoStructure.detected
        ? 'YES'
        : 'NO'
    }`
  );

  console.log(
    `Container   : ${
      applicationMap.todoStructure.container ||
      'N/A'
    }`
  );

  console.log(
    `Item        : ${
      applicationMap.todoStructure.item ||
      'N/A'
    }`
  );

  console.log(
    `Checkbox    : ${
      applicationMap.todoStructure.checkbox ||
      'N/A'
    }`
  );

  console.log(
    `Delete      : ${
      applicationMap.todoStructure.delete ||
      'N/A'
    }`
  );

  console.log(
    `Completed   : ${
      applicationMap.todoStructure.completed ||
      'N/A'
    }`
  );

  // ----------------------------------------------
  // DYNAMIC DISCOVERY
  // ----------------------------------------------

  if (explore) {
    console.log('');
    console.log(
      'DYNAMIC DISCOVERY'
    );

    for (
      const action of
        dynamicActions
    ) {
      let icon = '⚠';

      if (
        action.status ===
        'passed'
      ) {
        icon = '✓';
      }

      if (
        action.status ===
        'failed'
      ) {
        icon = '✗';
      }

      console.log(
        `${icon} ${action.action}`
      );

      if (
        action.evidence
      ) {
        console.log(
          `  └─ ${action.evidence}`
        );
      }

      if (
        action.error
      ) {
        console.log(
          `  └─ ${action.error}`
        );
      }
    }
  }

  // ----------------------------------------------
  // NETWORK
  // ----------------------------------------------

  console.log('');
  console.log(
    'NETWORK'
  );

  console.log(
    `XHR/Fetch   : ${networkList.length}`
  );

  console.log(
    `API         : ${apiEndpoints.size}`
  );

  // ----------------------------------------------
  // METADATA
  // ----------------------------------------------

  console.log('');
  console.log(
    'METADATA'
  );

  console.log(
    `Authentication : ${
      staticData.metadata
        .authenticationIndicators
        .length > 0
        ? 'DETECTED'
        : 'NOT DETECTED'
    }`
  );

  console.log(
    `Payment        : ${
      staticData.metadata
        .paymentIndicators
        .length > 0
        ? 'DETECTED'
        : 'NOT DETECTED'
    }`
  );

  // ----------------------------------------------
  // FINAL
  // ----------------------------------------------

  console.log('');
  console.log(
    '======================================'
  );

  console.log(
    'APPLICATION MAP SAVED'
  );

  console.log(
    outputFile
  );

  console.log(
    '======================================'
  );

  console.log('');
}

// --------------------------------------------------
// SAFE COMMONJS ENTRY POINT
// --------------------------------------------------

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error('');
    console.error(
      'Qyntra discovery failed:'
    );
    console.error(
      error
    );

    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

void run();

