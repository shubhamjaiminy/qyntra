import { test, expect } from '@playwright/test';

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  analyzeChange,
  areaOf,
  changeRiskFactors,
  classifyFile,
  coverageGaps,
  findTestFiles,
  routesIn,
  terms,
  type ChangeSummary,
} from '../../scripts/lib/change-intelligence';
import { assessRisk } from '../../scripts/lib/risk-intelligence';

// --------------------------------------------------
// A throwaway repository with a typical app layout.
// --------------------------------------------------

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function write(dir: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qyntra-change-'));

  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'qa@example.com');
  git(dir, 'config', 'user.name', 'QA');
  git(dir, 'config', 'commit.gpgsign', 'false');

  write(dir, 'src/features/checkout/charge.ts', 'export const charge = () => 1;\n');
  write(dir, 'src/features/todos/TodoList.tsx', 'export const TodoList = () => null;\n');
  write(dir, 'tests/todos.spec.ts', "test('todo list shows items', () => {});\n");
  write(dir, 'README.md', '# App\n');
  write(dir, 'package.json', '{"dependencies":{}}\n');

  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');

  return dir;
}

const commit = (dir: string, message: string) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
};

const noEnv = {} as NodeJS.ProcessEnv;

// --------------------------------------------------

test.describe('classification', () => {
  test('tells source, tests, docs, dependencies and config apart', () => {
    expect(classifyFile('src/app/page.tsx').kind).toBe('source');
    expect(classifyFile('src/app/page.test.tsx').kind).toBe('test');
    expect(classifyFile('e2e/checkout.ts').kind).toBe('test');
    expect(classifyFile('docs/setup.md').kind).toBe('docs');
    expect(classifyFile('package-lock.json').kind).toBe('dependency');
    expect(classifyFile('.github/workflows/ci.yml').kind).toBe('config');
  });

  test('flags sensitive application code, but not tests about it', () => {
    expect(classifyFile('src/payments/stripe.ts').sensitive).toEqual(['payments']);
    expect(classifyFile('src/auth/session.ts').sensitive).toEqual(['authentication']);
    expect(classifyFile('db/migrations/001_add_orders.sql').sensitive).toContain('data');
    expect(classifyFile('tests/payments.spec.ts').sensitive).toEqual([]);
  });

  test('names the feature, not the folder structure', () => {
    expect(areaOf('src/features/checkout/Cart.tsx')).toBe('checkout');
    expect(areaOf('app/(shop)/orders/[id]/page.tsx')).toBe('orders');
    expect(areaOf('src/components/OrderHistory.tsx')).toBe('order-history');
    expect(areaOf('scripts/api-test-generator.ts')).toBe('api-test-generator');
    expect(terms('OrderHistoryTable.tsx')).toEqual(['order', 'history', 'table']);
  });

  test('finds route strings on added lines', () => {
    expect(routesIn(["router.get('/checkout/confirm', h)", 'import "./styles.css"', "fetch(`/api/orders`)"])).toEqual([
      '/checkout/confirm',
      '/api/orders',
    ]);
  });
});

test.describe('analysing a real repository', () => {
  test('a payment change plus a dependency bump', () => {
    const dir = repo();

    write(dir, 'src/features/checkout/charge.ts', "export const charge = () => fetch('/api/charge');\n// retry\n");
    write(dir, 'package.json', '{"dependencies":{"stripe":"1"}}\n');
    commit(dir, 'change checkout');

    const change = analyzeChange(dir, { env: noEnv }) as ChangeSummary;

    expect(change.available).toBe(true);
    expect(change.baseReason).toBe('previous commit');
    expect(change.files.map((file) => file.path).sort()).toEqual(['package.json', 'src/features/checkout/charge.ts']);
    expect(change.areas.map((area) => area.name)).toEqual(['checkout']);
    expect(change.areas[0].terms).toContain('charge');

    const factors = changeRiskFactors(change, 'User can complete checkout', []);

    expect(factors.map((factor) => factor.reason)).toEqual([
      'This change modifies payments code',
      'Dependencies changed: their effects reach code this diff does not show',
    ]);
    expect(factors.reduce((sum, factor) => sum + factor.points, 0)).toBe(3);
  });

  test('uncommitted local changes count', () => {
    const dir = repo();

    write(dir, 'src/features/todos/TodoList.tsx', 'export const TodoList = () => "changed";\n');

    const change = analyzeChange(dir, { explicit: 'HEAD', env: noEnv }) as ChangeSummary;

    expect(change.files.map((file) => file.path)).toEqual(['src/features/todos/TodoList.tsx']);
  });

  test('a docs-only change adds no risk', () => {
    const dir = repo();

    write(dir, 'README.md', '# App\n\nMore words.\n');
    commit(dir, 'docs');

    expect(changeRiskFactors(analyzeChange(dir, { env: noEnv }), 'anything', [])).toEqual([]);
  });

  test('prefers the last commit the gate judged as the base', () => {
    const dir = repo();
    const judged = git(dir, 'rev-parse', 'HEAD');

    write(dir, 'src/features/todos/TodoList.tsx', '// one\n');
    commit(dir, 'one');
    write(dir, 'src/features/checkout/charge.ts', '// two\n');
    commit(dir, 'two');

    const change = analyzeChange(dir, {
      env: noEnv,
      runs: [{ git: { commit: judged } } as any],
    }) as ChangeSummary;

    expect(change.baseReason).toMatch(/last commit the gate judged/);
    expect(change.files).toHaveLength(2);
  });

  test('a pull request is compared with its target branch', () => {
    const dir = repo();

    git(dir, 'checkout', '-q', '-b', 'feature');
    write(dir, 'src/features/todos/TodoList.tsx', '// feature work\n');
    commit(dir, 'feature');

    // Locally the target is "main"; in CI it would be origin/main.
    const change = analyzeChange(dir, { explicit: 'main', env: noEnv }) as ChangeSummary;

    expect(change.baseReason).toBe('merge-base with main');
    expect(change.files.map((file) => file.path)).toEqual(['src/features/todos/TodoList.tsx']);
  });

  test('a missing base explains how to fix the checkout', () => {
    const dir = repo();
    const change = analyzeChange(dir, { env: { GITHUB_BASE_REF: 'main' } as NodeJS.ProcessEnv });

    expect(change.available).toBe(false);
    expect(!change.available && change.reason).toMatch(/fetch-depth: 0/);
  });

  test('outside a git repository the analysis is unavailable, not an error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qyntra-nogit-'));

    expect(analyzeChange(dir, { env: noEnv }).available).toBe(false);
  });
});

test.describe('coverage gaps', () => {
  test('a changed area no test mentions is a gap; a mentioned one is not', () => {
    const dir = repo();

    write(dir, 'src/features/checkout/charge.ts', '// changed\n');
    write(dir, 'src/features/todos/TodoList.tsx', '// changed\n');
    commit(dir, 'both');

    const change = analyzeChange(dir, { env: noEnv });
    const gaps = coverageGaps(change, findTestFiles(dir));

    expect(gaps.map((gap) => gap.area)).toEqual(['checkout']);
  });

  test('a test title counts as coverage too', () => {
    const dir = repo();

    write(dir, 'src/features/checkout/charge.ts', '// changed\n');
    commit(dir, 'checkout');

    expect(coverageGaps(analyzeChange(dir, { env: noEnv }), ['User can complete checkout'])).toEqual([]);
  });
});

test.describe('risk integration', () => {
  test('change factors are reported apart from what discovery saw', () => {
    const dir = repo();

    write(dir, 'src/features/checkout/charge.ts', '// changed\n');
    commit(dir, 'checkout');

    const factors = changeRiskFactors(analyzeChange(dir, { env: noEnv }), 'User can complete checkout', []);
    const assessment = assessRisk('User can complete checkout', undefined, factors);

    expect(assessment.factors.some((factor) => factor.source === 'change')).toBe(true);
    expect(assessment.reasoning).toContain('The code change adds: this change modifies payments code');
  });
});
