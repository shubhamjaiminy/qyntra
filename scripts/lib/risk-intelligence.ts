/**
 * Risk Intelligence.
 *
 * Replaces the original keyword matcher, which decided risk from the
 * wording of the requirement:
 *
 *   if (text.includes('payment')) return { level: 'CRITICAL', score: 9 }
 *
 * That is indefensible in front of a customer. It rates "remove the
 * payment reminder tooltip" as CRITICAL and "transfer funds between
 * accounts" as LOW, and it cannot show any evidence for either call.
 *
 * Risk is a property of the application surface a change touches, so it
 * is derived from what discovery actually observed in the running app:
 * payment indicators, credential inputs, destructive controls, backend
 * endpoints in the blast radius. Requirement wording is kept as a
 * secondary signal for surfaces discovery could not reach (typically
 * behind authentication), but it is capped — wording alone can never
 * produce a CRITICAL rating, because wording is not evidence.
 *
 * Every factor is emitted with its own points and the evidence behind
 * it, so "why is this HIGH?" has a concrete answer.
 *
 * Pure functions only — no file or network I/O — so the rating logic is
 * testable without running a browser.
 */

export type RiskLevel =
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH'
  | 'CRITICAL';

// --------------------------------------------------
// INPUT: the application map, loosely typed
// --------------------------------------------------

/**
 * Shape of the fields this module reads from application-map.json.
 * Everything is optional: the map is JSON from a previous stage that
 * may have been produced by an older Qyntra version, or truncated by a
 * discovery run that hit an unreachable page.
 */
export interface DiscoveredSurface {
  application?: {
    title?: string;
    url?: string;
    framework?: string;
  };

  inputs?: {
    type?: string;
    purpose?: string;
    selector?: string;
    placeholder?: string;
    name?: string;
  }[];

  buttons?: {
    text?: string;
    selector?: string;
    ariaLabel?: string;
  }[];

  capabilities?: {
    name?: string;
    confidence?: string;
    evidence?: string;
  }[];

  todoStructure?: {
    detected?: boolean;
    delete?: string | null;
  };

  dynamicDiscovery?: {
    enabled?: boolean;
    actions?: {
      action?: string;
      status?: string;
    }[];
  };

  network?: {
    requests?: string[];
    apiEndpoints?: string[];
  };

  metadata?: {
    forms?: number;
    authenticationIndicators?: string[];
    paymentIndicators?: string[];
  };
}

// --------------------------------------------------
// OUTPUT
// --------------------------------------------------

export type RiskFactorSource =
  /** Observed in the running application by discovery. */
  | 'discovered'
  /** Inferred from the requirement text, not observed. */
  | 'requirement';

export interface RiskFactor {
  points: number;
  reason: string;
  source: RiskFactorSource;

  /** What was actually seen. Empty for requirement-derived factors. */
  evidence?: string;
}

/** The observable properties that drive the rating. */
export interface SurfaceProfile {
  handlesPayments: boolean;
  handlesCredentials: boolean;
  requiresAuthentication: boolean;
  destructiveActions: number;
  fileUploads: number;
  apiEndpoints: number;
  forms: number;
  mutations: number;
}

export interface Scenario {
  name: string;
  type: 'Positive' | 'Negative' | 'Edge';
  priority: 'P0' | 'P1' | 'P2';

  /** Why Qyntra thinks this scenario is worth testing. */
  rationale: string;
}

export interface RiskAssessment {
  requirement: string;

  riskLevel: RiskLevel;

  /** 0-10, rounded to one decimal. */
  riskScore: number;

  /** How much evidence backs the rating. */
  confidence: 'Low' | 'Medium' | 'High';

  reasoning: string;

  /** Itemised, auditable. Sums (before clamping) to riskScore. */
  factors: RiskFactor[];

  surface: SurfaceProfile;

  /**
   * 'application-map' when discovery evidence drove the rating,
   * 'requirement-text' when Qyntra had to fall back to wording.
   */
  derivedFrom: 'application-map' | 'requirement-text';

  scenarios: Scenario[];
}

// --------------------------------------------------
// WEIGHTS
// --------------------------------------------------

/**
 * Evidence weights, on a 0-10 scale.
 *
 * Calibrated so that a single observed payment surface reaches HIGH on
 * its own and tips to CRITICAL as soon as any second risk factor is
 * present, while an app with only read surfaces stays LOW.
 */
const WEIGHT = {
  payments: 4,
  credentials: 3,
  destructiveAction: 1.5,
  destructiveActionCap: 3,
  fileUpload: 1,
  fileUploadCap: 2,
  apiEndpoints: 1,
  manyApiEndpoints: 2,
  forms: 1,
  mutations: 1,
} as const;

/**
 * Requirement wording is a weak signal, so its total contribution is
 * capped. Without this cap the module would relapse into the keyword
 * matching it exists to replace.
 */
const REQUIREMENT_CAP = 3;

/**
 * Ceiling applied when there is no discovery evidence at all. Wording
 * alone should raise an eyebrow, never block a release as CRITICAL.
 */
const REQUIREMENT_ONLY_CEILING = 7.5;

const CRITICAL_KEYWORDS = [
  'payment',
  'checkout',
  'transaction',
  'bank',
  'money',
  'invoice',
  'billing',
  'refund',
  'security',
  'authentication',
  'authorization',
  'permission',
  'personal data',
  'pii',
];

const HIGH_KEYWORDS = [
  'login',
  'sign in',
  'password',
  'signup',
  'register',
  'delete',
  'remove',
  'order',
  'purchase',
  'subscription',
  'export',
  'migrate',
];

const MEDIUM_KEYWORDS = [
  'create',
  'update',
  'edit',
  'upload',
  'profile',
  'search',
  'filter',
  'settings',
];

const DESTRUCTIVE_PATTERN =
  /\b(delete|remove|destroy|discard|clear|revoke|cancel|deactivate|archive)\b/i;

// --------------------------------------------------
// SURFACE PROFILING
// --------------------------------------------------

function textOf(
  ...values: (string | null | undefined)[]
): string {
  return values
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * Reduce the application map to the handful of properties that actually
 * change how risky a change is.
 */
export function profileSurface(
  surface: DiscoveredSurface | undefined
): SurfaceProfile {
  const inputs = surface?.inputs ?? [];
  const buttons = surface?.buttons ?? [];
  const capabilities = surface?.capabilities ?? [];
  const metadata = surface?.metadata ?? {};

  const capabilityText = textOf(
    ...capabilities.map((capability) => capability.name)
  );

  const handlesCredentials =
    (metadata.authenticationIndicators?.length ?? 0) > 0 ||
    inputs.some(
      (input) =>
        input.purpose === 'PASSWORD_INPUT' ||
        input.type === 'password'
    ) ||
    /\b(login|sign in|authentication)\b/.test(capabilityText);

  const handlesPayments =
    (metadata.paymentIndicators?.length ?? 0) > 0 ||
    /\b(payment|checkout|card)\b/.test(capabilityText) ||
    inputs.some((input) => input.purpose === 'AMOUNT_INPUT');

  // Destructive controls are counted from discovered UI, not guessed
  // from the requirement: a delete button that exists is a data-loss
  // path whether or not the requirement mentions deleting.
  const destructiveButtons = buttons.filter((button) =>
    DESTRUCTIVE_PATTERN.test(
      textOf(button.text, button.ariaLabel, button.selector)
    )
  ).length;

  const destructiveCapabilities = capabilities.filter((capability) =>
    DESTRUCTIVE_PATTERN.test(String(capability.name ?? ''))
  ).length;

  const destructiveStructure =
    surface?.todoStructure?.detected === true &&
    Boolean(surface.todoStructure.delete)
      ? 1
      : 0;

  const fileUploads = inputs.filter(
    (input) => input.type === 'file'
  ).length;

  const mutations = capabilities.filter((capability) =>
    /\b(create|add|update|edit|submit|save)\b/i.test(
      String(capability.name ?? '')
    )
  ).length;

  return {
    handlesPayments,
    handlesCredentials,
    requiresAuthentication:
      (metadata.authenticationIndicators?.length ?? 0) > 0,
    destructiveActions:
      destructiveButtons +
      destructiveCapabilities +
      destructiveStructure,
    fileUploads,
    apiEndpoints: surface?.network?.apiEndpoints?.length ?? 0,
    forms: metadata.forms ?? 0,
    mutations,
  };
}

/**
 * True when the map carries enough signal to rate risk from evidence.
 *
 * A map from a page that failed to load has an application block and
 * nothing else; rating that as LOW would be a false reassurance, so it
 * is treated as "no evidence" and falls through to requirement text.
 */
function hasUsableEvidence(
  surface: DiscoveredSurface | undefined,
  profile: SurfaceProfile
): boolean {
  if (surface === undefined) {
    return false;
  }

  const observedElements =
    (surface.inputs?.length ?? 0) +
    (surface.buttons?.length ?? 0) +
    (surface.capabilities?.length ?? 0);

  return (
    observedElements > 0 ||
    profile.apiEndpoints > 0 ||
    profile.forms > 0
  );
}

// --------------------------------------------------
// RATING
// --------------------------------------------------

function levelFor(score: number): RiskLevel {
  if (score >= 8) {
    return 'CRITICAL';
  }

  if (score >= 6) {
    return 'HIGH';
  }

  if (score >= 3.5) {
    return 'MEDIUM';
  }

  return 'LOW';
}

function requirementFactors(
  requirement: string
): RiskFactor[] {
  const text = requirement.toLowerCase();
  const factors: RiskFactor[] = [];

  const matched = (keywords: string[]): string[] =>
    keywords.filter((keyword) => text.includes(keyword));

  const critical = matched(CRITICAL_KEYWORDS);
  const high = matched(HIGH_KEYWORDS);
  const medium = matched(MEDIUM_KEYWORDS);

  if (critical.length > 0) {
    factors.push({
      points: 2,
      source: 'requirement',
      reason:
        'Requirement wording suggests a business-critical or ' +
        `security-sensitive operation (${critical.join(', ')})`,
    });
  }

  if (high.length > 0) {
    factors.push({
      points: 1.5,
      source: 'requirement',
      reason:
        'Requirement wording suggests a significant user or business ' +
        `operation (${high.join(', ')})`,
    });
  }

  if (medium.length > 0 && critical.length === 0 && high.length === 0) {
    factors.push({
      points: 1,
      source: 'requirement',
      reason:
        'Requirement wording suggests a standard mutating workflow ' +
        `(${medium.join(', ')})`,
    });
  }

  // Trim to the cap from the lowest-value factor up, so the strongest
  // wording signal survives.
  let total = factors.reduce((sum, factor) => sum + factor.points, 0);

  while (total > REQUIREMENT_CAP && factors.length > 1) {
    const weakest = factors.pop();
    total -= weakest?.points ?? 0;
  }

  return factors;
}

function discoveredFactors(
  profile: SurfaceProfile,
  surface: DiscoveredSurface
): RiskFactor[] {
  const factors: RiskFactor[] = [];
  const metadata = surface.metadata ?? {};

  if (profile.handlesPayments) {
    factors.push({
      points: WEIGHT.payments,
      source: 'discovered',
      reason: 'Application handles payments or monetary amounts',
      evidence:
        metadata.paymentIndicators?.length
          ? `Payment indicators observed: ${metadata.paymentIndicators.join(', ')}`
          : 'Payment or amount capability detected during discovery',
    });
  }

  if (profile.handlesCredentials) {
    factors.push({
      points: WEIGHT.credentials,
      source: 'discovered',
      reason: 'Application handles credentials or authentication',
      evidence:
        metadata.authenticationIndicators?.length
          ? `Authentication indicators observed: ${metadata.authenticationIndicators.join(', ')}`
          : 'Password input or login capability detected during discovery',
    });
  }

  if (profile.destructiveActions > 0) {
    const points = Math.min(
      profile.destructiveActions * WEIGHT.destructiveAction,
      WEIGHT.destructiveActionCap
    );

    factors.push({
      points,
      source: 'discovered',
      reason:
        `${profile.destructiveActions} destructive action(s) reachable ` +
        'in the UI (data loss path)',
      evidence:
        'Delete/remove style controls found in the discovered element set',
    });
  }

  if (profile.fileUploads > 0) {
    factors.push({
      points: Math.min(
        profile.fileUploads * WEIGHT.fileUpload,
        WEIGHT.fileUploadCap
      ),
      source: 'discovered',
      reason: `${profile.fileUploads} file upload input(s)`,
      evidence: 'File inputs widen the untrusted input surface',
    });
  }

  if (profile.apiEndpoints > 0) {
    const many = profile.apiEndpoints > 5;

    factors.push({
      points: many ? WEIGHT.manyApiEndpoints : WEIGHT.apiEndpoints,
      source: 'discovered',
      reason:
        `${profile.apiEndpoints} backend endpoint(s) in the blast radius`,
      evidence:
        (surface.network?.apiEndpoints ?? [])
          .slice(0, 5)
          .join(', ') || 'Observed during discovery',
    });
  }

  if (profile.forms > 2) {
    factors.push({
      points: WEIGHT.forms,
      source: 'discovered',
      reason: `${profile.forms} forms (multiple mutation entry points)`,
      evidence: 'Form count from discovery metadata',
    });
  }

  if (profile.mutations > 0) {
    factors.push({
      points: WEIGHT.mutations,
      source: 'discovered',
      reason: 'Application exposes state-changing capabilities',
      evidence: (surface.capabilities ?? [])
        .filter((capability) =>
          /\b(create|add|update|edit|submit|save)\b/i.test(
            String(capability.name ?? '')
          )
        )
        .map((capability) => capability.name)
        .join(', '),
    });
  }

  return factors;
}

function buildReasoning(
  level: RiskLevel,
  derivedFrom: RiskAssessment['derivedFrom'],
  factors: RiskFactor[]
): string {
  const top = factors
    .slice()
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map((factor) => factor.reason.toLowerCase());

  if (derivedFrom === 'requirement-text') {
    return (
      `Rated ${level} from requirement wording only. Discovery observed ` +
      'no usable application surface, so this rating is not backed by ' +
      'evidence from the running app. If the relevant flow sits behind ' +
      'authentication, configure app.auth so Qyntra can reach it.'
    );
  }

  if (top.length === 0) {
    return (
      `Rated ${level}. Discovery found no payment, credential, ` +
      'destructive or integration surface on the pages it reached.'
    );
  }

  return (
    `Rated ${level} because discovery observed: ${top.join('; ')}.`
  );
}

// --------------------------------------------------
// SCENARIOS
// --------------------------------------------------

/**
 * Derive the scenario set from observed capabilities first, falling back
 * to requirement wording. Every scenario carries the reason it exists,
 * so a reviewer can tell an evidence-backed scenario from a guess.
 */
function deriveScenarios(
  requirement: string,
  profile: SurfaceProfile,
  surface: DiscoveredSurface | undefined,
  evidenceBacked: boolean
): Scenario[] {
  const scenarios: Scenario[] = [];
  const text = requirement.toLowerCase();

  const capabilityNames = (surface?.capabilities ?? [])
    .map((capability) => String(capability.name ?? '').toLowerCase());

  const has = (pattern: RegExp): boolean =>
    capabilityNames.some((name) => pattern.test(name));

  if (profile.handlesPayments) {
    scenarios.push(
      {
        name: 'Successful payment',
        type: 'Positive',
        priority: 'P0',
        rationale: 'Payment surface observed during discovery',
      },
      {
        name: 'Payment with invalid card',
        type: 'Negative',
        priority: 'P0',
        rationale: 'Payment surface observed during discovery',
      },
      {
        name: 'Payment declined by provider',
        type: 'Negative',
        priority: 'P0',
        rationale: 'Provider failure is the most common payment incident',
      },
      {
        name: 'Duplicate payment attempt',
        type: 'Edge',
        priority: 'P0',
        rationale: 'Double charging is the highest-cost payment defect',
      },
      {
        name: 'Payment timeout and retry',
        type: 'Edge',
        priority: 'P1',
        rationale: 'Payment surface observed during discovery',
      }
    );
  }

  if (profile.handlesCredentials) {
    scenarios.push(
      {
        name: 'Successful authentication',
        type: 'Positive',
        priority: 'P0',
        rationale: 'Credential input observed during discovery',
      },
      {
        name: 'Invalid credentials rejected',
        type: 'Negative',
        priority: 'P0',
        rationale: 'Credential input observed during discovery',
      },
      {
        name: 'Empty credentials validated',
        type: 'Negative',
        priority: 'P1',
        rationale: 'Credential input observed during discovery',
      },
      {
        name: 'Session expiry handled',
        type: 'Edge',
        priority: 'P1',
        rationale: 'Authenticated surfaces must handle expired sessions',
      }
    );
  }

  if (profile.mutations > 0 || has(/create|add/)) {
    scenarios.push(
      {
        name: 'Create entity with valid input',
        type: 'Positive',
        priority: 'P0',
        rationale: 'State-changing capability observed during discovery',
      },
      {
        name: 'Create entity with empty input',
        type: 'Negative',
        priority: 'P1',
        rationale: 'State-changing capability observed during discovery',
      },
      {
        name: 'Create entity with special characters',
        type: 'Edge',
        priority: 'P2',
        rationale: 'Input sanitisation on an observed mutation path',
      },
      {
        name: 'Create entity with boundary-length input',
        type: 'Edge',
        priority: 'P2',
        rationale: 'Input sanitisation on an observed mutation path',
      }
    );
  }

  if (profile.destructiveActions > 0) {
    scenarios.push(
      {
        name: 'Delete entity',
        type: 'Positive',
        priority: 'P1',
        rationale: 'Destructive control observed in the UI',
      },
      {
        name: 'Deleted entity does not reappear',
        type: 'Edge',
        priority: 'P1',
        rationale: 'Destructive control observed in the UI',
      }
    );
  }

  if (profile.fileUploads > 0) {
    scenarios.push({
      name: 'Reject oversized or unsupported upload',
      type: 'Negative',
      priority: 'P1',
      rationale: 'File input observed during discovery',
    });
  }

  if (has(/search/) || text.includes('search')) {
    scenarios.push(
      {
        name: 'Search returns relevant results',
        type: 'Positive',
        priority: 'P1',
        rationale: has(/search/)
          ? 'Search capability observed during discovery'
          : 'Requirement mentions search',
      },
      {
        name: 'Search with no matches',
        type: 'Edge',
        priority: 'P2',
        rationale: 'Empty result sets are a common rendering defect',
      }
    );
  }

  // Nothing observed and nothing matched: emit a generic baseline
  // rather than claiming zero scenarios are needed.
  if (scenarios.length === 0) {
    scenarios.push(
      {
        name: 'Happy path',
        type: 'Positive',
        priority: 'P0',
        rationale: evidenceBacked
          ? 'No specific risk surface observed; baseline coverage'
          : 'No discovery evidence available; baseline coverage',
      },
      {
        name: 'Invalid input',
        type: 'Negative',
        priority: 'P1',
        rationale: 'Baseline negative coverage',
      },
      {
        name: 'Empty input',
        type: 'Negative',
        priority: 'P1',
        rationale: 'Baseline negative coverage',
      },
      {
        name: 'Boundary condition',
        type: 'Edge',
        priority: 'P2',
        rationale: 'Baseline edge coverage',
      }
    );
  }

  return scenarios;
}

// --------------------------------------------------
// ENTRY POINT
// --------------------------------------------------

export function assessRisk(
  requirement: string,
  surface: DiscoveredSurface | undefined
): RiskAssessment {
  const profile = profileSurface(surface);
  const evidenceBacked = hasUsableEvidence(surface, profile);

  const factors: RiskFactor[] = evidenceBacked
    ? [
        ...discoveredFactors(profile, surface as DiscoveredSurface),
        ...requirementFactors(requirement),
      ]
    : requirementFactors(requirement);

  const rawScore = factors.reduce(
    (sum, factor) => sum + factor.points,
    0
  );

  const ceiling = evidenceBacked ? 10 : REQUIREMENT_ONLY_CEILING;

  const riskScore =
    Math.round(Math.min(rawScore, ceiling) * 10) / 10;

  const derivedFrom = evidenceBacked
    ? 'application-map'
    : 'requirement-text';

  // Confidence describes the evidence behind the rating, not the
  // severity of the rating itself.
  let confidence: RiskAssessment['confidence'] = 'Low';

  if (evidenceBacked) {
    const discoveredCount = factors.filter(
      (factor) => factor.source === 'discovered'
    ).length;

    const explored =
      surface?.dynamicDiscovery?.enabled === true;

    confidence =
      discoveredCount >= 2 && explored
        ? 'High'
        : discoveredCount >= 1
          ? 'Medium'
          : 'Medium';
  }

  const riskLevel = levelFor(riskScore);

  return {
    requirement,
    riskLevel,
    riskScore,
    confidence,
    reasoning: buildReasoning(riskLevel, derivedFrom, factors),
    factors,
    surface: profile,
    derivedFrom,
    scenarios: deriveScenarios(
      requirement,
      profile,
      surface,
      evidenceBacked
    ),
  };
}

/**
 * Render an assessment for a CI log. Kept beside the logic so the
 * console output and the JSON artifact cannot drift apart.
 */
export function formatRisk(
  assessment: RiskAssessment
): string {
  const lines: string[] = [];

  lines.push(`Requirement : ${assessment.requirement}`);
  lines.push(`Risk Level  : ${assessment.riskLevel}`);
  lines.push(`Risk Score  : ${assessment.riskScore}/10`);
  lines.push(`Confidence  : ${assessment.confidence}`);
  lines.push(
    `Derived From: ${
      assessment.derivedFrom === 'application-map'
        ? 'observed application surface'
        : 'requirement wording (no discovery evidence)'
    }`
  );

  lines.push('');
  lines.push('Reasoning');
  lines.push('────────────────────────────────────────────────────');
  lines.push(assessment.reasoning);

  lines.push('');
  lines.push('Risk factors');
  lines.push('────────────────────────────────────────────────────');

  if (assessment.factors.length === 0) {
    lines.push('  (none — no risk signals found)');
  }

  for (const factor of assessment.factors) {
    lines.push(
      `  +${factor.points}  [${factor.source}] ${factor.reason}`
    );

    if (factor.evidence) {
      lines.push(`         └─ ${factor.evidence}`);
    }
  }

  return lines.join('\n');
}
