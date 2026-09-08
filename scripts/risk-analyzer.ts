import fs from 'node:fs';
import path from 'node:path';

const requirement = process.argv.slice(2).join(' ').trim();

if (!requirement) {
  console.error(
    'Usage: npm run analyze:risk -- "User can complete a payment"'
  );
  process.exit(1);
}

const text = requirement.toLowerCase();

type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

interface Scenario {
  name: string;
  type: 'Positive' | 'Negative' | 'Edge';
  priority: 'P0' | 'P1' | 'P2';
}

interface RiskAnalysis {
  requirement: string;
  riskLevel: RiskLevel;
  riskScore: number;
  reasoning: string;
  scenarios: Scenario[];
}

function calculateRisk(): {
  level: RiskLevel;
  score: number;
  reasoning: string;
} {
  const criticalKeywords = [
    'payment',
    'checkout',
    'transaction',
    'bank',
    'money',
    'financial',
    'security',
    'authentication',
    'authorization',
  ];

  const highKeywords = [
    'login',
    'password',
    'signup',
    'register',
    'delete',
    'order',
    'purchase',
    'subscription',
    'refund',
  ];

  const mediumKeywords = [
    'create',
    'update',
    'edit',
    'upload',
    'profile',
    'search',
    'filter',
  ];

  if (criticalKeywords.some((keyword) => text.includes(keyword))) {
    return {
      level: 'CRITICAL',
      score: 9,
      reasoning:
        'The requirement involves a business-critical or security-sensitive operation where failures may cause financial, security, or customer-impacting issues.',
    };
  }

  if (highKeywords.some((keyword) => text.includes(keyword))) {
    return {
      level: 'HIGH',
      score: 7,
      reasoning:
        'The requirement involves an important user or business operation with potentially significant impact if it fails.',
    };
  }

  if (mediumKeywords.some((keyword) => text.includes(keyword))) {
    return {
      level: 'MEDIUM',
      score: 5,
      reasoning:
        'The requirement represents a standard application workflow that should have functional and negative coverage.',
    };
  }

  return {
    level: 'LOW',
    score: 2,
    reasoning:
      'The requirement appears to represent a lower-risk application behavior.',
  };
}

function generateScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];

  if (
    text.includes('payment') ||
    text.includes('checkout') ||
    text.includes('transaction')
  ) {
    scenarios.push(
      {
        name: 'Successful payment',
        type: 'Positive',
        priority: 'P0',
      },
      {
        name: 'Payment with invalid card',
        type: 'Negative',
        priority: 'P0',
      },
      {
        name: 'Payment with insufficient funds',
        type: 'Negative',
        priority: 'P0',
      },
      {
        name: 'Payment timeout',
        type: 'Edge',
        priority: 'P1',
      },
      {
        name: 'Duplicate payment attempt',
        type: 'Edge',
        priority: 'P0',
      },
      {
        name: 'Payment API failure',
        type: 'Negative',
        priority: 'P0',
      },
      {
        name: 'Payment retry',
        type: 'Edge',
        priority: 'P1',
      },
      {
        name: 'Currency mismatch',
        type: 'Negative',
        priority: 'P1',
      }
    );
  } else if (text.includes('login') || text.includes('sign in')) {
    scenarios.push(
      {
        name: 'Successful login',
        type: 'Positive',
        priority: 'P0',
      },
      {
        name: 'Invalid username or password',
        type: 'Negative',
        priority: 'P0',
      },
      {
        name: 'Empty credentials',
        type: 'Negative',
        priority: 'P1',
      },
      {
        name: 'Account lockout',
        type: 'Edge',
        priority: 'P0',
      },
      {
        name: 'Session expiration',
        type: 'Edge',
        priority: 'P1',
      }
    );
  } else if (text.includes('todo')) {
    scenarios.push(
      {
        name: 'Create Todo',
        type: 'Positive',
        priority: 'P0',
      },
      {
        name: 'Create multiple Todos',
        type: 'Positive',
        priority: 'P1',
      },
      {
        name: 'Complete Todo',
        type: 'Positive',
        priority: 'P1',
      },
      {
        name: 'Delete Todo',
        type: 'Positive',
        priority: 'P1',
      },
      {
        name: 'Create empty Todo',
        type: 'Negative',
        priority: 'P1',
      },
      {
        name: 'Create Todo with special characters',
        type: 'Edge',
        priority: 'P2',
      },
      {
        name: 'Create Todo with very long text',
        type: 'Edge',
        priority: 'P2',
      }
    );
  } else {
    scenarios.push(
      {
        name: 'Happy path',
        type: 'Positive',
        priority: 'P0',
      },
      {
        name: 'Invalid input',
        type: 'Negative',
        priority: 'P1',
      },
      {
        name: 'Empty input',
        type: 'Negative',
        priority: 'P1',
      },
      {
        name: 'Boundary condition',
        type: 'Edge',
        priority: 'P2',
      }
    );
  }

  return scenarios;
}

const risk = calculateRisk();

const analysis: RiskAnalysis = {
  requirement,
  riskLevel: risk.level,
  riskScore: risk.score,
  reasoning: risk.reasoning,
  scenarios: generateScenarios(),
};

const outputDir = path.join(process.cwd(), 'qyntra-dashboard');

fs.mkdirSync(outputDir, { recursive: true });

fs.writeFileSync(
  path.join(outputDir, 'risk-analysis.json'),
  JSON.stringify(analysis, null, 2)
);

console.log(`
╔════════════════════════════════════════════════════╗
║             QYNTRA RISK INTELLIGENCE              ║
╚════════════════════════════════════════════════════╝

Requirement : ${analysis.requirement}
Risk Level  : ${analysis.riskLevel}
Risk Score  : ${analysis.riskScore}/10

Reasoning
────────────────────────────────────────────────────
${analysis.reasoning}

Test Scenarios
────────────────────────────────────────────────────
`);

analysis.scenarios.forEach((scenario, index) => {
  console.log(
    `${index + 1}. [${scenario.priority}] ${scenario.name} (${scenario.type})`
  );
});

console.log(`
────────────────────────────────────────────────────

Scenarios : ${analysis.scenarios.length}

Analysis saved to:
qyntra-dashboard/risk-analysis.json
`);