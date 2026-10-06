import { test, expect } from '@playwright/test';

import {
  classifyLogin,
  isSamePage,
  notDetected,
  pickRejectionMessage,
  renderLoginTestBody,
  type LoginStructure,
} from '../../scripts/lib/login-discovery';

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

type Candidates = Parameters<typeof classifyLogin>[0];

function field(
  overrides: Partial<Candidates['fields'][number]> = {}
): Candidates['fields'][number] {
  return {
    index: 0,
    type: 'text',
    autocomplete: '',
    name: '',
    id: '',
    label: '',
    placeholder: '',
    form: 0,
    ...overrides,
  };
}

function button(
  overrides: Partial<Candidates['buttons'][number]> = {}
): Candidates['buttons'][number] {
  return { index: 0, type: 'submit', label: 'Log in', form: 0, ...overrides };
}

function candidates(overrides: Partial<Candidates> = {}): Candidates {
  return { fields: [], buttons: [], textareasInForms: [], ...overrides };
}

/** Peak's first step as discovery recorded it. */
function peakLogin(overrides: Partial<LoginStructure> = {}): LoginStructure {
  return {
    detected: true,
    kind: 'identifier-first',
    evidence: ['Identifier field "Organization name"'],
    identifier: { by: 'label', name: 'Organization name' },
    identifierType: 'text',
    identifierLabel: 'Organization name',
    password: null,
    submit: { by: 'role', role: 'button', name: 'Continue' },
    probes: {
      empty: {
        submitted: true,
        submitDisabled: false,
        stayedOnPage: true,
        message: null,
      },
      invalid: {
        submitted: true,
        submitDisabled: false,
        stayedOnPage: true,
        message: 'Invalid organization name',
      },
    },
    ...overrides,
  };
}

const PEAK_URL = 'https://platform.peak.ai/login';

// --------------------------------------------------
// CLASSIFICATION
// --------------------------------------------------

test.describe('login form classification', () => {
  test('username + password + submit is a password login', () => {
    const result = classifyLogin(
      candidates({
        fields: [
          field({ label: 'Username', index: 0 }),
          field({ type: 'password', label: 'Password', index: 1 }),
        ],
        buttons: [button()],
      }),
      'https://example.com/'
    );

    expect('kind' in result && result.kind).toBe('password');
  });

  test('a lone field on a /login URL is an identifier-first login', () => {
    // Peak asks for an organization before any password.
    const result = classifyLogin(
      candidates({
        fields: [field({ label: 'Organization name' })],
        buttons: [button({ label: 'Continue' })],
      }),
      PEAK_URL
    );

    expect('kind' in result && result.kind).toBe('identifier-first');
  });

  test('a lone field on an ordinary URL is not called login', () => {
    // Otherwise every newsletter signup box would be a login form.
    const result = classifyLogin(
      candidates({
        fields: [field({ type: 'email', label: 'Email' })],
        buttons: [button({ label: 'Subscribe' })],
      }),
      'https://example.com/blog'
    );

    expect('rejected' in result).toBe(true);
  });

  test('a form with many text fields is signup, not login', () => {
    const result = classifyLogin(
      candidates({
        fields: [
          field({ label: 'First name' }),
          field({ label: 'Last name' }),
          field({ type: 'email', label: 'Email' }),
          field({ label: 'Company' }),
          field({ type: 'password', label: 'Password' }),
        ],
        buttons: [button({ label: 'Create account' })],
      }),
      'https://example.com/signup'
    );

    expect('rejected' in result).toBe(true);
  });

  test('a form with a textarea is not a login form', () => {
    const result = classifyLogin(
      candidates({
        fields: [field({ type: 'email', label: 'Email' })],
        buttons: [button({ label: 'Send' })],
        textareasInForms: [0],
      }),
      'https://example.com/login'
    );

    expect('rejected' in result).toBe(true);
  });

  test('a submit-like button outside the form still counts', () => {
    const result = classifyLogin(
      candidates({
        fields: [
          field({ label: 'Username', form: -1 }),
          field({ type: 'password', label: 'Password', form: -1 }),
        ],
        buttons: [button({ type: 'button', label: 'Submit', form: -1 })],
      }),
      'https://example.com/practice-test-login/'
    );

    expect('kind' in result && result.submit.label).toBe('Submit');
  });
});

// --------------------------------------------------
// PROBE INTERPRETATION
// --------------------------------------------------

test.describe('rejection message selection', () => {
  test('picks the error line out of newly appeared text', () => {
    expect(
      pickRejectionMessage(['Welcome back', 'Invalid organization name'], 'x1')
    ).toBe('Invalid organization name');
  });

  test('ignores new text that does not read as an error', () => {
    expect(pickRejectionMessage(['Loading…', 'Welcome'], 'x1')).toBeNull();
  });

  test('drops lines that echo the probe value', () => {
    // An assertion on an echoed random token could never pass twice.
    expect(
      pickRejectionMessage(['No account found for qyntra-probe-ab12cd'], 'ab12cd')
    ).toBeNull();
  });

  test('a query string change is still the same page', () => {
    expect(isSamePage(PEAK_URL, `${PEAK_URL}?error=1`)).toBe(true);
    expect(isSamePage(PEAK_URL, 'https://platform.peak.ai/home')).toBe(false);
  });
});

// --------------------------------------------------
// TEST RENDERING
// --------------------------------------------------

test.describe('login test rendering', () => {
  test('invalid credentials asserts the message the probe observed', () => {
    const result = renderLoginTestBody('Invalid Credentials', peakLogin(), PEAK_URL);

    expect('body' in result).toBe(true);

    const body = 'body' in result ? result.body : '';

    expect(body).toContain('page.getByLabel("Organization name", { exact: true })');
    expect(body).toContain('getByText("Invalid organization name")');
    expect(body).toContain('toHaveURL(/^https:\\/\\/platform\\.peak\\.ai\\/login/)');
  });

  test('empty credentials asserts no message when none was observed', () => {
    const result = renderLoginTestBody('Empty Credentials', peakLogin(), PEAK_URL);
    const body = 'body' in result ? result.body : '';

    expect(body).toContain('await submit.click();');
    expect(body).not.toContain('getByText');
  });

  test('a disabled submit is asserted as disabled, not clicked', () => {
    const login = peakLogin();
    login.probes.empty = {
      submitted: false,
      submitDisabled: true,
      stayedOnPage: true,
      message: null,
    };

    const body = (() => {
      const r = renderLoginTestBody('Empty Credentials', login, PEAK_URL);
      return 'body' in r ? r.body : '';
    })();

    expect(body).toContain('toBeDisabled()');
    expect(body).not.toContain('submit.click()');
  });

  test('a probe that left the page produces no test', () => {
    const login = peakLogin();
    login.probes.invalid = {
      submitted: true,
      submitDisabled: false,
      stayedOnPage: false,
      message: null,
    };

    expect('skip' in renderLoginTestBody('Invalid Credentials', login, PEAK_URL)).toBe(true);
  });

  test('password masking is skipped for a form with no password', () => {
    expect('skip' in renderLoginTestBody('Password Is Masked', peakLogin(), PEAK_URL)).toBe(true);
  });

  test('successful login is skipped without a test account', () => {
    expect('skip' in renderLoginTestBody('Successful Login', peakLogin(), PEAK_URL)).toBe(true);
  });

  test('nothing is rendered when no login form was detected', () => {
    expect(
      'skip' in renderLoginTestBody('Login Form Is Displayed', notDetected([]), PEAK_URL)
    ).toBe(true);
  });
});
