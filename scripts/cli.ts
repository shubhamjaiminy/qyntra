#!/usr/bin/env node
/**
 * Qyntra CLI.
 *
 * Distribution model: Qyntra is installed as a dev dependency in the
 * customer's repository and invoked from their CI. Nothing runs on
 * Qyntra-operated infrastructure and no customer code or test data
 * leaves their environment.
 *
 *   npx qyntra init      scaffold .qyntra/config.json
 *   npx qyntra doctor    validate config + environment before a run
 *   npx qyntra gate      compute the release decision from artifacts
 *   npx qyntra run       full pipeline
 *
 * Stages are spawned with argv arrays rather than interpolated into a
 * shell string. The previous orchestrator built commands like
 * `npm run analyze:risk -- "${requirement}"`, so a requirement
 * containing a quote broke the run and a crafted one could execute
 * arbitrary commands in CI.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import dotenv from 'dotenv';

import {
  loadConfig,
  type QyntraConfig,
} from './lib/config';

import {
  artifactPaths,
  ensureOutputDir,
  readOptionalArtifact,
  writeArtifact,
  type ArtifactPaths,
} from './lib/paths';

import {
  appendRun,
  classifyFailure,
  computeStability,
  describeFailureHistory,
  gitContext,
  readHistory,
  type RunTestOutcome,
} from './lib/run-history';

import {
  decideRelease,
  formatDecision,
  type AnalyzedFailure,
  type ReleaseDecision,
  type RiskLevel,
  type Severity,
} from './lib/release-intelligence';

import { checkOllama } from './ai/ollama-provider';
import { describeProvider } from './ai/create-provider';
import { log, stage } from './lib/logger';

import {
  authenticate,
  storageStatePath,
  STORAGE_STATE_ENV,
} from './lib/auth';

import {
  QyntraError,
  ConfigError,
  EXIT_OK,
  EXIT_INTERNAL_ERROR,
  EXIT_QUALITY_GATE_FAILED,
} from './lib/exit-codes';

// Local development convenience: pick up a .env file so the CLI sees the
// same environment the individual stages do. In CI the variables come
// from the runner's secret store and no .env exists, so this is a no-op.
// `quiet` keeps dotenv's banner out of customer CI logs.
dotenv.config({ quiet: true });

// --------------------------------------------------
// ARG PARSING
// --------------------------------------------------

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;

  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    const next = rest[index + 1];

    // `--flag value` and `--flag=value` are both accepted; a flag
    // followed by another flag is treated as boolean.
    if (name.includes('=')) {
      const [key, ...valueParts] = name.split('=');
      flags[key] = valueParts.join('=');
    } else if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }

  return { command, positionals, flags };
}

function flagString(
  flags: Record<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

// --------------------------------------------------
// CONFIG RESOLUTION
// --------------------------------------------------

function configFrom(args: ParsedArgs): QyntraConfig {
  return loadConfig({
    configPath: flagString(args.flags, 'config'),

    overrides: {
      baseUrl: flagString(args.flags, 'url'),
      outputDir: flagString(args.flags, 'output'),
      requirement: args.positionals[0],
    },
  });
}

// --------------------------------------------------
// STAGE EXECUTION
// --------------------------------------------------

/**
 * Resolve a stage entry point and the argv needed to execute it.
 *
 * In this repo the CLI runs from TypeScript sources via tsx; in a
 * published package it runs as compiled JavaScript and tsx is not a
 * runtime dependency. Keying off our own extension keeps one code path
 * working in both without shipping a dev tool to customers.
 */
function stageCommand(
  scriptBaseName: string,
  stageArgs: string[]
): string[] {
  const runningFromSource = __filename.endsWith('.ts');

  const scriptPath = path.join(
    __dirname,
    `${scriptBaseName}${runningFromSource ? '.ts' : '.js'}`
  );

  return runningFromSource
    ? [require.resolve('tsx/cli'), scriptPath, ...stageArgs]
    : [scriptPath, ...stageArgs];
}

/**
 * Environment handing the logged-in session to a child process.
 *
 * Only set when app.auth is configured: a session file left over from
 * a previous config must not leak into a run that expects no login.
 */
function sessionEnv(
  config: QyntraConfig
): Record<string, string> {
  const statePath = storageStatePath(config);

  return config.app.auth && fs.existsSync(statePath)
    ? { [STORAGE_STATE_ENV]: statePath }
    : {};
}

/**
 * Log in when app.auth is configured. Throws AuthenticationError on
 * failure, which main() maps to its exit code.
 */
async function loginIfConfigured(
  config: QyntraConfig
): Promise<void> {
  if (!config.app.auth) {
    return;
  }

  stage('AUTHENTICATION');

  // Never reuse a stale session: an expired one fails the same silent
  // way a wrong password does.
  fs.rmSync(storageStatePath(config), { force: true });

  const result = await authenticate(config);

  log.info(`Logged in as  : user from $${config.app.auth.usernameEnv}`);
  log.info(`Landed on     : ${result.landedUrl}`);
  log.info(`Session saved : ${result.storageStatePath}`);
}

/**
 * Run a stage as a child process with an explicit argv array.
 *
 * `shell` is left false deliberately: every argument is passed through
 * without shell interpretation, so requirement text is inert.
 */
function runStage(
  label: string,
  scriptBaseName: string,
  stageArgs: string[],
  config: QyntraConfig
): number {
  stage(label);

  const result = spawnSync(
    process.execPath,
    stageCommand(scriptBaseName, stageArgs),
    {
      cwd: config.rootDir,
      stdio: 'inherit',
      shell: false,

      env: {
        ...process.env,
        ...sessionEnv(config),
        ...(config.configPath ? { QYNTRA_CONFIG: config.configPath } : {}),
        QYNTRA_OUTPUT_DIR: artifactPaths(config).outputDir,
        QYNTRA_BASE_URL: config.app.baseUrl,
      },
    }
  );

  if (result.error) {
    throw new QyntraError(
      `Stage "${label}" could not be started: ${result.error.message}`,
      EXIT_INTERNAL_ERROR
    );
  }

  return result.status ?? EXIT_INTERNAL_ERROR;
}

// --------------------------------------------------
// COMMAND: init
// --------------------------------------------------

const STARTER_CONFIG = {
  app: {
    name: 'My Application',
    baseUrl: 'https://staging.example.com',

    // Remove this block for apps that need no login.
    // Credentials are read from the named environment variables —
    // Qyntra never reads them from this file, which is committed.
    auth: {
      type: 'form',
      loginUrl: 'https://staging.example.com/login',
      usernameSelector: '#email',
      passwordSelector: '#password',
      submitSelector: 'button[type="submit"]',
      usernameEnv: 'QYNTRA_APP_USER',
      passwordEnv: 'QYNTRA_APP_PASSWORD',
      successSelector: '[data-testid="dashboard"]',
    },
  },

  requirements: [
    'User can sign in and reach the dashboard',
  ],

  output: { dir: 'qyntra-out' },

  discovery: {
    explore: true,
    maxActions: 25,
    timeoutMs: 30000,
    excludePaths: ['/logout', '/admin/billing'],
  },

  execution: {
    generatedDir: 'tests/generated',
    resultsFile: 'test-results/results.json',
  },

  ai: {
    provider: 'openai',
    model: 'gpt-5-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
  },

  gate: {
    maxCriticalFailures: 0,
    maxHighFailures: 0,
    minQualityScore: 80,
    allowLowSeverityFailures: true,
    blockOnProductDefect: true,
  },
};

function commandInit(args: ParsedArgs): number {
  const rootDir = process.cwd();
  const target = path.join(rootDir, '.qyntra', 'config.json');

  if (fs.existsSync(target) && !args.flags.force) {
    log.error(`Config already exists: ${target}`);
    log.info('Pass --force to overwrite it.');
    return EXIT_OK;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  fs.writeFileSync(
    target,
    JSON.stringify(STARTER_CONFIG, null, 2) + '\n'
  );

  log.info(`Created ${target}`);
  log.blank();
  log.info('Next steps:');
  log.info('  1. Set app.baseUrl to your staging environment.');
  log.info('  2. List the requirements you want covered.');
  log.info('  3. Export any credentials named in app.auth.');
  log.info('  4. Run: npx qyntra doctor');

  return EXIT_OK;
}

// --------------------------------------------------
// COMMAND: doctor
// --------------------------------------------------

/**
 * Pre-flight validation.
 *
 * Exists to cut onboarding support load: every check that fails here is
 * a support ticket that does not get filed.
 */
async function commandDoctor(args: ParsedArgs): Promise<number> {
  stage('QYNTRA DOCTOR');

  let config: QyntraConfig;

  try {
    config = configFrom(args);
  } catch (error) {
    reportError(error);
    return (error as QyntraError).exitCode ?? EXIT_INTERNAL_ERROR;
  }

  const problems: string[] = [];

  log.info(`Config        : ${config.configPath ?? '(defaults only)'}`);
  log.info(`Application   : ${config.app.name}`);
  log.info(`Base URL      : ${config.app.baseUrl}`);
  log.info(`Requirements  : ${config.requirements.length}`);
  log.info(`Output dir    : ${artifactPaths(config).outputDir}`);
  log.blank();

  // Credentials referenced by config must exist in the environment.
  if (config.app.auth) {
    for (const [field, envVar] of [
      ['usernameEnv', config.app.auth.usernameEnv],
      ['passwordEnv', config.app.auth.passwordEnv],
    ] as const) {
      if (process.env[envVar]) {
        log.info(`Credential    : ${envVar} is set`);
      } else {
        problems.push(
          `${envVar} is not set (required by app.auth.${field}).`
        );
      }
    }
  }

  // AI provider readiness. Every problem here is a warning, not a
  // failure: the pipeline still runs on the deterministic analyzer.
  const providerLabel = describeProvider(config.ai);

  if (config.ai.provider === 'none') {
    log.info('AI provider   : none (deterministic analyzer)');
  } else if (config.ai.provider === 'ollama') {
    const problem = await checkOllama(config.ai);

    if (problem === null) {
      log.info(`AI provider   : ${providerLabel}, running locally`);
    } else {
      log.warn(
        `${problem} — until then Qyntra falls back to the ` +
          'deterministic analyzer.'
      );
    }
  } else if (process.env[config.ai.apiKeyEnv]) {
    log.info(
      `AI provider   : ${providerLabel} (${config.ai.apiKeyEnv} is set)`
    );
  } else {
    log.warn(
      `${config.ai.apiKeyEnv} is not set — Qyntra will fall back to ` +
        'the deterministic analyzer.'
    );
  }

  // Whether flakiness detection is actually active. A customer whose CI
  // discards the artifact directory between builds would otherwise never
  // learn that this half of the gate is silently inert.
  const storedRuns = readHistory(artifactPaths(config).runHistory).runs
    .length;

  if (storedRuns === 0) {
    log.warn(
      'Run history    : empty — Qyntra cannot yet distinguish a new ' +
        'regression from a long-standing failure. In CI, cache ' +
        `${artifactPaths(config).runHistory} between builds.`
    );
  } else {
    log.info(
      `Run history   : ${storedRuns} run(s) stored` +
        (storedRuns < 3
          ? ' (flakiness detection activates at 3)'
          : '')
    );
  }

  // Reachability. A wrong or unreachable baseUrl is the single most
  // common setup failure, and it is cheap to detect here.
  try {
    const response = await fetch(config.app.baseUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(
        Math.min(config.discovery.timeoutMs, 15_000)
      ),
    });

    log.info(
      `Reachability  : ${config.app.baseUrl} responded ${response.status}`
    );

    if (response.status >= 400) {
      problems.push(
        `${config.app.baseUrl} returned HTTP ${response.status}. ` +
          'Qyntra needs an environment it can load.'
      );
    }
  } catch (error) {
    problems.push(
      `Could not reach ${config.app.baseUrl}: ` +
        `${(error as Error)?.message ?? 'unknown error'}`
    );
  }

  log.blank();

  if (problems.length > 0) {
    log.error(`${problems.length} problem(s) found:`);

    for (const problem of problems) {
      log.error(`  - ${problem}`);
    }

    return (new ConfigError('doctor failed')).exitCode;
  }

  log.info('All checks passed. Ready to run: npx qyntra run');
  return EXIT_OK;
}

// --------------------------------------------------
// COMMAND: gate
// --------------------------------------------------

interface FailuresArtifact {
  generatedAt?: string;
  summary?: {
    total?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
  };
  tests?: { test?: string; status?: string }[];
  failures?: { test?: string; category?: string }[];
}

interface AIAnalysisArtifact {
  analyses?: {
    test?: string;
    severity?: Severity;
    category?: string;
    confidence?: 'Low' | 'Medium' | 'High';
    isLikelyProductDefect?: boolean;
    isLikelyTestDefect?: boolean;
    /** Set by ai-analyzer when the deterministic fallback was used. */
    degraded?: boolean;
  }[];
}

interface GenerationArtifact {
  files?: { scenario?: string; priority?: string; status?: string }[];
}

interface RiskArtifact {
  riskLevel?: string;
  riskScore?: number;
  risk?: { level?: string; score?: number };
}

function normalizeRiskLevel(raw: unknown): RiskLevel {
  const value = String(raw ?? 'MEDIUM').toUpperCase();

  return value === 'LOW' ||
    value === 'MEDIUM' ||
    value === 'HIGH' ||
    value === 'CRITICAL'
    ? (value as RiskLevel)
    : 'MEDIUM';
}

/**
 * Build the release decision from artifacts already on disk.
 *
 * Separated from `run` so customers can compute a verdict in a later CI
 * job — commonly a required status check that runs after the test job.
 */
function buildDecision(
  config: QyntraConfig,
  paths: ArtifactPaths
): ReleaseDecision {
  const failuresArtifact =
    readOptionalArtifact<FailuresArtifact>(paths.failures);

  const aiArtifact =
    readOptionalArtifact<AIAnalysisArtifact>(paths.aiAnalysis);

  const riskArtifact =
    readOptionalArtifact<RiskArtifact>(paths.riskAnalysis);

  const generationArtifact =
    readOptionalArtifact<GenerationArtifact>(paths.generationSummary);

  const summary = failuresArtifact?.summary ?? {};

  const analyses = aiArtifact?.analyses ?? [];

  // Stability is measured against prior runs only. Including the current
  // run would let a failure contaminate the baseline it is judged
  // against, turning every new regression into "intermittent".
  //
  // `gate` is frequently a separate, retryable CI job, so by the time it
  // runs a second time over the same results it has already recorded
  // them. Those entries are excluded here, which makes the gate
  // idempotent: the same artifacts must always yield the same verdict,
  // however many times the job is retried.
  const history = readHistory(paths.runHistory);

  const resultsGeneratedAt = failuresArtifact?.generatedAt;

  const priorRuns =
    resultsGeneratedAt === undefined
      ? history.runs
      : history.runs.filter(
          (entry) => entry.resultsGeneratedAt !== resultsGeneratedAt
        );

  const stability = computeStability(priorRuns);

  const attachHistory = (
    failure: AnalyzedFailure
  ): AnalyzedFailure => {
    const record = classifyFailure(failure.test, stability);

    return {
      ...failure,
      history: {
        ...record,
        description: describeFailureHistory(failure.test, record),
      },
    };
  };

  const failures: AnalyzedFailure[] = analyses.map((entry) =>
    attachHistory({
      test: String(entry.test ?? 'Unknown test'),
      severity: (entry.severity ?? 'Medium') as Severity,
      category: String(entry.category ?? 'Unknown'),
      confidence: entry.confidence ?? 'Medium',
      isLikelyProductDefect: Boolean(entry.isLikelyProductDefect),
      isLikelyTestDefect: Boolean(entry.isLikelyTestDefect),
      // ai-analysis.json is written even when every failure fell back to
      // the deterministic analyzer, so its presence alone proves nothing.
      degraded: !aiArtifact || entry.degraded === true,
    })
  );

  // A failure the analyzer never saw must still count. Otherwise a
  // crashed analyzer would quietly improve the verdict.
  const reportedFailures = Number(summary.failed ?? 0);

  while (failures.length < reportedFailures) {
    failures.push({
      test: 'Unanalyzed failure',
      severity: 'Medium',
      category: 'Unknown / Environment',
      confidence: 'Low',
      isLikelyProductDefect: false,
      isLikelyTestDefect: false,
      degraded: true,
    });
  }

  const execution = {
    total: Number(summary.total ?? 0),
    passed: Number(summary.passed ?? 0),
    failed: reportedFailures,
    skipped: Number(summary.skipped ?? 0),
  };

  const risk = {
    level: normalizeRiskLevel(
      riskArtifact?.risk?.level ?? riskArtifact?.riskLevel
    ),
    score: Number(
      riskArtifact?.risk?.score ?? riskArtifact?.riskScore ?? 5
    ),
  };

  const decision = decideRelease({
    execution,
    failures,
    risk,
    gate: config.gate,
    aiAnalysisAvailable:
      aiArtifact !== undefined &&
      analyses.every((entry) => entry.degraded !== true),

    history: {
      available: priorRuns.length > 0,
      runsCompared: priorRuns.length,
    },

    coverage: generationArtifact && {
      unverifiedCritical: (generationArtifact.files ?? [])
        .filter((file) => file.priority === 'P0' && file.status === 'SKIPPED')
        .map((file) => String(file.scenario ?? 'Unnamed scenario')),
    },
  });

  // Record this run only after the verdict is decided, so the run being
  // judged is never part of its own baseline.
  recordRun(config, paths, failuresArtifact, decision, risk, execution);

  return decision;
}

/**
 * Persist this run so the next one can tell a new regression from a
 * long-standing failure.
 *
 * Deliberately non-fatal: a release decision that is already computed
 * must not be lost because a history file could not be written (a
 * read-only workspace, a full disk). The verdict is the deliverable.
 */
function recordRun(
  config: QyntraConfig,
  paths: ArtifactPaths,
  failuresArtifact: FailuresArtifact | undefined,
  decision: ReleaseDecision,
  risk: { level: string; score: number },
  execution: { total: number; passed: number; failed: number; skipped: number }
): void {
  const outcomes: RunTestOutcome[] = (failuresArtifact?.tests ?? [])
    .filter((entry) => typeof entry.test === 'string')
    .map((entry) => ({
      test: String(entry.test),
      status:
        entry.status === 'passed' ||
        entry.status === 'failed' ||
        entry.status === 'skipped'
          ? entry.status
          : 'skipped',
    }));

  try {
    appendRun(
      paths.runHistory,
      {
        runId: `${Date.now().toString(36)}-${process.pid.toString(36)}`,
        timestamp: new Date().toISOString(),
        resultsGeneratedAt: failuresArtifact?.generatedAt,
        git: gitContext(config.rootDir),
        execution,
        verdict: decision.verdict,
        qualityScore: decision.qualityScore,
        risk,
        tests: outcomes,
      },
      config.gate.historyRuns
    );
  } catch (error) {
    log.warn(
      `Could not update run history: ${(error as Error)?.message}`
    );
  }
}

function commandGate(args: ParsedArgs): number {
  const config = configFrom(args);
  const paths = artifactPaths(config);

  ensureOutputDir(paths);

  stage('RELEASE INTELLIGENCE');

  const decision = buildDecision(config, paths);

  writeArtifact(paths.releaseDecision, {
    generatedAt: new Date().toISOString(),
    application: config.app.name,
    ...decision,
  });

  process.stdout.write(formatDecision(decision) + '\n');
  log.blank();
  log.info(`Decision artifact: ${paths.releaseDecision}`);

  return decision.verdict === 'UNSAFE'
    ? EXIT_QUALITY_GATE_FAILED
    : EXIT_OK;
}

// --------------------------------------------------
// COMMAND: run
// --------------------------------------------------

async function commandRun(args: ParsedArgs): Promise<number> {
  const config = configFrom(args);
  const paths = artifactPaths(config);

  ensureOutputDir(paths);

  stage('QYNTRA AI QUALITY ENGINEER');

  log.info(`Application  : ${config.app.name}`);
  log.info(`Base URL     : ${config.app.baseUrl}`);
  log.info(`Requirements : ${config.requirements.length}`);
  log.info(`Output       : ${paths.outputDir}`);

  // Before discovery: an app that requires login shows an anonymous
  // visitor only the login page.
  await loginIfConfigured(config);

  // Discovery must come before risk: risk is a property of the
  // application surface, not of the requirement's wording.
  const discoveryStatus = runStage(
    'APPLICATION IQ — DISCOVERY',
    'application-discovery',
    config.discovery.explore
      ? [config.app.baseUrl, '--explore']
      : [config.app.baseUrl],
    config
  );

  if (discoveryStatus !== EXIT_OK) {
    log.error(
      'Discovery failed; Qyntra cannot reason about an application it ' +
        'could not load.'
    );
    return discoveryStatus;
  }

  for (const requirement of config.requirements) {
    runStage(
      'RISK INTELLIGENCE',
      'risk-analyzer',
      [requirement],
      config
    );
  }

  runStage('TEST INTELLIGENCE', 'scenario-mapper', [], config);
  runStage('TEST GENERATION', 'test-generator', [], config);

  stage('TEST EXECUTION');

  // Qyntra reads the Playwright JSON reporter output. We cannot rely on the
  // customer's playwright.config.ts declaring a json reporter at the path we
  // read, so we force one. `--reporter` replaces config reporters, hence
  // `list` is re-added to keep the run readable in CI logs.
  const resultsFile = artifactPaths(config).playwrightResults;

  fs.mkdirSync(path.dirname(resultsFile), { recursive: true });

  // A results file left by an earlier run must never be judged as this one.
  fs.rmSync(resultsFile, { force: true });

  // Only the tests generated for this application are evidence about it.
  // Running all of tests/ once let unrelated suites pass a release Qyntra
  // had generated nothing for. With nothing generated, Playwright still
  // writes a zero-test report, which the gate blocks on.
  const generatedFilter = path
    .relative(config.rootDir, paths.generatedTests)
    .split(path.sep)
    .join('/');

  const testRun = spawnSync(
    process.execPath,
    [
      require.resolve('@playwright/test/cli'),
      'test',
      `${generatedFilter}/`,
      '--pass-with-no-tests',
      '--reporter=list,json',
    ],
    {
      cwd: config.rootDir,
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        ...sessionEnv(config),
        PLAYWRIGHT_JSON_OUTPUT_NAME: resultsFile,
      },
    }
  );

  if (!fs.existsSync(resultsFile)) {
    log.warn(
      `Playwright produced no results file at ${resultsFile}. ` +
        'The release decision will treat this as a zero-test run.'
    );
  }

  runStage('FAILURE AGGREGATION', 'analyze-failures', [], config);
  runStage('FAILURE INTELLIGENCE', 'ai-analyzer', [], config);
  runStage('REPORTING', 'generate-dashboard', [], config);

  log.debug(`Playwright exit status: ${testRun.status ?? 'unknown'}`);

  return commandGate(args);
}

// --------------------------------------------------
// COMMAND: login
// --------------------------------------------------

/**
 * Log in and save the session, nothing else. The fastest way to prove
 * app.auth is right before committing to a full run.
 */
async function commandLogin(args: ParsedArgs): Promise<number> {
  const config = configFrom(args);

  if (!config.app.auth) {
    throw new ConfigError(
      'No app.auth block in config; this application has no login configured.',
      'Add app.auth to .qyntra/config.json. See README → Configuration.'
    );
  }

  await loginIfConfigured(config);

  log.blank();
  log.info('Login verified. Ready to run: npx qyntra run');
  return EXIT_OK;
}

// --------------------------------------------------
// HELP
// --------------------------------------------------

function commandHelp(): number {
  process.stdout.write(
    `
Qyntra — AI Quality Engineer

Usage:
  qyntra init                 Create .qyntra/config.json
  qyntra doctor               Validate config, credentials, reachability
  qyntra login                Log in via app.auth and save the session
  qyntra run [requirement]    Full pipeline, ending in a release decision
  qyntra gate                 Release decision from existing artifacts
  qyntra help                 Show this message

Options:
  --config <path>   Config file (default: .qyntra/config.json)
  --url <url>       Override app.baseUrl
  --output <dir>    Override output.dir
  --force           Overwrite on init

Environment:
  QYNTRA_BASE_URL     Override app.baseUrl
  QYNTRA_OUTPUT_DIR   Override output.dir
  QYNTRA_LOG_LEVEL    debug | info | warn | error
  QYNTRA_LOG_FORMAT   json for one JSON object per line
  QYNTRA_HEADED       1 to show the browser during login

Exit codes:
  0   success
  1   release blocked by the quality gate
  2   configuration error
  3   required artifact missing
  4   application unreachable
  5   login to the application failed
  70  internal error
`.trimStart()
  );

  return EXIT_OK;
}

// --------------------------------------------------
// ENTRY
// --------------------------------------------------

function reportError(error: unknown): void {
  if (error instanceof QyntraError) {
    log.error(error.message);

    if (error.hint) {
      log.info(error.hint);
    }

    return;
  }

  log.error('Unexpected Qyntra failure.');
  log.error(String((error as Error)?.stack ?? error));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'init':
      return commandInit(args);

    case 'doctor':
      return commandDoctor(args);

    case 'login':
      return commandLogin(args);

    case 'gate':
      return commandGate(args);

    case 'run':
      return commandRun(args);

    case 'help':
    case '--help':
    case '-h':
      return commandHelp();

    default:
      log.error(`Unknown command: ${args.command}`);
      commandHelp();
      return (new ConfigError('unknown command')).exitCode;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    reportError(error);

    process.exitCode =
      error instanceof QyntraError
        ? error.exitCode
        : EXIT_INTERNAL_ERROR;
  });
