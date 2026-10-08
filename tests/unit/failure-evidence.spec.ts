import { test, expect } from '@playwright/test';

import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

import {
  collectEvidence,
  hasSignals,
  readPageSnapshot,
  sanitizeUrl,
} from '../../scripts/lib/failure-evidence';
import { readZipTextEntries } from '../../scripts/lib/zip';

/**
 * Build a zip in memory: deflated entries, central directory, end
 * record. Enough of the format to exercise the reader the way a
 * Playwright trace does.
 */
function buildZip(files: Record<string, string>, method = 8): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf-8');
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuffer = Buffer.from(name, 'utf-8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuffer, data);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDirectory, end]);
}

const ndjson = (events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join('\n') + '\n';

const CONTEXT_TRACE = ndjson([
  { type: 'console', messageType: 'info', text: 'React DevTools hint' },
  {
    type: 'console',
    messageType: 'error',
    text: 'Request failed token=abc123secret',
    location: { url: 'https://app.example/api?session=s3cr3t' },
  },
  {
    type: 'event',
    method: 'pageError',
    params: { error: { error: { name: 'TypeError', message: 'x is undefined' } } },
  },
]);

const NETWORK = ndjson([
  {
    type: 'resource-snapshot',
    snapshot: {
      request: { method: 'GET', url: 'https://app.example/' },
      response: { status: 200 },
    },
  },
  {
    type: 'resource-snapshot',
    snapshot: {
      request: { method: 'POST', url: 'https://app.example/api/pay?card=4111111111111111' },
      response: { status: 503 },
      _resourceType: 'fetch',
    },
  },
  {
    type: 'resource-snapshot',
    snapshot: {
      request: { method: 'GET', url: 'https://app.example/favicon.ico' },
      response: { status: 404 },
    },
  },
  {
    type: 'resource-snapshot',
    snapshot: {
      request: { method: 'GET', url: 'https://cdn.example/a.js' },
      response: { status: -1 },
      _failureText: 'net::ERR_CONNECTION_REFUSED',
    },
  },
]);

const TEST_TRACE = ndjson([
  { type: 'before', callId: 'hook@1', method: 'hook', title: 'Before Hooks' },
  { type: 'before', callId: 'pw@2', parentId: 'hook@1', method: 'pw:api', title: 'Create page' },
  { type: 'before', callId: 'pw@3', method: 'pw:api', title: 'Navigate', subtitle: 'app.example' },
  { type: 'before', callId: 'step@4', method: 'test.step', title: 'Pay' },
  { type: 'before', callId: 'pw@5', parentId: 'step@4', method: 'pw:api', title: 'Click', subtitle: "getByRole('button')" },
  { type: 'before', callId: 'exp@6', method: 'expect', title: 'Expect "toBeVisible"' },
  { type: 'after', callId: 'exp@6', error: { message: 'failed' } },
]);

const ERROR_CONTEXT = [
  '# Error details',
  '```',
  'Error: boom',
  '```',
  '',
  '# Page snapshot',
  '',
  '```yaml',
  '- heading "Checkout" [level=1]',
  '- textbox "Password": hunter2 password=hunter2',
  '```',
].join('\n');

let dir: string;

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qyntra-evidence-'));

  fs.writeFileSync(
    path.join(dir, 'trace.zip'),
    buildZip({
      'test.trace': TEST_TRACE,
      '1-trace.trace': CONTEXT_TRACE,
      '1-trace.network': NETWORK,
      'resources/abc.html': '<html>not an event log</html>',
    })
  );

  fs.writeFileSync(path.join(dir, 'error-context.md'), ERROR_CONTEXT);
  fs.writeFileSync(path.join(dir, 'test-failed-1.png'), 'png-bytes');
});

const attachments = () => [
  { name: 'screenshot', contentType: 'image/png', path: path.join(dir, 'test-failed-1.png') },
  { name: 'error-context', contentType: 'text/markdown', path: path.join(dir, 'error-context.md') },
  { name: 'trace', contentType: 'application/zip', path: path.join(dir, 'trace.zip') },
];

test.describe('zip reader', () => {
  test('reads deflated and stored entries', () => {
    for (const method of [0, 8]) {
      const entries = readZipTextEntries(
        buildZip({ 'a.trace': 'hello', 'b.txt': 'skip me' }, method),
        (name) => name.endsWith('.trace')
      );

      expect([...entries]).toEqual([['a.trace', 'hello']]);
    }
  });

  test('anything that is not a zip yields nothing rather than throwing', () => {
    expect(readZipTextEntries(Buffer.from('not a zip'), () => true).size).toBe(0);
    expect(readZipTextEntries(Buffer.alloc(0), () => true).size).toBe(0);
  });
});

test.describe('evidence extraction', () => {
  test('collects page errors, console errors and artifact paths', () => {
    const evidence = collectEvidence(attachments());

    expect(evidence.pageErrors).toEqual(['TypeError: x is undefined']);
    expect(evidence.consoleErrors).toHaveLength(1);
    expect(evidence.screenshotPath).toContain('test-failed-1.png');
    expect(evidence.tracePath).toContain('trace.zip');
    expect(hasSignals(evidence)).toBe(true);
  });

  test('keeps 5xx and unfinished requests, drops successes and favicon noise', () => {
    const { failedRequests } = collectEvidence(attachments());

    expect(failedRequests).toEqual([
      { method: 'POST', url: 'https://app.example/api/pay', status: 503, resourceType: 'fetch' },
      { method: 'GET', url: 'https://cdn.example/a.js', status: 0, failure: 'net::ERR_CONNECTION_REFUSED' },
    ]);
  });

  test("lists the test's own steps and marks the failing one", () => {
    expect(collectEvidence(attachments()).steps).toEqual([
      'Navigate app.example',
      'Pay',
      "Click getByRole('button')",
      'Expect "toBeVisible"  ✗ FAILED',
    ]);
  });

  test('extracts only the snapshot from error-context.md', () => {
    const snapshot = readPageSnapshot(path.join(dir, 'error-context.md'));

    expect(snapshot).toContain('heading "Checkout"');
    expect(snapshot).not.toContain('Error details');
  });

  test('missing or unreadable artifacts give empty evidence, never a crash', () => {
    const evidence = collectEvidence([
      { name: 'trace', path: path.join(dir, 'missing.zip') },
      { name: 'screenshot', path: undefined },
    ]);

    expect(hasSignals(evidence)).toBe(false);
    expect(collectEvidence(undefined).steps).toEqual([]);
  });
});

test.describe('evidence privacy', () => {
  test('query strings never leave the machine', () => {
    const serialized = JSON.stringify(collectEvidence(attachments()));

    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).not.toContain('s3cr3t');
  });

  test('credential-shaped values in console text are masked', () => {
    const [message] = collectEvidence(attachments()).consoleErrors;

    expect(message).toContain('token=***');
    expect(message).not.toContain('abc123secret');
  });

  test('credential-shaped values in the page snapshot are masked', () => {
    expect(readPageSnapshot(path.join(dir, 'error-context.md'))).not.toContain(
      'password=hunter2'
    );
  });

  test('sanitizeUrl keeps origin and path only', () => {
    expect(sanitizeUrl('https://a.example/p/q?x=1#frag')).toBe('https://a.example/p/q');
    expect(sanitizeUrl('not a url?token=1')).toBe('not a url');
  });
});
