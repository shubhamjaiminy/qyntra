/**
 * Login Discovery.
 *
 * Recognises a login form by its structure — an identifier field, an
 * optional password field and a submit control — rather than by page
 * wording, because real login pages vary more than keyword lists do:
 * Peak's first step is a lone "Organization name" field with a
 * "Continue" button and no password, and none of the pages sampled
 * mark their errors with role="alert".
 *
 * Detection is followed by two probes against the live page: an empty
 * submit and a submit with values that cannot belong to a real account.
 * Generated tests assert only what a probe actually observed, so a test
 * never encodes a guess about how this application behaves.
 *
 * Locators are role/label based and checked to resolve to exactly one
 * element, so generated tests survive markup changes that keep the UI
 * the same.
 */

import type { Locator, Page } from '@playwright/test';

// --------------------------------------------------
// TYPES
// --------------------------------------------------

export type LocatorSpec =
  | { by: 'label'; name: string }
  | { by: 'placeholder'; name: string }
  | { by: 'role'; role: 'button'; name: string }
  | { by: 'css'; css: string };

export interface LoginProbe {
  /** False when the submit control could not be activated. */
  submitted: boolean;

  /** The submit control was disabled, so the form refused the input. */
  submitDisabled: boolean;

  /** Still on the same origin + path with the identifier field visible. */
  stayedOnPage: boolean;

  /** Error text that appeared after submitting, if any. */
  message: string | null;
}

export interface LoginStructure {
  detected: boolean;

  /** `identifier-first` forms ask for an account/org before a password. */
  kind: 'password' | 'identifier-first' | null;

  /** Why Qyntra believes this is (or is not) a login form. */
  evidence: string[];

  identifier: LocatorSpec | null;

  /** HTML input type of the identifier, used to pick a probe value. */
  identifierType: string | null;

  /** Human label of the identifier, for scenario descriptions. */
  identifierLabel: string | null;

  password: LocatorSpec | null;
  submit: LocatorSpec | null;

  probes: {
    empty: LoginProbe | null;
    invalid: LoginProbe | null;
  };
}

export function notDetected(evidence: string[]): LoginStructure {
  return {
    detected: false,
    kind: null,
    evidence,
    identifier: null,
    identifierType: null,
    identifierLabel: null,
    password: null,
    submit: null,
    probes: { empty: null, invalid: null },
  };
}

// --------------------------------------------------
// IN-PAGE COLLECTION
// --------------------------------------------------

interface FieldCandidate {
  index: number;
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
  form: number;
}

interface ButtonCandidate {
  index: number;
  type: string;
  label: string;
  form: number;
}

interface PageCandidates {
  fields: FieldCandidate[];
  buttons: ButtonCandidate[];
  textareasInForms: number[];
}

/*
 * Kept as a string: tsx compiles named inner functions with a __name
 * helper that does not exist inside the browser, so a function passed
 * to page.evaluate() would throw there.
 */
const COLLECT_CANDIDATES = `(() => {
  const forms = Array.from(document.forms);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden';
  };
  const text = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\\s+/g, ' ').trim();
  const labelOf = (el) => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const t = labelled.split(/\\s+/).map((id) => text(document.getElementById(id))).join(' ').trim();
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = text(el.labels[0]);
      if (t) return t;
    }
    return (el.getAttribute('aria-label') || '').trim();
  };
  const skip = ['hidden', 'checkbox', 'radio', 'submit', 'button', 'file', 'image', 'reset', 'range', 'color'];
  const fields = Array.from(document.querySelectorAll('input'))
    .map((el, index) => ({ el, index }))
    .filter(({ el }) => !skip.includes((el.getAttribute('type') || 'text').toLowerCase()) && visible(el))
    .map(({ el, index }) => ({
      index,
      type: (el.getAttribute('type') || 'text').toLowerCase(),
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      name: el.getAttribute('name') || '',
      id: el.id || '',
      label: labelOf(el),
      placeholder: el.getAttribute('placeholder') || '',
      form: el.form ? forms.indexOf(el.form) : -1,
    }));
  const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'))
    .map((el, index) => ({ el, index }))
    .filter(({ el }) => visible(el))
    .map(({ el, index }) => ({
      index,
      type: (el.getAttribute('type') || (el.form ? 'submit' : 'button')).toLowerCase(),
      label: (el.getAttribute('aria-label') || text(el) || el.getAttribute('value') || '').trim(),
      form: el.form ? forms.indexOf(el.form) : -1,
    }));
  const textareasInForms = Array.from(document.querySelectorAll('textarea'))
    .filter((el) => el.form && visible(el))
    .map((el) => forms.indexOf(el.form));
  return { fields, buttons, textareasInForms };
})()`;

// --------------------------------------------------
// CLASSIFICATION
// --------------------------------------------------

const IDENTIFIER_HINT =
  /user|email|e-mail|login|account|org|tenant|workspace|company|domain|phone/i;

const SUBMIT_HINT = /^(log ?in|sign ?in|continue|next|submit|proceed)\b/i;

const LOGIN_URL_HINT = /(log-?in|sign-?in|auth|sso|session)/i;

/** More text fields than this in one form is a signup or profile form. */
const MAX_TEXT_FIELDS = 3;

function fieldLabel(field: FieldCandidate): string {
  return field.label || field.placeholder || field.name || field.id;
}

function identifierScore(field: FieldCandidate): number {
  if (['username', 'email'].includes(field.autocomplete)) return 3;
  if (field.type === 'email') return 2;
  if (IDENTIFIER_HINT.test(`${field.name} ${field.id} ${fieldLabel(field)}`)) {
    return 1;
  }
  return 0;
}

export interface Classification {
  kind: 'password' | 'identifier-first';
  identifier: FieldCandidate;
  password: FieldCandidate | null;
  submit: ButtonCandidate;
  evidence: string[];
}

/**
 * Decide whether the collected candidates form a login form. Pure, so
 * the rules can be tested without a browser.
 */
export function classifyLogin(
  candidates: PageCandidates,
  pageUrl: string
): Classification | { rejected: string } {
  const password =
    candidates.fields.find((f) => f.type === 'password') ?? null;

  const textFields = candidates.fields.filter((f) =>
    ['text', 'email', 'tel', ''].includes(f.type)
  );

  // Anchor on the password's form; otherwise on the form of the most
  // identifier-like field.
  const ranked = [...textFields].sort(
    (a, b) => identifierScore(b) - identifierScore(a)
  );

  const form = password ? password.form : ranked[0]?.form;

  if (form === undefined) {
    return { rejected: 'No visible text, email or password field.' };
  }

  const inForm = ranked.filter((f) => f.form === form);
  const identifier = inForm[0];

  if (!identifier) {
    return { rejected: 'No identifier field beside the password field.' };
  }

  if (inForm.length > MAX_TEXT_FIELDS) {
    return {
      rejected: `${inForm.length} text fields in one form looks like signup or profile, not login.`,
    };
  }

  if (form !== -1 && candidates.textareasInForms.includes(form)) {
    return { rejected: 'Form contains a textarea, so it is not a login form.' };
  }

  const submit =
    candidates.buttons.find(
      (b) => form !== -1 && b.form === form && b.type === 'submit'
    ) ??
    candidates.buttons.find((b) => SUBMIT_HINT.test(b.label));

  if (!submit) {
    return { rejected: 'No submit control for the form.' };
  }

  const evidence = [
    `Identifier field "${fieldLabel(identifier)}"`,
    `Submit control "${submit.label}"`,
  ];

  if (password) {
    evidence.push(`Password field "${fieldLabel(password)}"`);
    return { kind: 'password', identifier, password, submit, evidence };
  }

  // Without a password, only call it login when the page says so —
  // otherwise every newsletter box would be a login form.
  let pathname = '';

  try {
    pathname = new URL(pageUrl).pathname;
  } catch {
    // Unparseable URL: treat as no URL signal.
  }

  if (!LOGIN_URL_HINT.test(pathname)) {
    return {
      rejected:
        'Single-field form without a password, on a URL that does not indicate login.',
    };
  }

  evidence.push(`URL path "${pathname}" indicates login`);

  return {
    kind: 'identifier-first',
    identifier,
    password: null,
    submit,
    evidence,
  };
}

// --------------------------------------------------
// LOCATORS
// --------------------------------------------------

function cssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function toLocator(page: Page, spec: LocatorSpec): Locator {
  switch (spec.by) {
    case 'label':
      return page.getByLabel(spec.name, { exact: true });
    case 'placeholder':
      return page.getByPlaceholder(spec.name, { exact: true });
    case 'role':
      return page.getByRole(spec.role, { name: spec.name, exact: true });
    case 'css':
      return page.locator(spec.css);
  }
}

/** The same locator as source code, for generated tests. */
export function renderLocator(spec: LocatorSpec): string {
  const q = (value: string) => JSON.stringify(value);

  switch (spec.by) {
    case 'label':
      return `page.getByLabel(${q(spec.name)}, { exact: true })`;
    case 'placeholder':
      return `page.getByPlaceholder(${q(spec.name)}, { exact: true })`;
    case 'role':
      return `page.getByRole('button', { name: ${q(spec.name)}, exact: true })`;
    case 'css':
      return `page.locator(${q(spec.css)})`;
  }
}

/**
 * First spec, most readable first, that resolves to exactly one
 * element. Ambiguous locators are what made the old map's `button`
 * selector useless.
 */
async function uniqueSpec(
  page: Page,
  options: LocatorSpec[]
): Promise<LocatorSpec | null> {
  for (const spec of options) {
    if ((await toLocator(page, spec).count()) === 1) {
      return spec;
    }
  }

  return null;
}

function fieldSpecs(field: FieldCandidate): LocatorSpec[] {
  const specs: LocatorSpec[] = [];

  if (field.label) specs.push({ by: 'label', name: field.label });
  if (field.placeholder) {
    specs.push({ by: 'placeholder', name: field.placeholder });
  }
  // [id="…"] rather than #id: real ids contain spaces ("input-Organization name").
  if (field.id) specs.push({ by: 'css', css: `input[id="${cssString(field.id)}"]` });
  if (field.name) {
    specs.push({ by: 'css', css: `input[name="${cssString(field.name)}"]` });
  }
  specs.push({ by: 'css', css: `input >> nth=${field.index}` });

  return specs;
}

function buttonSpecs(button: ButtonCandidate): LocatorSpec[] {
  const specs: LocatorSpec[] = [];

  if (button.label) {
    specs.push({ by: 'role', role: 'button', name: button.label });
  }
  specs.push({
    by: 'css',
    css: `button, input[type="submit"] >> nth=${button.index}`,
  });

  return specs;
}

// --------------------------------------------------
// DETECTION
// --------------------------------------------------

export async function detectLoginForm(
  page: Page,
  pageUrl: string
): Promise<LoginStructure> {
  const candidates = (await page.evaluate(
    COLLECT_CANDIDATES
  )) as PageCandidates;

  const result = classifyLogin(candidates, pageUrl);

  if ('rejected' in result) {
    return notDetected([result.rejected]);
  }

  const identifier = await uniqueSpec(page, fieldSpecs(result.identifier));
  const submit = await uniqueSpec(page, buttonSpecs(result.submit));
  const password = result.password
    ? await uniqueSpec(page, fieldSpecs(result.password))
    : null;

  if (!identifier || !submit || (result.password && !password)) {
    return notDetected([
      ...result.evidence,
      'Could not build a locator that matches exactly one element.',
    ]);
  }

  return {
    detected: true,
    kind: result.kind,
    evidence: result.evidence,
    identifier,
    identifierType: result.identifier.type,
    identifierLabel: fieldLabel(result.identifier),
    password,
    submit,
    probes: { empty: null, invalid: null },
  };
}

// --------------------------------------------------
// PROBING
// --------------------------------------------------

const REJECTION_HINT =
  /invalid|incorrect|not found|doesn.?t exist|does not exist|not exist|wrong|try again|error|couldn.?t|could not|unable|required|please (enter|provide|fill)|must|not recogni[sz]ed|failed|no account|unknown/i;

/**
 * Pick the error message out of text that appeared after a submit.
 * Lines echoing the probe value are dropped: they would make the
 * generated assertion depend on a random token.
 */
export function pickRejectionMessage(
  appearedLines: string[],
  probeToken: string
): string | null {
  for (const line of appearedLines) {
    const trimmed = line.trim();

    if (trimmed.length < 3 || trimmed.length > 200) continue;
    if (probeToken && trimmed.includes(probeToken)) continue;

    if (REJECTION_HINT.test(trimmed)) {
      return trimmed;
    }
  }

  return null;
}

export function isSamePage(before: string, after: string): boolean {
  try {
    const a = new URL(before);
    const b = new URL(after);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return before === after;
  }
}

async function visibleLines(page: Page): Promise<string[]> {
  const text = await page
    .locator('body')
    .innerText()
    .catch(() => '');

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Values no real account can have; `.invalid` is reserved by RFC 2606. */
export function probeValues(identifierType: string | null, token: string) {
  return {
    identifier:
      identifierType === 'email'
        ? `qyntra.probe.${token}@example.invalid`
        : identifierType === 'tel'
          ? '0000000000'
          : `qyntra-probe-${token}`,
    password: `Qyntra-Probe-${token}!`,
  };
}

async function probe(
  page: Page,
  pageUrl: string,
  login: LoginStructure,
  mode: 'empty' | 'invalid'
): Promise<LoginProbe> {
  const identifier = toLocator(page, login.identifier as LocatorSpec);
  const submit = toLocator(page, login.submit as LocatorSpec);

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await identifier.waitFor({ state: 'visible', timeout: 15000 });

  const token = Math.random().toString(36).slice(2, 8);

  if (mode === 'invalid') {
    const values = probeValues(login.identifierType, token);

    await identifier.fill(values.identifier);

    if (login.password) {
      await toLocator(page, login.password).fill(values.password);
    }
  }

  const before = new Set(await visibleLines(page));
  const urlBefore = page.url();

  if (await submit.isDisabled()) {
    return {
      submitted: false,
      submitDisabled: true,
      stayedOnPage: true,
      message: null,
    };
  }

  await submit.click({ timeout: 5000 });

  // Server-side rejections arrive after a round trip; poll until a
  // message appears, the page navigates away, or we give up.
  const deadline = Date.now() + (mode === 'invalid' ? 8000 : 4000);
  let message: string | null = null;

  while (Date.now() < deadline) {
    await page.waitForTimeout(500);

    if (!isSamePage(urlBefore, page.url())) break;

    const appeared = (await visibleLines(page)).filter(
      (line) => !before.has(line)
    );

    message = pickRejectionMessage(appeared, token);

    if (message) break;
  }

  const stayedOnPage =
    isSamePage(urlBefore, page.url()) &&
    (await identifier.isVisible().catch(() => false));

  return {
    submitted: true,
    submitDisabled: false,
    stayedOnPage,
    message: stayedOnPage ? message : null,
  };
}

/**
 * Run both probes. A probe that throws is recorded as not submitted
 * rather than failing discovery: the form was still found.
 */
export async function probeLoginForm(
  page: Page,
  pageUrl: string,
  login: LoginStructure
): Promise<LoginStructure> {
  const failed: LoginProbe = {
    submitted: false,
    submitDisabled: false,
    stayedOnPage: false,
    message: null,
  };

  const empty = await probe(page, pageUrl, login, 'empty').catch(() => failed);
  const invalid = await probe(page, pageUrl, login, 'invalid').catch(
    () => failed
  );

  // Leave the page as discovery found it for any later stage.
  await page
    .goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    .catch(() => undefined);

  return { ...login, probes: { empty, invalid } };
}

// --------------------------------------------------
// TEST RENDERING
// --------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Regex source matching the login page's origin + path, any query. */
function pageUrlPattern(pageUrl: string): string {
  try {
    const parsed = new URL(pageUrl);
    return `/^${escapeRegExp(parsed.origin + parsed.pathname)}/`;
  } catch {
    return `/^${escapeRegExp(pageUrl)}/`;
  }
}

/**
 * Body of the Playwright test for a login scenario, or the reason none
 * can be generated. Every assertion here was observed by a probe.
 */
export function renderLoginTestBody(
  scenarioTitle: string,
  login: LoginStructure,
  pageUrl: string
): { body: string } | { skip: string } {
  if (!login.detected || !login.identifier || !login.submit) {
    return { skip: 'No login form was detected.' };
  }

  const url = JSON.stringify(pageUrl);
  const identifier = renderLocator(login.identifier);
  const submit = renderLocator(login.submit);
  const password = login.password ? renderLocator(login.password) : null;
  const stillOnLogin = [
    `  await expect(page).toHaveURL(${pageUrlPattern(pageUrl)});`,
    '  await expect(identifier).toBeVisible();',
  ].join('\n');

  const open = [
    `  await page.goto(${url});`,
    '',
    `  const identifier = ${identifier};`,
    `  const submit = ${submit};`,
    ...(password ? [`  const password = ${password};`] : []),
    '',
    '  await expect(identifier).toBeVisible();',
  ].join('\n');

  switch (scenarioTitle) {
    case 'Login Form Is Displayed':
      return {
        body: [
          open,
          ...(password ? ['  await expect(password).toBeVisible();'] : []),
          '  await expect(submit).toBeVisible();',
        ].join('\n'),
      };

    case 'Password Is Masked':
      if (!password) {
        return { skip: 'This login form has no password field.' };
      }
      return {
        body: [
          open,
          "  await expect(password).toHaveAttribute('type', 'password');",
        ].join('\n'),
      };

    case 'Empty Credentials': {
      const probe = login.probes.empty;

      if (!probe?.stayedOnPage) {
        return { skip: 'The empty-submit probe did not run or left the page.' };
      }

      if (probe.submitDisabled) {
        return {
          body: [open, '  await expect(submit).toBeDisabled();'].join('\n'),
        };
      }

      return {
        body: [
          open,
          '  await submit.click();',
          '',
          ...(probe.message
            ? [
                `  await expect(page.getByText(${JSON.stringify(probe.message)}).first()).toBeVisible({ timeout: 10_000 });`,
              ]
            : []),
          stillOnLogin,
        ].join('\n'),
      };
    }

    case 'Invalid Credentials': {
      const probe = login.probes.invalid;

      if (!probe?.submitted || !probe.stayedOnPage) {
        return {
          skip: 'The invalid-submit probe did not run or left the page.',
        };
      }

      // A fresh token per run, so the test never depends on one value.
      return {
        body: [
          open,
          '  const token = Math.random().toString(36).slice(2, 8);',
          '',
          `  await identifier.fill(${
            login.identifierType === 'email'
              ? '`qyntra.probe.${token}@example.invalid`'
              : login.identifierType === 'tel'
                ? "'0000000000'"
                : '`qyntra-probe-${token}`'
          });`,
          ...(password
            ? ['  await password.fill(`Qyntra-Probe-${token}!`);']
            : []),
          '  await submit.click();',
          '',
          ...(probe.message
            ? [
                `  await expect(page.getByText(${JSON.stringify(probe.message)}).first()).toBeVisible({ timeout: 10_000 });`,
              ]
            : []),
          stillOnLogin,
        ].join('\n'),
      };
    }

    case 'Successful Login':
      return {
        skip:
          'Needs a test account. Configure app.auth with test credentials ' +
          'to verify the happy path.',
      };

    default:
      return { skip: `No login generator for "${scenarioTitle}".` };
  }
}
