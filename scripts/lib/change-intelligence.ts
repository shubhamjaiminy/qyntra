/**
 * Change intelligence: what did this release actually change?
 *
 * Until now Qyntra rated every release the same way — from the running
 * application and the requirement — as if a README typo and a rewrite
 * of the payment flow carried the same risk. The codebase is the one
 * input that knows the difference. Qyntra runs inside the customer's
 * repository, so the diff is right there.
 *
 * From the diff between a base (the PR's target, or the last commit the
 * gate judged) and the working tree, this derives:
 *
 *   - Risk factors: sensitive code (auth, payments, data migrations,
 *     security), dependency changes, size, and overlap with the
 *     requirement under test. Bounded, like outcome history.
 *   - Coverage gaps: areas the change touched that no test mentions.
 *
 * Only paths, line counts and quoted route strings from added lines are
 * read — never file contents beyond that, and nothing leaves the
 * machine.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import type { RiskFactor } from './risk-intelligence';
import type { RunHistoryEntry } from './run-history';

export type FileKind = 'source' | 'test' | 'docs' | 'dependency' | 'config' | 'other';

export type SensitiveArea = 'authentication' | 'payments' | 'data' | 'security';

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  kind: FileKind;
  sensitive: SensitiveArea[];
}

export interface ChangeArea {
  /** The feature the files belong to: "checkout", "todo-list". */
  name: string;
  /** Words that identify it, from paths and added route strings. */
  terms: string[];
  files: string[];
  lines: number;
}

export interface ChangeSummary {
  available: true;
  base: string;
  /** How the base was chosen, for the reader of the decision. */
  baseReason: string;
  head: string;
  files: ChangedFile[];
  areas: ChangeArea[];
  totals: { files: number; added: number; removed: number };
}

export interface ChangeUnavailable {
  available: false;
  reason: string;
}

export type ChangeAnalysis = ChangeSummary | ChangeUnavailable;

/** Most risk points a change may add; history has its own budget. */
const MAX_CHANGE_POINTS = 3;

/** Source lines beyond which a change is "large". */
const LARGE_CHANGE_LINES = 500;

// --------------------------------------------------
// CLASSIFICATION
// --------------------------------------------------

const TEST_PATH =
  /(^|\/)(tests?|__tests__|__mocks__|specs?|e2e|cypress|playwright)\/|\.(spec|test)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/i;

const DOCS_PATH = /\.(md|mdx|rst|txt|adoc)$|(^|\/)(docs?|documentation)\//i;

const DEPENDENCY_FILE =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|requirements[^/]*\.txt|poetry\.lock|Pipfile(\.lock)?|pyproject\.toml|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock)|Cargo\.(toml|lock)|pom\.xml|build\.gradle(\.kts)?)$/i;

const CONFIG_PATH =
  /(^|\/)(\.github|\.circleci|\.gitlab-ci\.yml|Dockerfile|docker-compose[^/]*|k8s|helm|terraform|\.env\.example)|\.config\.[cm]?[jt]s$|\.(ya?ml|toml|ini)$/i;

const SOURCE_EXT =
  /\.([cm]?[jt]sx?|vue|svelte|py|rb|go|java|kt|cs|php|rs|swift|scala|ex|exs|sql|prisma|graphql|gql|html|css|scss)$/i;

const SENSITIVE: [SensitiveArea, RegExp][] = [
  ['authentication', /auth|login|logout|signin|signup|session|password|oauth|jwt|permission|rbac|acl|sso|identity/i],
  ['payments', /pay(ment)?s?|billing|checkout|invoice|stripe|charge|refund|subscription|pricing/i],
  ['data', /migrations?|schema\.prisma|\.sql$|(^|\/)models?\//i],
  ['security', /security|crypto|encrypt|csrf|cors|sanitiz|xss|secret/i],
];

export function classifyFile(filePath: string): { kind: FileKind; sensitive: SensitiveArea[] } {
  const kind: FileKind = TEST_PATH.test(filePath)
    ? 'test'
    : DOCS_PATH.test(filePath)
      ? 'docs'
      : DEPENDENCY_FILE.test(filePath)
        ? 'dependency'
        : CONFIG_PATH.test(filePath)
          ? 'config'
          : SOURCE_EXT.test(filePath)
            ? 'source'
            : 'other';

  // Tests about payments are not payment code.
  const sensitive =
    kind === 'source'
      ? SENSITIVE.filter(([, pattern]) => pattern.test(filePath)).map(([area]) => area)
      : [];

  return { kind, sensitive };
}

/** Directory names that organise code but name no feature. */
const STRUCTURAL = new Set([
  'src', 'app', 'apps', 'lib', 'libs', 'packages', 'components', 'component', 'pages',
  'features', 'feature', 'modules', 'module', 'routes', 'views', 'screens', 'server',
  'client', 'shared', 'common', 'core', 'utils', 'util', 'helpers', 'hooks', 'services',
  'api', 'web', 'frontend', 'backend', 'main', 'java', 'com', 'index', 'public', 'static',
  'internal', 'pkg', 'cmd', 'controllers', 'handlers', 'store', 'stores', 'state',
  'scripts', 'tools', 'bin', 'source', 'sources', 'resources',
]);

/** "TodoList.tsx" → ["todo", "list"]; "order-history" → ["order", "history"]. */
export function terms(text: string): string[] {
  return text
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STRUCTURAL.has(word));
}

/** The feature a file belongs to: its first meaningful path segment. */
export function areaOf(filePath: string): string {
  const segments = filePath.split('/');

  for (const segment of segments.slice(0, -1)) {
    // Skips dot-dirs, Next.js route groups "(shop)" and dynamic "[id]".
    if (
      !STRUCTURAL.has(segment.toLowerCase()) &&
      !segment.startsWith('.') &&
      !segment.startsWith('[') &&
      !segment.startsWith('(')
    ) {
      return segment.toLowerCase();
    }
  }

  // The file's own name, kebab-cased. Not terms(): dropping generic
  // words would rename api-test-generator.ts to "test-generator" — a
  // different, real file. Matching still uses terms().
  return segments[segments.length - 1]
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/** Route-like string literals on added lines: '/checkout/confirm'. */
export function routesIn(addedLines: string[]): string[] {
  const routes = new Set<string>();

  for (const line of addedLines) {
    for (const match of line.matchAll(/['"`](\/[a-zA-Z][a-zA-Z0-9/_{}:.-]{1,80})['"`]/g)) {
      if (!/\.(js|css|png|svg|jpg|ico|json|map)$/.test(match[1])) {
        routes.add(match[1]);
      }
    }
  }

  return [...routes];
}

export function summarize(
  base: string,
  baseReason: string,
  head: string,
  numstat: { path: string; added: number; removed: number }[],
  routesByFile: Map<string, string[]> = new Map()
): ChangeSummary {
  const files: ChangedFile[] = numstat.map((entry) => ({ ...entry, ...classifyFile(entry.path) }));

  const byArea = new Map<string, ChangeArea>();

  for (const file of files) {
    if (file.kind !== 'source') {
      continue;
    }

    const name = areaOf(file.path);
    const area = byArea.get(name) ?? { name, terms: [], files: [], lines: 0 };

    area.files.push(file.path);
    area.lines += file.added + file.removed;

    const words = new Set([
      ...area.terms,
      ...terms(name),
      ...file.path.split('/').flatMap((segment) => terms(segment)),
      ...(routesByFile.get(file.path) ?? []).flatMap((route) => terms(route)),
    ]);

    area.terms = [...words];
    byArea.set(name, area);
  }

  return {
    available: true,
    base,
    baseReason,
    head,
    files,
    areas: [...byArea.values()].sort((a, b) => b.lines - a.lines),
    totals: {
      files: files.length,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
    },
  };
}

// --------------------------------------------------
// RISK
// --------------------------------------------------

function listFiles(files: string[]): string {
  return files.length <= 2
    ? files.join(', ')
    : `${files.slice(0, 2).join(', ')} and ${files.length - 2} more`;
}

/**
 * Risk factors from the change. A docs- or tests-only change adds
 * nothing; it is still reported, so the rating says why it is low.
 */
export function changeRiskFactors(
  change: ChangeAnalysis,
  requirement: string,
  capabilities: string[]
): RiskFactor[] {
  if (!change.available) {
    return [];
  }

  const factors: RiskFactor[] = [];
  const product = change.files.filter((file) => file.kind === 'source');

  for (const area of ['payments', 'authentication', 'data', 'security'] as SensitiveArea[]) {
    const touched = product.filter((file) => file.sensitive.includes(area)).map((file) => file.path);

    if (touched.length > 0) {
      factors.push({
        points: 2,
        source: 'change',
        reason: `This change modifies ${area} code`,
        evidence: listFiles(touched),
      });
    }
  }

  const dependencies = change.files.filter((file) => file.kind === 'dependency');

  if (dependencies.length > 0) {
    factors.push({
      points: 1,
      source: 'change',
      reason: 'Dependencies changed: their effects reach code this diff does not show',
      evidence: listFiles(dependencies.map((file) => file.path)),
    });
  }

  const vocabulary = new Set(
    [requirement, ...capabilities].flatMap((text) => terms(text))
  );

  for (const area of change.areas) {
    const shared = area.terms.filter((term) => vocabulary.has(term));

    if (shared.length > 0) {
      factors.push({
        points: 1,
        source: 'change',
        reason: `This change touches "${area.name}", which this requirement exercises (${shared.join(', ')})`,
        evidence: `${area.files.length} file(s), ${area.lines} line(s): ${listFiles(area.files)}`,
      });
    }
  }

  const sourceLines = product.reduce((sum, file) => sum + file.added + file.removed, 0);

  if (sourceLines > LARGE_CHANGE_LINES) {
    factors.push({
      points: 1,
      source: 'change',
      reason: `Large change: ${sourceLines} lines of application code across ${product.length} file(s)`,
    });
  }

  // Strongest first, then cap.
  factors.sort((a, b) => b.points - a.points);

  const capped: RiskFactor[] = [];
  let total = 0;

  for (const factor of factors) {
    const points = Math.min(factor.points, MAX_CHANGE_POINTS - total);

    if (points <= 0) {
      break;
    }

    capped.push({ ...factor, points });
    total += points;
  }

  return capped;
}

// --------------------------------------------------
// COVERAGE GAPS
// --------------------------------------------------

export interface CoverageGap {
  area: string;
  files: string[];
  lines: number;
}

/**
 * Changed areas that no test mentions — by title or by file path. A
 * word match is a weak proxy for coverage, so gaps are warnings, never
 * blocks; but "you changed checkout and nothing mentions checkout" is
 * the cheapest high-value question a gate can ask.
 */
export function coverageGaps(change: ChangeAnalysis, testNames: string[]): CoverageGap[] {
  if (!change.available) {
    return [];
  }

  const covered = new Set(testNames.flatMap((name) => name.split('/').flatMap((part) => terms(part))));

  return change.areas
    .filter((area) => area.terms.length > 0 && !area.terms.some((term) => covered.has(term)))
    .map((area) => ({ area: area.name, files: area.files, lines: area.lines }));
}

// --------------------------------------------------
// GIT
// --------------------------------------------------

function git(rootDir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return undefined;
  }
}

function isAncestor(rootDir: string, commit: string, of: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, of], {
      cwd: rootDir,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The commit to diff against, in order of intent:
 *   1. explicit (change.base / QYNTRA_BASE_REF), via merge-base;
 *   2. a pull request's target branch (GITHUB_BASE_REF), via merge-base;
 *   3. the last commit this gate judged, if it is an ancestor — "what
 *      changed since the gate last looked";
 *   4. the previous commit.
 */
export function resolveBase(
  rootDir: string,
  head: string,
  options: { explicit?: string; runs?: RunHistoryEntry[]; env?: NodeJS.ProcessEnv } = {}
): { base: string; reason: string } | { reason: string } {
  const env = options.env ?? process.env;

  const viaMergeBase = (ref: string, reason: string) => {
    const base = git(rootDir, ['merge-base', head, ref]);
    return base ? { base, reason } : undefined;
  };

  const explicit = options.explicit ?? env.QYNTRA_BASE_REF;

  if (explicit) {
    return (
      viaMergeBase(explicit, `merge-base with ${explicit}`) ?? {
        reason: `Base "${explicit}" is not in this clone. In CI, check out with fetch-depth: 0.`,
      }
    );
  }

  if (env.GITHUB_BASE_REF) {
    const ref = `origin/${env.GITHUB_BASE_REF}`;

    return (
      viaMergeBase(ref, `pull request target ${ref}`) ?? {
        reason: `${ref} is not in this clone. Check out with fetch-depth: 0 so Qyntra can see what the PR changes.`,
      }
    );
  }

  const judged = [...(options.runs ?? [])]
    .reverse()
    .map((run) => run.git?.commit)
    .find((commit) => commit && commit !== head && isAncestor(rootDir, commit, head));

  if (judged) {
    return { base: judged, reason: `last commit the gate judged (${judged.slice(0, 7)})` };
  }

  const parent = git(rootDir, ['rev-parse', '--verify', '--quiet', `${head}~1`]);

  return parent
    ? { base: parent, reason: 'previous commit' }
    : { reason: 'No earlier commit in this clone (a shallow CI checkout?). Use fetch-depth: 0.' };
}

/**
 * Diff `base` against the working tree — so uncommitted local changes
 * count — and collect numstat plus route strings from added lines.
 */
export function analyzeChange(
  rootDir: string,
  options: { explicit?: string; runs?: RunHistoryEntry[]; env?: NodeJS.ProcessEnv } = {}
): ChangeAnalysis {
  if (!fs.existsSync(path.join(rootDir, '.git')) && git(rootDir, ['rev-parse', '--git-dir']) === undefined) {
    return { available: false, reason: 'Not a git repository.' };
  }

  const head = git(rootDir, ['rev-parse', 'HEAD']);

  if (!head) {
    return { available: false, reason: 'The repository has no commits.' };
  }

  const resolved = resolveBase(rootDir, head, options);

  if (!('base' in resolved)) {
    return { available: false, reason: resolved.reason };
  }

  const numstatText = git(rootDir, ['diff', '--numstat', '-M', '--no-color', resolved.base]) ?? '';

  const numstat = numstatText
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split('\t');
      // Renames: "old => new" or "dir/{old => new}/file"; keep the new path.
      const raw = rest.join('\t');
      const renamed = raw.includes('=>')
        ? raw.replace(/\{[^}]*=> ([^}]*)\}/, '$1').replace(/^.* => /, '')
        : raw;

      return {
        path: renamed.replace(/\/\//g, '/'),
        // Binary files report "-".
        added: Number(added) || 0,
        removed: Number(removed) || 0,
      };
    });

  const routesByFile = new Map<string, string[]>();
  const sourceFiles = numstat.filter((entry) => classifyFile(entry.path).kind === 'source').slice(0, 200);

  for (const entry of sourceFiles) {
    const diff = git(rootDir, ['diff', '-U0', '--no-color', resolved.base, '--', entry.path]) ?? '';
    const added = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));

    routesByFile.set(entry.path, routesIn(added));
  }

  return summarize(resolved.base, resolved.reason, head, numstat, routesByFile);
}

/**
 * Test files in the repository, by path, for coverage gaps. Bounded:
 * a monorepo's node_modules is not the test suite.
 */
export function findTestFiles(rootDir: string, limit = 2_000): string[] {
  const found: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'test-results', 'playwright-report']);

  const walk = (dir: string, depth: number) => {
    if (found.length >= limit || depth > 8) {
      return;
    }

    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && !entry.name.startsWith('.')) {
          walk(path.join(dir, entry.name), depth + 1);
        }
      } else if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) {
        found.push(path.relative(rootDir, path.join(dir, entry.name)).split(path.sep).join('/'));
      }
    }
  };

  walk(rootDir, 0);

  return found;
}
