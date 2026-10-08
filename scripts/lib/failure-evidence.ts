/**
 * Failure evidence: what the browser actually saw when a test failed.
 *
 * Playwright already captures a screenshot, a trace and a page snapshot
 * for every failure (playwright.config.ts: retain-on-failure). Without
 * this module none of it reaches the analysis, which then has to infer
 * from the error text alone whether the app or the test is wrong. The
 * trace usually settles it: a 500 from the API or an uncaught exception
 * in the page is the application failing, whatever the assertion says.
 *
 * Everything extracted here may be sent to an LLM provider, so URLs
 * lose their query strings and anything credential-shaped is masked
 * before it leaves this module.
 */

import fs from 'fs';

import { redact } from './logger';
import { readZipTextEntries } from './zip';

export interface FailedRequest {
  method: string;
  /** Origin + path only. Query strings are dropped: they carry tokens. */
  url: string;
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  /** Browser-side failure, e.g. net::ERR_CONNECTION_REFUSED. */
  failure?: string;
  resourceType?: string;
}

export interface FailureEvidence {
  /** Absolute paths to the raw artifacts, for people and the dashboard. */
  screenshotPath?: string;
  tracePath?: string;
  videoPath?: string;

  /** Accessibility snapshot of the page or element at failure. */
  pageSnapshot?: string;

  /** Console errors and warnings logged by the application. */
  consoleErrors: string[];

  /** Uncaught exceptions thrown in the page. */
  pageErrors: string[];

  /** Requests that returned 4xx/5xx or never completed. */
  failedRequests: FailedRequest[];

  /** The test's own actions, in order, with the failing one marked. */
  steps: string[];

  /**
   * Elements on the page at failure, with the attributes a locator can
   * use (data-testid, id, role, label, classes) and their text. The
   * accessibility snapshot omits test ids and classes; a locator repair
   * needs them.
   */
  domElements?: string[];
}

interface Attachment {
  name?: string;
  contentType?: string;
  path?: string;
}

const MAX_SNAPSHOT_CHARS = 4_000;
const MAX_MESSAGE_CHARS = 300;
const MAX_CONSOLE_ERRORS = 10;
const MAX_PAGE_ERRORS = 5;
const MAX_FAILED_REQUESTS = 15;
const MAX_STEPS = 15;
const MAX_DOM_ELEMENTS = 80;

/**
 * Top-level event logs: test.trace (the runner's steps) and
 * N-trace.trace / N-trace.network (each browser context). Skips
 * snapshots, screencast frames and resources in subdirectories.
 */
const TRACE_ENTRY = /^[\w-]+\.(trace|network)$/;

/** Requests whose failure says nothing about the application. */
const NOISE_URL = /\/favicon\.ico$|\/__webpack_hmr|\/sockjs-node/;

/** Test-runner steps that are not the test's own actions. */
const USER_STEP_METHODS = new Set(['pw:api', 'expect', 'test.step']);

/**
 * Collect evidence from a Playwright JSON-reporter result's attachments.
 * Never throws: missing or unreadable artifacts yield empty evidence.
 */
export function collectEvidence(
  attachments: Attachment[] | undefined
): FailureEvidence {
  const evidence: FailureEvidence = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    steps: [],
  };

  for (const attachment of attachments ?? []) {
    const filePath = attachment.path;

    if (!filePath || !fs.existsSync(filePath)) {
      continue;
    }

    switch (attachment.name) {
      case 'screenshot':
        evidence.screenshotPath ??= filePath;
        break;

      case 'video':
        evidence.videoPath ??= filePath;
        break;

      case 'error-context':
        evidence.pageSnapshot ??= readPageSnapshot(filePath);
        break;

      case 'trace':
        evidence.tracePath ??= filePath;
        readTrace(filePath, evidence);
        break;
    }
  }

  return evidence;
}

/**
 * Pull the YAML accessibility snapshot(s) out of error-context.md. The
 * rest of that file repeats the error and source we already have.
 */
export function readPageSnapshot(filePath: string): string | undefined {
  let markdown: string;

  try {
    markdown = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }

  const blocks = [...markdown.matchAll(/```yaml\n([\s\S]*?)```/g)].map(
    (match) => match[1].trim()
  );

  if (blocks.length === 0) {
    return undefined;
  }

  return truncate(redact(blocks.join('\n\n')), MAX_SNAPSHOT_CHARS);
}

function readTrace(filePath: string, evidence: FailureEvidence): void {
  let entries: Map<string, string>;

  try {
    entries = readZipTextEntries(fs.readFileSync(filePath), (name) =>
      TRACE_ENTRY.test(name)
    );
  } catch {
    return;
  }

  for (const [name, text] of entries) {
    const events = parseEvents(text);

    if (name.endsWith('.network')) {
      collectFailedRequests(events, evidence);
    } else if (name === 'test.trace') {
      collectSteps(events, evidence);
    } else {
      collectPageSignals(events, evidence);
      collectDomElements(events, evidence);
    }
  }
}

/** NDJSON, one event per line; malformed lines are skipped. */
function parseEvents(text: string): any[] {
  const events: any[] = [];

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    try {
      events.push(JSON.parse(line));
    } catch {
      // A truncated final line is normal when a worker is killed.
    }
  }

  return events;
}

function collectPageSignals(events: any[], evidence: FailureEvidence): void {
  for (const event of events) {
    if (
      event.type === 'console' &&
      (event.messageType === 'error' || event.messageType === 'warning')
    ) {
      const where = event.location?.url
        ? ` (${sanitizeUrl(event.location.url)})`
        : '';

      pushUnique(
        evidence.consoleErrors,
        `[${event.messageType}] ${clean(event.text)}${where}`,
        MAX_CONSOLE_ERRORS
      );
    }

    if (event.type === 'event' && event.method === 'pageError') {
      // Shape varies across Playwright versions.
      const error =
        event.params?.error?.error ?? event.params?.error ?? {};

      const label = error.name ? `${error.name}: ` : '';

      pushUnique(
        evidence.pageErrors,
        `${label}${clean(error.message ?? error.value ?? 'Unknown error')}`,
        MAX_PAGE_ERRORS
      );
    }
  }
}

function collectFailedRequests(
  events: any[],
  evidence: FailureEvidence
): void {
  for (const event of events) {
    const snapshot = event.type === 'resource-snapshot' && event.snapshot;

    if (!snapshot) {
      continue;
    }

    const status = Number(snapshot.response?.status ?? 0);
    const failure = snapshot._failureText
      ? clean(snapshot._failureText)
      : undefined;

    // Status -1/0 without a failure text is a request still in flight
    // when the trace stopped, not a failure.
    if (status < 400 && failure === undefined) {
      continue;
    }

    const url = sanitizeUrl(String(snapshot.request?.url ?? ''));

    if (NOISE_URL.test(url)) {
      continue;
    }

    const request: FailedRequest = {
      method: String(snapshot.request?.method ?? 'GET'),
      url,
      status: status > 0 ? status : 0,
      ...(failure ? { failure } : {}),
      ...(snapshot._resourceType
        ? { resourceType: String(snapshot._resourceType) }
        : {}),
    };

    const duplicate = evidence.failedRequests.some(
      (existing) =>
        existing.method === request.method &&
        existing.url === request.url &&
        existing.status === request.status
    );

    if (!duplicate && evidence.failedRequests.length < MAX_FAILED_REQUESTS) {
      evidence.failedRequests.push(request);
    }
  }
}

function collectSteps(events: any[], evidence: FailureEvidence): void {
  const methodById = new Map<string, string>();
  const failed = new Set<string>();

  for (const event of events) {
    if (event.type === 'before') {
      methodById.set(event.callId, event.method);
    }

    if (event.type === 'after' && event.error) {
      failed.add(event.callId);
    }
  }

  const steps: string[] = [];

  for (const event of events) {
    if (event.type !== 'before' || !USER_STEP_METHODS.has(event.method)) {
      continue;
    }

    // Actions inside hooks and fixtures are runner plumbing; actions
    // inside a test.step are still the test's own.
    if (
      event.parentId !== undefined &&
      methodById.get(event.parentId) !== 'test.step'
    ) {
      continue;
    }

    const subtitle = event.subtitle ? ` ${clean(event.subtitle)}` : '';
    const mark = failed.has(event.callId) ? '  ✗ FAILED' : '';

    steps.push(`${clean(event.title)}${subtitle}${mark}`);
  }

  // The last steps are the ones that explain the failure.
  evidence.steps = steps.slice(-MAX_STEPS);
}

// --------------------------------------------------
// DOM AT FAILURE
// --------------------------------------------------

/** A serialised DOM node: text, [tag, attrs, ...children], or a reference. */
type SnapshotNode = string | [string, Record<string, string>?, ...unknown[]] | [[number, number]];

const SKIPPED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH',
]);

/** Attributes that make an element addressable, in locator preference. */
const LOCATOR_ATTRIBUTES = [
  'data-testid', 'data-test', 'data-qa', 'id', 'name', 'role',
  'aria-label', 'placeholder', 'title', 'type', 'href', 'for',
];

/**
 * Decode the last main-frame DOM snapshot in a context trace.
 *
 * Playwright stores later snapshots incrementally: a node may be
 * [[offset, index]], meaning "node `index`, in post-order, of the
 * snapshot `offset` steps earlier in this frame". Resolution follows
 * the trace viewer's own renderer.
 */
function collectDomElements(events: any[], evidence: FailureEvidence): void {
  const byFrame = new Map<string, any[]>();

  for (const event of events) {
    if (event.type === 'frame-snapshot' && event.snapshot?.isMainFrame) {
      const frameId = String(event.snapshot.frameId);
      byFrame.set(frameId, [...(byFrame.get(frameId) ?? []), event.snapshot]);
    }
  }

  // The frame snapshotted last is the page the test was on at failure.
  const frames = [...byFrame.values()];
  const snapshots = frames.sort(
    (a, b) => (a.at(-1)?.timestamp ?? 0) - (b.at(-1)?.timestamp ?? 0)
  ).at(-1);

  if (!snapshots || snapshots.length === 0) {
    return;
  }

  const postOrder = new Map<number, unknown[]>();

  const nodesOf = (index: number): unknown[] => {
    let nodes = postOrder.get(index);

    if (!nodes) {
      nodes = [];
      const visit = (node: unknown) => {
        if (typeof node === 'string') {
          nodes!.push(node);
        } else if (Array.isArray(node) && typeof node[0] === 'string') {
          for (const child of node.slice(2)) {
            visit(child);
          }
          nodes!.push(node);
        }
      };
      visit(snapshots[index].html);
      postOrder.set(index, nodes);
    }

    return nodes;
  };

  const elements: string[] = [];
  let budget = 20_000; // nodes; a pathological DOM must not stall the stage

  const resolve = (node: unknown, index: number): { node: unknown; index: number } | null => {
    if (Array.isArray(node) && Array.isArray(node[0])) {
      const [offset, nodeIndex] = node[0] as [number, number];
      const target = index - offset;

      if (target < 0 || target > index) {
        return null;
      }

      const nodes = nodesOf(target);

      return nodeIndex >= 0 && nodeIndex < nodes.length
        ? resolve(nodes[nodeIndex], target)
        : null;
    }

    return { node, index };
  };

  // Full text content, nested elements included, because that is what
  // toHaveText compares against: <span>1 <b>item</b> left</span> reads
  // "1 item left", not " left". Containers with more text than a short
  // label get none — their text identifies nothing.
  const MAX_TEXT = 80;

  const textOf = (children: unknown[], index: number): string => {
    let text = '';
    let overflowed = false;

    const collect = (node: unknown, at: number, depth: number) => {
      if (overflowed || depth > 20) {
        return;
      }

      if (text.length > MAX_TEXT * 2) {
        overflowed = true;
        return;
      }

      const resolved = resolve(node, at);

      if (!resolved) {
        return;
      }

      if (typeof resolved.node === 'string') {
        text += resolved.node;
      } else if (
        Array.isArray(resolved.node) &&
        typeof resolved.node[0] === 'string' &&
        !SKIPPED_TAGS.has(resolved.node[0].toUpperCase())
      ) {
        for (const child of resolved.node.slice(2)) {
          collect(child, resolved.index, depth + 1);
        }
      }
    };

    for (const child of children) {
      collect(child, index, 0);
    }

    const normalized = text.replace(/\s+/g, ' ').trim();

    return overflowed || normalized.length > MAX_TEXT ? '' : normalized;
  };

  const visit = (raw: unknown, index: number, depth: number): void => {
    if (budget-- <= 0 || depth > 60 || elements.length >= MAX_DOM_ELEMENTS) {
      return;
    }

    const resolved = resolve(raw, index);

    if (!resolved || !Array.isArray(resolved.node) || typeof resolved.node[0] !== 'string') {
      return;
    }

    const [tag, attrs = {}, ...children] = resolved.node as [string, Record<string, string>?, ...unknown[]];

    if (SKIPPED_TAGS.has(tag.toUpperCase())) {
      return;
    }

    const describe = describeElement(tag, attrs, textOf(children, resolved.index));

    if (describe && !elements.includes(describe)) {
      elements.push(describe);
    }

    for (const child of children) {
      visit(child, resolved.index, depth + 1);
    }
  };

  visit(snapshots[snapshots.length - 1].html, snapshots.length - 1, 0);

  if (elements.length > 0) {
    evidence.domElements = elements;
  }
}

/**
 * One line per addressable element, e.g.
 *   span.todo-count[data-testid="todo-count"] text "1 item left"
 * The part before " text" is a valid CSS selector for that element — no
 * spaces, which in CSS mean "a descendant of" — because a repair model
 * copies it verbatim. Null for anonymous wrappers with neither
 * attributes nor text.
 */
function describeElement(
  tag: string,
  attrs: Record<string, string>,
  text: string
): string | null {
  const name = tag.toLowerCase();

  const classes = String(attrs.class ?? '')
    .split(/\s+/)
    .filter((cls) => cls && !cls.startsWith('__playwright'))
    .slice(0, 3)
    .map((cls) => `.${cls}`)
    .join('');

  const parts = LOCATOR_ATTRIBUTES.filter(
    (attr) => attrs[attr] !== undefined && attrs[attr] !== ''
  ).map((attr) => {
    const value = attr === 'href' ? sanitizeUrl(attrs[attr]) : attrs[attr];
    return `[${attr}="${clean(value).slice(0, 80).replace(/["\\]/g, '\\$&')}"]`;
  });

  // Inner double quotes would end the quoted text early for readers.
  const shownText = text ? ` text "${clean(text).slice(0, 60).replace(/"/g, "'")}"` : '';

  if (parts.length === 0 && !classes && !shownText) {
    return null;
  }

  // Bare text in a div/span with nothing else is mostly layout noise.
  if (parts.length === 0 && !classes && ['div', 'span', 'p'].includes(name)) {
    return null;
  }

  return `${name}${classes}${parts.join('')}${shownText}`;
}

/**
 * Keep scheme, host and path; drop query and fragment, which is where
 * session tokens, signed-URL signatures and PII usually live.
 */
export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return redact(raw.split(/[?#]/)[0]);
  }
}

/** Strip ANSI codes and console format directives, redact, cap length. */
function clean(value: unknown): string {
  const text = String(value ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/%c/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return truncate(redact(text), MAX_MESSAGE_CHARS);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated]` : value;
}

function pushUnique(list: string[], value: string, max: number): void {
  if (list.length < max && !list.includes(value)) {
    list.push(value);
  }
}

/** True when there is anything beyond the raw artifact paths. */
export function hasSignals(evidence: FailureEvidence | undefined): boolean {
  return (
    evidence !== undefined &&
    (evidence.consoleErrors.length > 0 ||
      evidence.pageErrors.length > 0 ||
      evidence.failedRequests.length > 0 ||
      evidence.pageSnapshot !== undefined ||
      evidence.steps.length > 0)
  );
}
