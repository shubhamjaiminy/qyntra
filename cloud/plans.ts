/**
 * Plans and what each allows. Enforced where usage happens — creating a
 * project, inviting a member, ingesting a run — so the limits in the UI
 * and the limits in the API cannot disagree.
 */

export interface PlanLimits {
  name: string;
  /** Monthly price in USD, per project for Team; undefined for custom. */
  price?: number;
  perProject: boolean;
  projects: number;
  members: number;
  runsPerMonth: number;
  retentionDays: number;
  features: string[];
}

export const PLANS: Record<string, PlanLimits> = {
  free: {
    name: 'Free',
    price: 0,
    perProject: false,
    projects: 1,
    members: 3,
    runsPerMonth: 300,
    retentionDays: 30,
    features: ['1 project', '300 runs a month', '30 days of history', 'Release decisions and test history'],
  },
  team: {
    name: 'Team',
    price: 49,
    perProject: true,
    projects: 10,
    members: 10,
    runsPerMonth: 10_000,
    retentionDays: 395,
    features: ['Up to 10 projects, $49 each', '10,000 runs a month', '13 months of history', 'Feature and app reports', 'Release track record', 'Slack and GitHub alerts'],
  },
  business: {
    name: 'Business',
    price: 299,
    perProject: false,
    projects: 50,
    members: 1_000,
    runsPerMonth: 100_000,
    retentionDays: 395,
    features: ['Up to 50 projects', 'Unlimited members', '100,000 runs a month', 'Audit log export', 'Priority support'],
  },
  enterprise: {
    name: 'Enterprise',
    perProject: false,
    projects: 10_000,
    members: 100_000,
    runsPerMonth: 10_000_000,
    retentionDays: 3_650,
    features: ['Custom limits', 'SSO / SAML', 'Retention and region control', 'SLA', 'Security review support'],
  },
};

export function limitsFor(plan: string): PlanLimits {
  return PLANS[plan] ?? PLANS.free;
}

/** A sentence explaining a limit that was hit, or undefined. */
export function limitProblem(
  plan: string,
  usage: { projects?: number; members?: number; runsThisMonth?: number },
  adding: 'project' | 'member' | 'run'
): string | undefined {
  const limits = limitsFor(plan);

  if (adding === 'project' && (usage.projects ?? 0) >= limits.projects) {
    return `The ${limits.name} plan includes ${limits.projects} project(s). Upgrade to add more.`;
  }

  if (adding === 'member' && (usage.members ?? 0) >= limits.members) {
    return `The ${limits.name} plan includes ${limits.members} member(s). Upgrade to invite more.`;
  }

  if (adding === 'run' && (usage.runsThisMonth ?? 0) >= limits.runsPerMonth) {
    return `This organization has used its ${limits.runsPerMonth} runs for this month on the ${limits.name} plan. Upgrade, or runs will be accepted again on the 1st.`;
  }

  return undefined;
}
