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

export interface AIProvider {
  analyzeFailure(
    context: FailureContext
  ): Promise<AIAnalysis>;
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

  if ([401, 403, 429].includes(status)) {
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
