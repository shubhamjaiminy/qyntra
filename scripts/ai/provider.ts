export interface FailureContext {
  test: string;
  category: string;
  error: string;
  stackTrace: string;
  sourceCode: string;
  applicationMap: unknown;

  /**
   * What the browser saw: console and page errors, failed requests,
   * the test's steps and a page snapshot. Already sanitised.
   */
  evidence?: {
    pageSnapshot?: string;
    consoleErrors: string[];
    pageErrors: string[];
    failedRequests: {
      method: string;
      url: string;
      status: number;
      failure?: string;
      resourceType?: string;
    }[];
    steps: string[];
    domElements?: string[];
  };

  /**
   * Failure screenshot, for providers that accept images. Sent as an
   * image part, never inside the JSON text.
   */
  screenshot?: {
    mimeType: string;
    base64: string;
  };
}

export interface AIAnalysis {
  category: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  confidence: number;
  rootCause: string;
  whyItHappened: string;
  recommendation: string;
  suggestedFix: string;
  suggestedCode: string;
  isLikelyTestDefect: boolean;
  isLikelyProductDefect: boolean;
}

/** One structured request, independent of what it is for. */
export interface CompletionRequest {
  system: string;
  user: string;

  /** JSON Schema for the response; enforced where the provider can. */
  schema: object;

  screenshot?: FailureContext['screenshot'];
}

export interface AIProvider {
  analyzeFailure(
    context: FailureContext
  ): Promise<AIAnalysis>;

  /**
   * Send a request and return the raw JSON text. Callers parse and
   * validate it; diagnosis and repair share this so a provider only
   * has to implement transport once.
   */
  completeJSON(
    request: CompletionRequest
  ): Promise<string>;
}

/**
 * The provider cannot answer any request right now: out of quota, bad
 * key, or not running. Distinct from a single bad response, so the
 * analyzer stops retrying it for every remaining failure.
 */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * Classify an SDK or fetch error. Quota, auth and connection failures
 * will repeat for every call; anything else is specific to one failure.
 */
export function isProviderOutage(error: any): boolean {
  if (error instanceof ProviderUnavailableError) {
    return true;
  }

  const status = Number(error?.status ?? error?.code);

  // 404: the model is retired or misspelt, and will be on every call.
  // 5xx: callers reach this only after withRetry gave up, so the
  // provider is down rather than briefly overloaded.
  if ([401, 403, 404, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const text = String(
    `${error?.message ?? ''} ${error?.cause?.code ?? ''}`
  ).toLowerCase();

  return (
    text.includes('econnrefused') ||
    text.includes('fetch failed') ||
    text.includes('enotfound') ||
    text.includes('quota') ||
    text.includes('api key')
  );
}

/** Waits between retries of a transient provider error. */
export const RETRY_DELAYS_MS = [2_000, 6_000, 15_000];

/**
 * True for errors that a short wait can fix: overload (503), gateway
 * errors, and rate limits. A 429 that says the account is out of
 * quota or credits is not transient — retrying only delays the
 * fallback.
 */
export function isTransient(error: any): boolean {
  const status = Number(error?.status ?? error?.code);
  const text = String(error?.message ?? '').toLowerCase();

  if (status === 429) {
    return !/quota|credit|billing|insufficient/.test(text);
  }

  return (
    [500, 502, 503, 504].includes(status) ||
    /econnreset|etimedout|socket hang up/.test(text)
  );
}

/**
 * Run `call`, retrying transient failures with backoff. Cloud models
 * return 503 "high demand" routinely; without this a busy minute at
 * the provider downgrades a whole CI run to the deterministic analyzer.
 */
export async function withRetry<T>(
  call: () => Promise<T>,
  delaysMs: number[] = RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= delaysMs.length || !isTransient(error)) {
        throw error;
      }

      // Jitter, so parallel CI jobs do not retry in lockstep.
      await sleep(delaysMs[attempt] * (0.75 + Math.random() * 0.5));
    }
  }
}

/** Smallest real request, used by `qyntra doctor` to prove the model answers. */
export const PING_REQUEST: CompletionRequest = {
  system: 'Reply with the JSON object {"ok": true} and nothing else.',
  user: 'ping',
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
};

