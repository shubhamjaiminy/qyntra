/**
 * Qyntra process exit codes.
 *
 * These are part of Qyntra's public contract: customers branch on
 * them in CI, so the numbers must stay stable across releases.
 *
 * Distinguishing CONFIG_ERROR / INTERNAL_ERROR from QUALITY_GATE_FAILED
 * matters operationally — a broken pipeline must never look like a
 * clean "your release is unsafe" verdict.
 */
export const EXIT_OK = 0;

/** Qyntra ran; the release was judged unsafe. */
export const EXIT_QUALITY_GATE_FAILED = 1;

/** Config missing, unreadable, or invalid. Nothing was executed. */
export const EXIT_CONFIG_ERROR = 2;

/** A required upstream artifact was absent, so the stage could not run. */
export const EXIT_MISSING_ARTIFACT = 3;

/** The target application could not be reached or discovered. */
export const EXIT_APPLICATION_UNREACHABLE = 4;

/** Login to the target application failed, so nothing behind it can be tested. */
export const EXIT_AUTHENTICATION_FAILED = 5;

/** Unexpected internal failure. Indicates a Qyntra bug. */
export const EXIT_INTERNAL_ERROR = 70;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_QUALITY_GATE_FAILED
  | typeof EXIT_CONFIG_ERROR
  | typeof EXIT_MISSING_ARTIFACT
  | typeof EXIT_APPLICATION_UNREACHABLE
  | typeof EXIT_AUTHENTICATION_FAILED
  | typeof EXIT_INTERNAL_ERROR;

/**
 * Error carrying an explicit exit code, so stages can fail with a
 * meaningful status instead of calling process.exit() mid-module.
 */
export class QyntraError extends Error {
  readonly exitCode: ExitCode;
  readonly hint?: string;

  constructor(
    message: string,
    exitCode: ExitCode,
    hint?: string
  ) {
    super(message);
    this.name = 'QyntraError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export class ConfigError extends QyntraError {
  constructor(message: string, hint?: string) {
    super(message, EXIT_CONFIG_ERROR, hint);
    this.name = 'ConfigError';
  }
}

export class AuthenticationError extends QyntraError {
  constructor(message: string, hint?: string) {
    super(message, EXIT_AUTHENTICATION_FAILED, hint);
    this.name = 'AuthenticationError';
  }
}

export class MissingArtifactError extends QyntraError {
  constructor(message: string, hint?: string) {
    super(message, EXIT_MISSING_ARTIFACT, hint);
    this.name = 'MissingArtifactError';
  }
}
