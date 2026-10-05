/**
 * Qyntra logging.
 *
 * Runs inside customer CI, so output has to stay readable in a plain
 * log viewer: no ANSI colour by default, no spinners, no cursor tricks.
 *
 * QYNTRA_LOG_FORMAT=json emits one JSON object per line instead, so
 * customers can ship Qyntra output into their own observability stack.
 */

export type LogLevel =
  | 'debug'
  | 'info'
  | 'warn'
  | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): LogLevel {
  const raw = String(
    process.env.QYNTRA_LOG_LEVEL ?? 'info'
  ).toLowerCase();

  if (raw in LEVEL_ORDER) {
    return raw as LogLevel;
  }

  return 'info';
}

function jsonMode(): boolean {
  return (
    String(
      process.env.QYNTRA_LOG_FORMAT ?? ''
    ).toLowerCase() === 'json'
  );
}

function enabled(level: LogLevel): boolean {
  return (
    LEVEL_ORDER[level] >=
    LEVEL_ORDER[configuredLevel()]
  );
}

function emit(
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>
): void {
  if (!enabled(level)) {
    return;
  }

  const stream =
    level === 'error' || level === 'warn'
      ? process.stderr
      : process.stdout;

  if (jsonMode()) {
    stream.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        message,
        ...fields,
      }) + '\n'
    );
    return;
  }

  const prefix =
    level === 'info'
      ? ''
      : `[${level.toUpperCase()}] `;

  stream.write(`${prefix}${message}\n`);

  // Human mode: render structured fields as aligned key/value lines
  // rather than inlining JSON into the message.
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      stream.write(`    ${key}: ${String(value)}\n`);
    }
  }
}

export const log = {
  debug: (
    message: string,
    fields?: Record<string, unknown>
  ) => emit('debug', message, fields),

  info: (
    message: string,
    fields?: Record<string, unknown>
  ) => emit('info', message, fields),

  warn: (
    message: string,
    fields?: Record<string, unknown>
  ) => emit('warn', message, fields),

  error: (
    message: string,
    fields?: Record<string, unknown>
  ) => emit('error', message, fields),

  /** Blank line in human mode; suppressed in JSON mode. */
  blank: () => {
    if (!jsonMode()) {
      process.stdout.write('\n');
    }
  },
};

/**
 * Stage banner. Kept as a single helper so every stage renders
 * identically and JSON mode stays parseable.
 */
export function stage(
  label: string
): void {
  if (jsonMode()) {
    emit('info', label, { qyntraStage: label });
    return;
  }

  log.blank();
  process.stdout.write(
    '----------------------------------------------------\n'
  );
  process.stdout.write(`${label}\n`);
  process.stdout.write(
    '----------------------------------------------------\n'
  );
}

/**
 * Redact values that look like credentials before they reach a log
 * line. Customer CI logs are frequently world-readable inside an org.
 */
export function redact(
  value: string
): string {
  return String(value).replace(
    /((?:password|passwd|secret|token|api[-_]?key|authorization)["'\s:=]+)([^\s"',&]+)/gi,
    (_match, label: string) => `${label}***`
  );
}
