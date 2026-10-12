/**
 * Feature exploration: find a named feature in a running application and
 * record what it looks like and how it behaves, without changing data.
 *
 * This is the evidence every later step works from. The AI reads these
 * snapshots to understand the feature and write tests; the report's
 * deterministic findings (errors, slowness, unlabeled controls, broken
 * links) come straight from what was observed here.
 *
 * Read-only unless the caller allows writes: every request goes through
 * isWriteRequest, and writes are aborted and recorded.
 */

import fs from 'fs';
import path from 'path';

import { chromium, type Locator, type Page } from '@playwright/test';

import { BROWSER_PROFILE } from './auth';
import { sanitizeUrl } from './failure-evidence';
import { log, redact } from './logger';
import { formProbes, listProbes, type Probe } from './feature-probes';
import { isWriteRequest } from './read-only-guard';

// --------------------------------------------------
// SHAPES
// --------------------------------------------------

export interface ObservedView {
  /** What was done to reach this view, e.g. 'Clicked "Add a New Rule"'. */
  how: string;
  url: string;
  /** 'page' for the feature itself, 'dialog' or 'page' after a click. */
  kind: 'page' | 'dialog';
  snapshot: string;
  screenshot: string;
  /**
   * Playwright locators checked to match exactly one element in this
   * view. Tests are written from these, not from guesses: a small model
   * asked to invent locators picks labels that are not associated and
   * text that matches five elements.
   */
  locators: string[];
}

export interface NetworkProblem {
  method: string;
  url: string;
  status?: number;
  failure?: string;
  /** GraphQL operation name, when the request was one. */
  operation?: string;
  /** GraphQL `errors[].message`, from a response that may be HTTP 200. */
  errors?: string[];
}

export interface MenuLink {
  label: string;
  href: string;
}

export interface FeatureObservation {
  feature: string;
  /** How the feature was reached. */
  located: 'path' | 'menu' | 'not-found';
  url: string;
  /** Navigation start to network idle, in ms. */
  loadMs: number;
  /** The page says the feature cannot be used here, e.g. "not available". */
  unavailableMessage?: string;
  views: ObservedView[];
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: NetworkProblem[];
  graphqlErrors: NetworkProblem[];
  blockedWrites: { method: string; url: string; operation?: string; during: string }[];
  /** Buttons and links in the feature area with no accessible name. */
  unlabeledControls: { role: string; count: number }[];
  menu: MenuLink[];
  readOnly: boolean;
  /** Behaviour experiments, each with a generated test. */
  probes: Probe[];
}

export interface ExploreOptions {
  baseUrl: string;
  feature: string;
  /** Path or URL of the feature, when known. Skips menu search. */
  path?: string;
  storageStatePath?: string;
  outputDir: string;
  allowWrites: boolean;
  /** Sub-views (dialogs, detail pages) to open. */
  maxViews: number;
  timeoutMs: number;
}

// --------------------------------------------------
// SNAPSHOT TRIMMING
// --------------------------------------------------

/** Enough of the page for a model to understand it, small enough for 7B. */
const MAX_SNAPSHOT_CHARS = 9_000;

/**
 * Drop navigation from an aria snapshot. A 60-item sidebar is noise for
 * understanding one feature and would push the feature itself out of a
 * small model's context window. Subtrees rooted at navigation, and lists
 * that are mostly links, are removed; so are /url lines.
 */
export function trimSnapshot(snapshot: string, maxChars = MAX_SNAPSHOT_CHARS): string {
  const lines = snapshot.split('\n');
  const kept: string[] = [];
  const indentOf = (line: string) => line.length - line.trimStart().length;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (/^- \/url:/.test(trimmed)) {
      continue;
    }

    const isNavigation = /^- (navigation|complementary)\b/.test(trimmed);
    const isList = /^- list\b/.test(trimmed);

    if (isNavigation || isList) {
      const indent = indentOf(line);
      let end = index + 1;
      let links = 0;
      let items = 0;

      while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > indent)) {
        if (/^\s*- link\b/.test(lines[end])) links += 1;
        if (/^\s*- (listitem|link)\b/.test(lines[end])) items += 1;
        end += 1;
      }

      const mostlyLinks = items >= 5 && links / items >= 0.5;

      if (isNavigation ? !/combobox|search/i.test(lines.slice(index, end).join('\n')) : mostlyLinks) {
        kept.push(`${' '.repeat(indent)}- ${isNavigation ? 'navigation' : 'list'} (${items} links omitted)`);
        index = end - 1;
        continue;
      }
    }

    kept.push(line);
  }

  const text = redact(kept.join('\n'));

  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

const UNAVAILABLE = /not available|not enabled|no access|access denied|permission|not authori[sz]ed|forbidden|upgrade your plan/i;

/** Controls worth opening: they show more of the feature. */
const SAFE_TO_OPEN = /\b(add|new|create|view|details?|edit|open|show|more|filter|columns?|preview|expand)\b/i;

/** Never clicked, even with the network guard: they act, not show. */
const NEVER_CLICK =
  /delete|remove|archive|deactivat|disable|log ?out|sign ?out|refund|void|send|publish|submit|save|confirm|download|export|upload|import|reset|clear|duplicate|copy|pay|charge|approve|reject/i;

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'feature';
}

function operationName(postData: string | null): string | undefined {
  if (!postData) return undefined;

  try {
    const body = JSON.parse(postData);
    const first = Array.isArray(body) ? body[0] : body;
    return typeof first?.operationName === 'string'
      ? first.operationName
      : /(?:query|mutation)\s+(\w+)/.exec(String(first?.query ?? ''))?.[1];
  } catch {
    return undefined;
  }
}

const BUSY = '[role=progressbar]:visible, [aria-busy=true]:visible, .spinner:visible, .loading:visible';

/**
 * Wait until the page has finished rendering, not merely loading.
 * SPAs keep fetching and rendering after network idle — a real admin app showed
 * only a progress bar at that point — so done means: no visible busy
 * indicator, and the page text unchanged across two checks.
 */
async function settle(page: Page, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;

  await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 15_000) }).catch(() => undefined);

  let previous = '';
  let changedAt = Date.now();

  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);

    const busy = await page.locator(BUSY).count().catch(() => 0);
    const text = await page.locator('body').innerText().catch(() => '');

    if (busy === 0 && text.length > 0 && text === previous) {
      break;
    }

    if (text !== previous || busy > 0) {
      changedAt = Date.now();
    }

    previous = text;
  }

  // When the page last changed: the moment it was ready, not the moment
  // we noticed it had stopped changing.
  return changedAt;
}

async function menuLinks(page: Page): Promise<MenuLink[]> {
  return page.$$eval('nav a[href], aside a[href], [role=navigation] a[href], li a[href]', (anchors) =>
    anchors
      .map((anchor) => ({
        label: ((anchor as HTMLElement).innerText || anchor.getAttribute('aria-label') || '').trim().split('\n')[0],
        href: anchor.getAttribute('href') ?? '',
      }))
      .filter((link) => link.label !== '' && link.href !== '' && link.href !== '#')
  );
}

/**
 * Find the feature in the menu by its visible name: exact match first,
 * then a link whose text contains it.
 */
async function openFromMenu(page: Page, feature: string, timeoutMs: number): Promise<boolean> {
  const exact = page.getByRole('link', { name: feature, exact: true });
  const textMatch = page.getByText(feature, { exact: true });
  const partial = page.getByRole('link', { name: new RegExp(feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });

  for (const candidate of [exact, textMatch, partial]) {
    const target = candidate.first();

    if ((await target.count()) > 0) {
      await target.scrollIntoViewIfNeeded().catch(() => undefined);
      await target.click({ timeout: timeoutMs });
      return true;
    }
  }

  return false;
}

async function countUnlabeled(page: Page): Promise<{ role: string; count: number }[]> {
  const counts = await page.$$eval('button, [role=button], a[href], input:not([type=hidden]), textarea, select', (elements) => {
    const result: Record<string, number> = {};

    for (const element of elements) {
      const html = element as HTMLElement;
      if (html.closest('nav, aside, [role=navigation]')) continue;
      if (!html.offsetParent && getComputedStyle(html).position !== 'fixed') continue;

      const field = html as HTMLInputElement;
      const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(html.tagName);

      const name = (
        (isField && field.labels && Array.from(field.labels).map((label) => label.innerText).join(' ')) ||
        (isField && field.placeholder) ||
        html.getAttribute('aria-label') ||
        html.getAttribute('title') ||
        html.innerText ||
        (html.getAttribute('aria-labelledby') &&
          document.getElementById(html.getAttribute('aria-labelledby') as string)?.innerText) ||
        ''
      ).trim();

      if (name === '') {
        const role = isField ? 'form field' : html.tagName === 'A' ? 'link' : 'button';
        result[role] = (result[role] ?? 0) + 1;
      }
    }

    return result;
  });

  return Object.entries(counts).map(([role, count]) => ({ role, count }));
}

/** Controls in the feature area worth opening, safest first. */
async function candidateControls(page: Page, max: number): Promise<{ how: string; locator: Locator; code?: string }[]> {
  const buttons = page.locator('button, [role=button]');
  const total = Math.min(await buttons.count(), 200);
  const named: { how: string; locator: Locator; code?: string }[] = [];
  const rowActions: { how: string; locator: Locator }[] = [];

  for (let index = 0; index < total; index += 1) {
    const button = buttons.nth(index);

    const info = await button
      .evaluate((element) => {
        const html = element as HTMLElement;
        return {
          inNav: !!html.closest('nav, aside, [role=navigation]'),
          inRow: !!html.closest('[role=row], tr'),
          visible: !!(html.offsetWidth || html.offsetHeight),
          disabled: (html as HTMLButtonElement).disabled || html.getAttribute('aria-disabled') === 'true',
          // textContent, not innerText: CSS text-transform turns "Add a
          // New Rule" into "ADD A NEW RULE", which no role locator matches.
          name: (html.getAttribute('aria-label') || html.getAttribute('title') || html.textContent || '').trim().replace(/\s+/g, ' '),
        };
      })
      .catch(() => undefined);

    if (!info || info.inNav || !info.visible || info.disabled || NEVER_CLICK.test(info.name)) {
      continue;
    }

    if (info.name !== '' && SAFE_TO_OPEN.test(info.name)) {
      const byRole = page.getByRole('button', { name: info.name, exact: true });
      const code = (await byRole.count().catch(() => 0)) === 1
        ? `await page.getByRole('button', { name: ${quote(info.name)}, exact: true }).click();`
        : undefined;
      named.push({ how: `Clicked "${info.name}"`, locator: button, code });
    } else if (info.name === '' && info.inRow && rowActions.length < 3) {
      rowActions.push({ how: `Clicked unlabeled action button ${rowActions.length + 1} in the first row`, locator: button });
    }
  }

  return [...named, ...rowActions].slice(0, max);
}

/** Roles worth targeting in a test. Rows and cells have unwieldy names. */
const LOCATOR_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'switch', 'slider',
  'heading', 'grid', 'table', 'columnheader', 'tab', 'menuitem', 'option', 'dialog', 'searchbox', 'listbox',
]);

const MAX_LOCATORS = 60;

const quote = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Candidate locators from an aria snapshot, kept only if they match
 * exactly one element right now.
 */
export function locatorCandidates(snapshot: string): { kind: 'role' | 'text'; role?: string; name: string }[] {
  const seen = new Set<string>();
  const candidates: { kind: 'role' | 'text'; role?: string; name: string }[] = [];

  for (const line of snapshot.split('\n')) {
    const role = /^\s*- (\w+) "((?:[^"\\]|\\.)+)"/.exec(line);

    if (role && LOCATOR_ROLES.has(role[1])) {
      const name = role[2].replace(/\\"/g, '"');
      const key = `role:${role[1]}:${name}`;
      if (name.length <= 80 && !seen.has(key)) {
        seen.add(key);
        candidates.push({ kind: 'role', role: role[1], name });
      }
      continue;
    }

    const text = /^\s*- (?:text|paragraph|caption|heading|cell): "?([^"\n]+?)"?\s*$/.exec(line);

    if (text && text[1].length >= 3 && text[1].length <= 80) {
      const key = `text:${text[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({ kind: 'text', name: text[1] });
      }
    }
  }

  return candidates;
}

async function verifiedLocators(page: Page, snapshot: string): Promise<string[]> {
  const locators: string[] = [];

  for (const candidate of locatorCandidates(snapshot)) {
    if (locators.length >= MAX_LOCATORS) break;

    const locator =
      candidate.kind === 'role'
        ? page.getByRole(candidate.role as Parameters<Page['getByRole']>[0], { name: candidate.name, exact: true })
        : page.getByText(candidate.name, { exact: true });

    const count = await locator.count().catch(() => 0);

    if (count === 1) {
      locators.push(
        candidate.kind === 'role'
          ? `page.getByRole('${candidate.role}', { name: ${quote(candidate.name)}, exact: true })`
          : `page.getByText(${quote(candidate.name)}, { exact: true })`
      );
    }
  }

  return locators;
}

async function snapshotOf(page: Page): Promise<{ kind: 'page' | 'dialog'; snapshot: string }> {
  const dialog = page.locator('[role=dialog]:visible, [role=alertdialog]:visible, dialog[open]').last();

  if ((await dialog.count()) > 0) {
    return { kind: 'dialog', snapshot: trimSnapshot(await dialog.ariaSnapshot().catch(() => '')) };
  }

  return { kind: 'page', snapshot: trimSnapshot(await page.locator('body').ariaSnapshot().catch(() => '')) };
}

// --------------------------------------------------
// EXPLORE
// --------------------------------------------------

/** Menu items that end the session or leave the application. */
const NOT_A_FEATURE = /log ?out|sign ?out|log ?off|exit|help|support|docs|documentation|privacy|terms/i;

/**
 * Every feature the menu offers: same-origin links with a name, minus
 * logout and help, one per destination. What `qyntra app` iterates.
 */
export async function discoverFeatures(options: {
  baseUrl: string;
  storageStatePath?: string;
  timeoutMs: number;
}): Promise<MenuLink[]> {
  const browser = await chromium.launch({ headless: process.env.QYNTRA_HEADED !== '1' });

  try {
    const context = await browser.newContext({
      ...BROWSER_PROFILE,
      viewport: { width: 1440, height: 900 },
      ...(options.storageStatePath && fs.existsSync(options.storageStatePath) ? { storageState: options.storageStatePath } : {}),
    });

    const page = await context.newPage();
    await page.goto(options.baseUrl, { timeout: options.timeoutMs });
    await settle(page, options.timeoutMs);

    const origin = new URL(page.url()).origin;
    const seen = new Set<string>();
    const slugs = new Set<string>();

    return (await menuLinks(page)).filter((link) => {
      let url: URL;

      try {
        url = new URL(link.href, page.url());
      } catch {
        return false;
      }

      const key = `${url.pathname}${url.search}`;

      if (
        url.origin !== origin ||
        NOT_A_FEATURE.test(link.label) ||
        /\/(undefined|null|NaN)(\/|$)/.test(url.pathname) ||
        seen.has(key) ||
        slugs.has(slug(link.label))
      ) {
        return false;
      }

      seen.add(key);
      slugs.add(slug(link.label));
      link.href = key;
      return true;
    });
  } finally {
    await browser.close();
  }
}

/** A probe that throws is skipped, but never silently: that hid a bug once. */
function probeError(error: unknown): [] {
  log.warn(`Behaviour probe skipped: ${(error as Error)?.message?.split('\n')[0] ?? error}`);
  return [];
}

export async function exploreFeature(options: ExploreOptions): Promise<FeatureObservation> {
  const viewsDir = path.join(options.outputDir, 'views');
  fs.mkdirSync(viewsDir, { recursive: true });

  const browser = await chromium.launch({ headless: process.env.QYNTRA_HEADED !== '1' });

  const context = await browser.newContext({
    ...BROWSER_PROFILE,
    viewport: { width: 1440, height: 900 },
    ...(options.storageStatePath && fs.existsSync(options.storageStatePath)
      ? { storageState: options.storageStatePath }
      : {}),
  });

  const observation: FeatureObservation = {
    feature: options.feature,
    located: 'not-found',
    url: '',
    loadMs: 0,
    views: [],
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    graphqlErrors: [],
    blockedWrites: [],
    unlabeledControls: [],
    menu: [],
    readOnly: !options.allowWrites,
    probes: [],
  };

  let phase = 'loading the application';

  if (!options.allowWrites) {
    await context.route('**/*', async (route) => {
      const request = route.request();

      if (isWriteRequest(request.method(), request.url(), request.postData())) {
        observation.blockedWrites.push({
          method: request.method(),
          url: sanitizeUrl(request.url()),
          operation: operationName(request.postData()),
          during: phase,
        });
        await route.abort('blockedbyclient');
        return;
      }

      await route.fallback();
    });
  }

  const page = await context.newPage();
  const seen = new Set<string>();
  const once = (key: string) => (seen.has(key) ? false : (seen.add(key), true));

  page.on('console', (message) => {
    if (message.type() === 'error') {
      const text = redact(message.text()).slice(0, 300);
      if (once(`console:${text}`)) observation.consoleErrors.push(text);
    }
  });

  page.on('pageerror', (error) => {
    const text = redact(error.message).slice(0, 300);
    if (once(`pageerror:${text}`)) observation.pageErrors.push(text);
  });

  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'failed';
    // Our own guard's aborts are reported as blocked writes, not failures.
    if (failure.includes('BLOCKED_BY_CLIENT') || !['fetch', 'xhr', 'document', 'script'].includes(request.resourceType())) {
      return;
    }
    const key = `failed:${request.method()} ${sanitizeUrl(request.url())} ${failure}`;
    if (once(key)) {
      observation.failedRequests.push({ method: request.method(), url: sanitizeUrl(request.url()), failure });
    }
  });

  page.on('response', async (response) => {
    const request = response.request();
    const type = request.resourceType();

    if (!['fetch', 'xhr', 'document'].includes(type)) {
      return;
    }

    const url = sanitizeUrl(response.url());
    const operation = operationName(request.postData());

    if (response.status() >= 400) {
      if (once(`status:${request.method()} ${url} ${response.status()} ${operation ?? ''}`)) {
        observation.failedRequests.push({ method: request.method(), url, status: response.status(), operation });
      }
      return;
    }

    if (!/json/.test(response.headers()['content-type'] ?? '') || !operation) {
      return;
    }

    // GraphQL reports failures inside a 200 response.
    const body = await response.json().catch(() => undefined);
    const errors: string[] = Array.isArray(body?.errors)
      ? body.errors.map((error: any) => redact(String(error?.message ?? error)).slice(0, 200))
      : [];

    if (errors.length > 0 && once(`graphql:${operation}:${errors[0]}`)) {
      observation.graphqlErrors.push({ method: request.method(), url, operation, errors });
    }
  });

  try {
    const started = Date.now();
    let readyAt = started;

    if (options.path) {
      const target = new URL(options.path, options.baseUrl).toString();
      await page.goto(target, { timeout: options.timeoutMs });
      readyAt = await settle(page, options.timeoutMs);
      observation.located = 'path';
    } else {
      await page.goto(options.baseUrl, { timeout: options.timeoutMs });
      await settle(page, options.timeoutMs);
      observation.menu = await menuLinks(page).catch(() => []);
      phase = `opening "${options.feature}" from the menu`;
      const menuStarted = Date.now();
      const opened = await openFromMenu(page, options.feature, options.timeoutMs);
      observation.located = opened ? 'menu' : 'not-found';
      // Time the feature itself, from the click, not the app's first load.
      readyAt = opened ? await settle(page, options.timeoutMs) : Date.now();
      observation.loadMs = readyAt - menuStarted;
    }

    if (options.path) {
      observation.loadMs = readyAt - started;
    }
    observation.url = page.url();

    if (observation.menu.length === 0) {
      observation.menu = await menuLinks(page).catch(() => []);
    }

    phase = 'viewing the feature';

    const main = await snapshotOf(page);
    const mainShot = path.join(viewsDir, '00-feature.png');
    await page.screenshot({ path: mainShot }).catch(() => undefined);

    observation.views.push({
      how: `Opened ${options.feature}`,
      url: sanitizeUrl(page.url()),
      kind: 'page',
      snapshot: main.snapshot,
      screenshot: mainShot,
      locators: await verifiedLocators(page, main.snapshot),
    });

    const unavailable = await page
      .getByText(UNAVAILABLE)
      .first()
      .innerText({ timeout: 1_000 })
      .catch(() => undefined);

    if (unavailable && unavailable.length < 200) {
      observation.unavailableMessage = unavailable.trim();
    }

    observation.unlabeledControls = await countUnlabeled(page).catch(() => []);

    if (observation.located !== 'not-found' && !observation.unavailableMessage) {
      observation.probes.push(...(await listProbes(page).catch(probeError)));
      // A form on the feature page itself.
      observation.probes.push(...(await formProbes(page, []).catch(probeError)));
    }

    if (observation.located !== 'not-found' && !observation.unavailableMessage) {
      const featureUrl = page.url();
      const controls = await candidateControls(page, options.maxViews);

      for (const [index, control] of controls.entries()) {
        phase = control.how;

        try {
          await control.locator.click({ timeout: 5_000 });
          await settle(page, 10_000);

          const view = await snapshotOf(page);
          const shot = path.join(viewsDir, `${String(index + 1).padStart(2, '0')}-${slug(control.how)}.png`);
          await page.screenshot({ path: shot }).catch(() => undefined);

          if (view.snapshot !== main.snapshot) {
            observation.views.push({
              how: control.how,
              url: sanitizeUrl(page.url()),
              kind: view.kind,
              snapshot: view.snapshot,
              screenshot: shot,
              locators: await verifiedLocators(page, view.snapshot),
            });

            if (control.code) {
              observation.probes.push(...(await formProbes(page, [control.code]).catch(probeError)));
            }
          }
        } catch {
          // A control that cannot be clicked is not a finding by itself.
        }

        // Back to the feature, as it was, before the next control.
        await page.keyboard.press('Escape').catch(() => undefined);

        if (page.url() !== featureUrl || (await page.locator('[role=dialog]:visible, dialog[open]').count()) > 0) {
          await page.goto(featureUrl, { timeout: options.timeoutMs }).catch(() => undefined);
          await settle(page, options.timeoutMs);
        }
      }
    }
  } finally {
    await browser.close();
  }

  // The same form can be reached from several views; probe it once.
  observation.probes = observation.probes.filter(
    (probe, index, all) => all.findIndex((other) => other.test.title === probe.test.title && other.setup.join() === probe.setup.join()) === index
  );

  return observation;
}
