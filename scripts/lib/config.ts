/**
 * Qyntra configuration.
 *
 * Qyntra ships as a dev dependency inside a customer's repository and
 * runs in their CI, so configuration is a committed file plus
 * environment overrides — never interactive prompts.
 *
 * Deliberate constraint: credentials are NEVER read from the config
 * file. The file names the environment variables to read them from.
 * Config files get committed; secrets must not be.
 */

import fs from 'fs';
import path from 'path';

import { ConfigError } from './exit-codes';

// --------------------------------------------------
// SHAPE
// --------------------------------------------------

export interface AuthConfig {
  /** Only form login is supported today. */
  type: 'form';

  /** Absolute URL, or a path resolved against app.baseUrl. */
  loginUrl: string;

  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;

  /** Env var names holding the credentials. */
  usernameEnv: string;
  passwordEnv: string;

  /** Selector proving login succeeded. Prevents silent auth failure. */
  successSelector?: string;
}

export interface AppConfig {
  name: string;
  baseUrl: string;
  auth?: AuthConfig;
}

export interface DiscoveryConfig {
  /** Interact with the app to reveal dynamic behaviour. */
  explore: boolean;

  /** Cap on exploratory interactions, to bound runtime in CI. */
  maxActions: number;

  timeoutMs: number;

  /** Paths Qyntra must never navigate to or interact with. */
  excludePaths: string[];
}

export interface ExecutionConfig {
  /** Where generated specs are written, relative to the repo root. */
  generatedDir: string;

  /** Playwright JSON reporter output. */
  resultsFile: string;
}

export type AIProviderName = 'openai' | 'gemini' | 'ollama' | 'none';

export const AI_PROVIDERS: readonly AIProviderName[] = [
  'openai',
  'gemini',
  'ollama',
  'none',
];

export interface AIConfig {
  /**
   * 'ollama' runs a local model: free, no key, nothing leaves the
   * machine. 'none' forces the deterministic analyzer.
   */
  provider: AIProviderName;
  model: string;

  /** Env var holding the API key. Empty for providers that need none. */
  apiKeyEnv: string;

  /** Provider endpoint. Only used by ollama today. */
  baseUrl?: string;
}

/**
 * Per-provider defaults, so `"ai": { "provider": "gemini" }` is a
 * complete config rather than one that silently reads OPENAI_API_KEY.
 */
export const AI_PROVIDER_DEFAULTS: Record<
  Exclude<AIProviderName, 'none'>,
  { model: string; apiKeyEnv: string; baseUrl?: string }
> = {
  openai: { model: 'gpt-5-mini', apiKeyEnv: 'OPENAI_API_KEY' },
  gemini: { model: 'gemini-2.5-flash', apiKeyEnv: 'GEMINI_API_KEY' },
  ollama: {
    model: 'qwen2.5-coder:7b',
    apiKeyEnv: '',
    baseUrl: 'http://localhost:11434',
  },
};

/**
 * Release gate thresholds.
 *
 * Expressed as "block the release if..." so the semantics stay obvious
 * in a customer's config file and in a code review of that file.
 */
export interface GateConfig {
  maxCriticalFailures: number;
  maxHighFailures: number;

  /** 0-100. Release blocks below this. */
  minQualityScore: number;

  /** Let P2/low-severity failures through instead of blocking. */
  allowLowSeverityFailures: boolean;

  /**
   * Block when Qyntra judges a failure to be a product defect, even if
   * severity alone would have passed. Product defects are the ones that
   * reach end users.
   */
  blockOnProductDefect: boolean;

  /**
   * Block when a test that passed in every recent run fails now. This is
   * the strongest available signal that the change under test broke
   * something, and unlike severity it is measured rather than inferred.
   * Requires run history; has no effect on the first few runs.
   */
  blockOnNewRegression: boolean;

  /**
   * Runs of history retained for flakiness analysis. Lower values react
   * faster to a test being fixed; higher values are better at spotting
   * rare flakes.
   */
  historyRuns: number;
}

export interface OutputConfig {
  /** Artifact directory, relative to the repo root unless absolute. */
  dir: string;
}

export interface QyntraConfig {
  app: AppConfig;
  requirements: string[];
  output: OutputConfig;
  discovery: DiscoveryConfig;
  execution: ExecutionConfig;
  ai: AIConfig;
  gate: GateConfig;

  /** Absolute path of the loaded config file, if any. */
  readonly configPath?: string;

  /** Absolute repo root that relative paths resolve against. */
  readonly rootDir: string;
}

// --------------------------------------------------
// DEFAULTS
// --------------------------------------------------

const CONFIG_FILENAMES = [
  '.qyntra/config.json',
  'qyntra.config.json',
];

function defaults(rootDir: string): QyntraConfig {
  return {
    app: {
      name: 'Application',
      baseUrl: '',
    },

    requirements: [],

    output: {
      dir: 'qyntra-out',
    },

    discovery: {
      explore: true,
      maxActions: 25,
      timeoutMs: 30_000,
      excludePaths: [],
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
      blockOnNewRegression: true,
      historyRuns: 50,
    },

    rootDir,
  };
}

// --------------------------------------------------
// LOADING
// --------------------------------------------------

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Merge user config over defaults. Only plain objects merge deeply;
 * arrays replace wholesale, so a customer clearing `excludePaths` to
 * `[]` actually clears it rather than inheriting defaults.
 */
function mergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }

    const existing = out[key];

    if (
      isPlainObject(existing) &&
      isPlainObject(value)
    ) {
      out[key] = mergeConfig(existing, value);
    } else {
      out[key] = value;
    }
  }

  return out;
}

/**
 * QYNTRA_CONFIG (set by the CLI when it spawns a stage) wins over the
 * default filenames. Without it, `qyntra run --config other.json`
 * reached every stage as the default config — which once made the
 * generator clean the wrong tests directory.
 */
export function findConfigFile(
  rootDir: string
): string | undefined {
  if (process.env.QYNTRA_CONFIG) {
    return path.resolve(rootDir, process.env.QYNTRA_CONFIG);
  }

  for (const candidate of CONFIG_FILENAMES) {
    const full = path.join(rootDir, candidate);

    if (fs.existsSync(full)) {
      return full;
    }
  }

  return undefined;
}

function readConfigFile(
  configPath: string
): Record<string, unknown> {
  let raw: string;

  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    throw new ConfigError(
      `Could not read config file: ${configPath}`,
      (error as Error)?.message
    );
  }

  try {
    const parsed = JSON.parse(raw);

    if (!isPlainObject(parsed)) {
      throw new Error('Config root must be a JSON object.');
    }

    return parsed;
  } catch (error) {
    throw new ConfigError(
      `Config file is not valid JSON: ${configPath}`,
      (error as Error)?.message
    );
  }
}

// --------------------------------------------------
// VALIDATION
// --------------------------------------------------

function assertNonEmptyString(
  value: unknown,
  field: string,
  hint?: string
): string {
  if (
    typeof value !== 'string' ||
    value.trim() === ''
  ) {
    throw new ConfigError(
      `Config field "${field}" must be a non-empty string.`,
      hint
    );
  }

  return value.trim();
}

function validateUrl(
  value: string,
  field: string
): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(
      `Config field "${field}" is not a valid URL: ${value}`,
      'Include the scheme, e.g. https://staging.example.com'
    );
  }

  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:'
  ) {
    throw new ConfigError(
      `Config field "${field}" must use http or https, got ${parsed.protocol}`
    );
  }

  return parsed.toString();
}

function validateAuth(
  raw: unknown
): AuthConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!isPlainObject(raw)) {
    throw new ConfigError('Config field "app.auth" must be an object.');
  }

  // Guard against the most damaging config mistake we can anticipate:
  // a real credential pasted into a file that gets committed.
  for (const forbidden of ['password', 'username', 'secret', 'token']) {
    if (forbidden in raw) {
      throw new ConfigError(
        `Config field "app.auth.${forbidden}" is not allowed.`,
        `Qyntra never reads credentials from the config file, because that file gets committed. Use "${forbidden}Env" to name an environment variable instead.`
      );
    }
  }

  const type = String(raw.type ?? 'form');

  if (type !== 'form') {
    throw new ConfigError(
      `Unsupported "app.auth.type": ${type}`,
      'Only "form" is supported today.'
    );
  }

  return {
    type: 'form',

    loginUrl: assertNonEmptyString(
      raw.loginUrl,
      'app.auth.loginUrl'
    ),

    usernameSelector: assertNonEmptyString(
      raw.usernameSelector,
      'app.auth.usernameSelector'
    ),

    passwordSelector: assertNonEmptyString(
      raw.passwordSelector,
      'app.auth.passwordSelector'
    ),

    submitSelector: assertNonEmptyString(
      raw.submitSelector,
      'app.auth.submitSelector'
    ),

    usernameEnv: assertNonEmptyString(
      raw.usernameEnv,
      'app.auth.usernameEnv',
      'Name the environment variable holding the username, e.g. "QYNTRA_APP_USER".'
    ),

    passwordEnv: assertNonEmptyString(
      raw.passwordEnv,
      'app.auth.passwordEnv',
      'Name the environment variable holding the password, e.g. "QYNTRA_APP_PASSWORD".'
    ),

    successSelector:
      raw.successSelector === undefined
        ? undefined
        : assertNonEmptyString(
            raw.successSelector,
            'app.auth.successSelector'
          ),
  };
}

function validateNumber(
  value: unknown,
  field: string,
  min: number,
  max: number
): number {
  const numeric = Number(value);

  if (
    !Number.isFinite(numeric) ||
    numeric < min ||
    numeric > max
  ) {
    throw new ConfigError(
      `Config field "${field}" must be a number between ${min} and ${max}.`
    );
  }

  return numeric;
}

// --------------------------------------------------
// PUBLIC ENTRY
// --------------------------------------------------

export interface LoadConfigOptions {
  /** Explicit --config path. */
  configPath?: string;

  /** Repo root. Defaults to process.cwd(). */
  rootDir?: string;

  /** CLI overrides, applied last. */
  overrides?: {
    baseUrl?: string;
    requirement?: string;
    outputDir?: string;
  };
}

/**
 * Resolve Qyntra configuration from file + environment + CLI overrides.
 *
 * Precedence, lowest to highest: defaults, config file, environment,
 * CLI flags. Throws ConfigError with an actionable hint on any problem,
 * so CI failures are self-explanatory.
 */
export function loadConfig(
  options: LoadConfigOptions = {}
): QyntraConfig {
  const rootDir = path.resolve(
    options.rootDir ?? process.cwd()
  );

  const configPath =
    options.configPath !== undefined
      ? path.resolve(rootDir, options.configPath)
      : findConfigFile(rootDir);

  if (
    options.configPath !== undefined &&
    !fs.existsSync(configPath as string)
  ) {
    throw new ConfigError(
      `Config file not found: ${configPath}`,
      'Run "qyntra init" to create a starter config.'
    );
  }

  const fileConfig =
    configPath !== undefined
      ? readConfigFile(configPath)
      : {};

  let merged = mergeConfig(
    defaults(rootDir) as unknown as Record<string, unknown>,
    fileConfig
  );

  // Environment overrides.
  const envOverrides: Record<string, unknown> = {};

  if (process.env.QYNTRA_BASE_URL) {
    envOverrides.app = {
      baseUrl: process.env.QYNTRA_BASE_URL,
    };
  }

  if (process.env.QYNTRA_OUTPUT_DIR) {
    envOverrides.output = {
      dir: process.env.QYNTRA_OUTPUT_DIR,
    };
  }

  merged = mergeConfig(merged, envOverrides);

  // CLI overrides.
  const cli = options.overrides ?? {};
  const cliOverrides: Record<string, unknown> = {};

  if (cli.baseUrl) {
    cliOverrides.app = { baseUrl: cli.baseUrl };
  }

  if (cli.outputDir) {
    cliOverrides.output = { dir: cli.outputDir };
  }

  if (cli.requirement) {
    cliOverrides.requirements = [cli.requirement];
  }

  merged = mergeConfig(merged, cliOverrides);

  // ------------------------------------------------
  // VALIDATE
  // ------------------------------------------------

  const app = isPlainObject(merged.app) ? merged.app : {};

  const baseUrl = validateUrl(
    assertNonEmptyString(
      app.baseUrl,
      'app.baseUrl',
      'Set it in .qyntra/config.json, pass --url, or set QYNTRA_BASE_URL.'
    ),
    'app.baseUrl'
  );

  const requirements = Array.isArray(merged.requirements)
    ? merged.requirements
        .map((entry) => String(entry).trim())
        .filter((entry) => entry !== '')
    : [];

  if (requirements.length === 0) {
    throw new ConfigError(
      'No requirements configured.',
      'Add "requirements": ["User can complete a payment"] to your config, or pass one as the first CLI argument.'
    );
  }

  const discovery = isPlainObject(merged.discovery)
    ? merged.discovery
    : {};

  const execution = isPlainObject(merged.execution)
    ? merged.execution
    : {};

  const ai = isPlainObject(merged.ai) ? merged.ai : {};

  const gate = isPlainObject(merged.gate) ? merged.gate : {};

  const output = isPlainObject(merged.output) ? merged.output : {};

  const resolvedAI = resolveAIConfig(ai);

  return {
    app: {
      name: String(app.name ?? 'Application'),
      baseUrl,
      auth: validateAuth(app.auth),
    },

    requirements,

    output: {
      dir: String(output.dir ?? 'qyntra-out'),
    },

    discovery: {
      explore: Boolean(discovery.explore ?? true),

      maxActions: validateNumber(
        discovery.maxActions ?? 25,
        'discovery.maxActions',
        1,
        500
      ),

      timeoutMs: validateNumber(
        discovery.timeoutMs ?? 30_000,
        'discovery.timeoutMs',
        1_000,
        600_000
      ),

      excludePaths: Array.isArray(discovery.excludePaths)
        ? discovery.excludePaths.map((entry) => String(entry))
        : [],
    },

    execution: {
      generatedDir: String(
        execution.generatedDir ?? 'tests/generated'
      ),

      resultsFile: String(
        execution.resultsFile ?? 'test-results/results.json'
      ),
    },

    ai: resolvedAI,

    gate: {
      maxCriticalFailures: validateNumber(
        gate.maxCriticalFailures ?? 0,
        'gate.maxCriticalFailures',
        0,
        1_000
      ),

      maxHighFailures: validateNumber(
        gate.maxHighFailures ?? 0,
        'gate.maxHighFailures',
        0,
        1_000
      ),

      minQualityScore: validateNumber(
        gate.minQualityScore ?? 80,
        'gate.minQualityScore',
        0,
        100
      ),

      allowLowSeverityFailures: Boolean(
        gate.allowLowSeverityFailures ?? true
      ),

      blockOnProductDefect: Boolean(
        gate.blockOnProductDefect ?? true
      ),

      blockOnNewRegression: Boolean(
        gate.blockOnNewRegression ?? true
      ),

      historyRuns: validateNumber(
        gate.historyRuns ?? 50,
        'gate.historyRuns',
        3,
        1_000
      ),
    },

    configPath,
    rootDir,
  };
}

/**
 * Validate the `ai` block and fill per-provider defaults. Fields the
 * user set win; anything omitted comes from that provider's defaults,
 * never from another provider's.
 */
export function resolveAIConfig(raw: unknown): AIConfig {
  const ai = isPlainObject(raw) ? raw : {};

  const provider = String(ai.provider ?? 'openai') as AIProviderName;

  if (!AI_PROVIDERS.includes(provider)) {
    throw new ConfigError(
      `Unsupported "ai.provider": ${provider}`,
      `Supported values: ${AI_PROVIDERS.map((p) => `"${p}"`).join(', ')}.`
    );
  }

  if (provider === 'none') {
    return { provider, model: '', apiKeyEnv: '' };
  }

  const defaults = AI_PROVIDER_DEFAULTS[provider];

  const baseUrl =
    ai.baseUrl !== undefined
      ? validateUrl(String(ai.baseUrl), 'ai.baseUrl')
      : defaults.baseUrl;

  return {
    provider,
    model: String(ai.model ?? defaults.model),
    apiKeyEnv: String(ai.apiKeyEnv ?? defaults.apiKeyEnv),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

/**
 * Resolve the AI config for an individual stage.
 *
 * Like stagePaths(), this deliberately skips full config validation so
 * `npm run ai` works standalone. A missing or malformed config file
 * yields the defaults; an invalid `ai` block still throws, because
 * silently analysing with the wrong provider is worse than stopping.
 */
export function stageAIConfig(
  rootDir: string = process.cwd()
): AIConfig {
  const configPath = findConfigFile(rootDir);

  let raw: unknown = {};

  if (configPath !== undefined) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))?.ai ?? {};
    } catch {
      // `qyntra doctor` reports the malformed file precisely.
    }
  }

  return resolveAIConfig(raw);
}

/**
 * Read a credential from the environment variable named in config.
 * Never logged, never written to an artifact.
 */
export function readCredential(
  envVarName: string,
  field: string
): string {
  const value = process.env[envVarName];

  if (!value) {
    throw new ConfigError(
      `Environment variable ${envVarName} is not set (required by ${field}).`,
      'Set it as a CI secret. Qyntra will not read credentials from the config file.'
    );
  }

  return value;
}
