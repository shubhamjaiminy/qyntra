/**
 * Artifact path resolution.
 *
 * Every Qyntra stage reads and writes JSON artifacts. Previously each
 * stage called path.resolve('qyntra-dashboard') independently, which
 * silently resolved against process.cwd() — so running Qyntra from any
 * directory other than the repo root produced artifacts in the wrong
 * place, or made a stage report "missing artifact" for a file that
 * existed. One resolver removes that whole class of bug.
 */

import fs from 'fs';
import path from 'path';

import { findConfigFile, type QyntraConfig } from './config';
import { MissingArtifactError } from './exit-codes';

export interface ArtifactPaths {
  /** Absolute artifact output directory. */
  outputDir: string;

  riskAnalysis: string;
  applicationMap: string;
  scenarioMapping: string;
  generationSummary: string;
  failures: string;
  failureAnalysis: string;
  aiAnalysis: string;
  releaseDecision: string;
  runHistory: string;
  dashboard: string;

  /** Outcome of every attempted repair. */
  remediation: string;

  /** Verified .patch files, plus backups while a patch is on disk. */
  remediationDir: string;

  /** Playwright's JSON reporter output. */
  playwrightResults: string;

  /** Directory generated specs are written to. */
  generatedTests: string;
}

/**
 * Resolve `candidate` against the repo root unless already absolute.
 */
function resolveFromRoot(
  rootDir: string,
  candidate: string
): string {
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(rootDir, candidate);
}

export function artifactPaths(
  config: QyntraConfig
): ArtifactPaths {
  const outputDir = resolveFromRoot(
    config.rootDir,
    config.output.dir
  );

  return {
    outputDir,

    riskAnalysis: path.join(outputDir, 'risk-analysis.json'),
    applicationMap: path.join(outputDir, 'application-map.json'),
    scenarioMapping: path.join(outputDir, 'scenario-mapping.json'),
    generationSummary: path.join(outputDir, 'generation-summary.json'),
    failures: path.join(outputDir, 'failures.json'),
    failureAnalysis: path.join(outputDir, 'failure-analysis.json'),
    aiAnalysis: path.join(outputDir, 'ai-analysis.json'),
    releaseDecision: path.join(outputDir, 'release-decision.json'),
    runHistory: path.join(outputDir, 'run-history.json'),
    dashboard: path.join(outputDir, 'index.html'),
    remediation: path.join(outputDir, 'remediation.json'),
    remediationDir: path.join(outputDir, 'remediation'),

    playwrightResults: resolveFromRoot(
      config.rootDir,
      config.execution.resultsFile
    ),

    generatedTests: resolveFromRoot(
      config.rootDir,
      config.execution.generatedDir
    ),
  };
}

export function ensureOutputDir(
  paths: ArtifactPaths
): void {
  fs.mkdirSync(paths.outputDir, { recursive: true });
}

/**
 * Resolve artifact paths for an individual stage.
 *
 * Stages are also runnable standalone (`npm run qa:analyze`), where
 * demanding a valid app.baseUrl and a requirements list would be
 * obstructive — aggregating failures needs neither. So this reads the
 * output location without running full config validation.
 *
 * Precedence: QYNTRA_OUTPUT_DIR (set by the CLI when it spawns a stage)
 * → config file → defaults. Reading the config file is best-effort; a
 * malformed file falls back to defaults rather than taking down a stage
 * that does not otherwise depend on config.
 */
export function stagePaths(
  rootDir: string = process.cwd()
): ArtifactPaths {
  let outputDir = 'qyntra-out';
  let resultsFile = 'test-results/results.json';
  let generatedDir = 'tests/generated';

  const configPath = findConfigFile(rootDir);

  if (configPath !== undefined) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(configPath, 'utf-8')
      );

      outputDir = String(parsed?.output?.dir ?? outputDir);

      resultsFile = String(
        parsed?.execution?.resultsFile ?? resultsFile
      );

      generatedDir = String(
        parsed?.execution?.generatedDir ?? generatedDir
      );
    } catch {
      // Defaults are a safe fallback; `qyntra doctor` reports the
      // malformed file with a precise error.
    }
  }

  // The CLI's explicit instruction wins over the config file, so a
  // --output override reaches every spawned stage.
  if (process.env.QYNTRA_OUTPUT_DIR) {
    outputDir = process.env.QYNTRA_OUTPUT_DIR;
  }

  return artifactPaths({
    rootDir: path.resolve(rootDir),
    output: { dir: outputDir },
    execution: { resultsFile, generatedDir },
  } as QyntraConfig);
}

/**
 * Read a JSON artifact produced by an earlier stage.
 *
 * `stageHint` names the command that produces the file, so a customer
 * hitting this in CI is told how to fix it rather than just what broke.
 */
export function readArtifact<T>(
  filePath: string,
  stageHint: string
): T {
  if (!fs.existsSync(filePath)) {
    throw new MissingArtifactError(
      `Required artifact not found: ${filePath}`,
      `It is produced by: ${stageHint}`
    );
  }

  try {
    return JSON.parse(
      fs.readFileSync(filePath, 'utf-8')
    ) as T;
  } catch (error) {
    throw new MissingArtifactError(
      `Artifact is not valid JSON: ${filePath}`,
      (error as Error)?.message
    );
  }
}

/**
 * Read an optional artifact, returning undefined when absent or
 * unparseable. Used for artifacts a stage can degrade without — a
 * corrupt AI analysis should not take down the dashboard.
 */
export function readOptionalArtifact<T>(
  filePath: string
): T | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    return JSON.parse(
      fs.readFileSync(filePath, 'utf-8')
    ) as T;
  } catch {
    return undefined;
  }
}

/**
 * Write a JSON artifact atomically.
 *
 * CI jobs get cancelled mid-write; a half-written artifact would make
 * the next stage fail with a confusing parse error, so write to a
 * temp file in the same directory and rename.
 */
export function writeArtifact(
  filePath: string,
  value: unknown
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.tmp`;

  fs.writeFileSync(
    tempPath,
    JSON.stringify(value, null, 2) + '\n'
  );

  fs.renameSync(tempPath, filePath);
}
