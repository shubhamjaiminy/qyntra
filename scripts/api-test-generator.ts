/**
 * API Test Generation stage.
 *
 * Two sources, one plan:
 *   - the OpenAPI spec in api.openapi, when configured — the documented
 *     contract, including endpoints no page ever calls;
 *   - the API calls discovery observed (application-map.json →
 *     network.apiCalls) — what the application really does.
 *
 * Where both cover an endpoint, the spec wins: it says which fields are
 * required instead of guessing from samples. Specs are written next to
 * the generated UI tests, so `qyntra run` executes and gates on both.
 * The logic lives in lib/openapi and lib/api-tests; this file is I/O
 * and presentation.
 */

import fs from 'fs';
import path from 'path';

import dotenv from 'dotenv';

import type { ApiCall } from './lib/api-observation';
import { generateApiSpecs, type SkippedApiCall } from './lib/api-tests';
import { stageApiConfig } from './lib/config';
import { planFromOpenApi, type OpenApiPlan } from './lib/openapi';
import { loadOpenApi } from './lib/openapi-loader';
import { readOptionalArtifact, stagePaths, writeArtifact } from './lib/paths';

dotenv.config({ quiet: true });

/** One key per endpoint, whichever source named its parameters how. */
function endpointKey(call: ApiCall): string {
  return `${call.method} ${new URL(call.url).origin}${call.template.replace(/\{[^}]+\}/g, '{id}')}`;
}

async function main(): Promise<void> {
  const paths = stagePaths();
  const apiConfig = stageApiConfig();

  const applicationMap = readOptionalArtifact<{
    network?: { apiCalls?: ApiCall[] };
  }>(paths.applicationMap);

  const observed = applicationMap?.network?.apiCalls ?? [];

  let plan: OpenApiPlan | undefined;
  let specError: string | undefined;

  if (apiConfig.openapi) {
    try {
      const spec = await loadOpenApi(apiConfig.openapi, process.cwd());

      plan = planFromOpenApi(spec.doc, {
        specLocation: spec.location,
        baseUrl: apiConfig.baseUrl,
        appBaseUrl: process.env.QYNTRA_BASE_URL,
        parameters: apiConfig.parameters,
        exclude: apiConfig.exclude,
        auth: apiConfig.auth,
      });
    } catch (error: any) {
      // A broken spec must be loud, but must not take observed-traffic
      // tests down with it.
      specError = error?.message ?? String(error);
    }
  }

  const documented = plan?.calls ?? [];
  const documentedKeys = new Set(documented.map(endpointKey));

  const calls = [
    ...documented,
    ...observed.filter((call) => !documentedKeys.has(endpointKey(call))),
  ];

  fs.mkdirSync(paths.generatedTests, { recursive: true });

  // Only this stage's own files: the UI generator owns the rest.
  for (const file of fs.readdirSync(paths.generatedTests)) {
    if (/^api-\d+-.*\.spec\.ts$/.test(file)) {
      fs.rmSync(path.join(paths.generatedTests, file));
    }
  }

  const generation = generateApiSpecs(calls);
  const skipped: SkippedApiCall[] = [...(plan?.skipped ?? []), ...generation.skipped];

  for (const spec of generation.specs) {
    fs.writeFileSync(path.join(paths.generatedTests, spec.fileName), spec.source);
  }

  writeArtifact(paths.apiGeneration, {
    generatedAt: new Date().toISOString(),
    observedCalls: observed.length,
    ...(apiConfig.openapi
      ? {
          openapi: {
            location: apiConfig.openapi,
            ...(plan
              ? {
                  title: plan.title,
                  version: plan.version,
                  server: plan.server,
                  operations: plan.totalOperations,
                  planned: documented.length,
                }
              : { error: specError }),
          },
        }
      : {}),
    files: generation.specs.map((spec) => ({ file: spec.fileName, tests: spec.tests })),
    skipped,

    // The endpoints chosen for testing, for the performance stage to
    // measure — the same set, so the two can never disagree.
    endpoints: calls
      .filter((call) => call.method === 'GET' && call.status >= 200 && call.status < 300)
      .map((call) => ({
        method: call.method,
        url: call.url,
        template: call.template,
        auth: call.auth,
        ...(call.authHeader ? { authHeader: call.authHeader } : {}),
      })),
  });

  console.log(`
======================================
QYNTRA API TEST GENERATOR
======================================
`);

  if (plan) {
    console.log(`OpenAPI spec       : ${plan.title} ${plan.version}`);
    console.log(`API server         : ${plan.server}`);
    console.log(`Documented ops     : ${plan.totalOperations} (${documented.length} testable)`);
  } else if (specError) {
    console.log(`✗ OpenAPI spec could not be used: ${specError}`);
  }

  console.log(`Observed API calls : ${observed.length}`);
  console.log(`Spec files written : ${generation.specs.length}`);
  console.log('');

  for (const spec of generation.specs) {
    console.log(`✓ ${spec.fileName}`);

    for (const test of spec.tests) {
      console.log(`   └─ ${test}`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\nNot tested (${skipped.length}):`);

    for (const entry of skipped) {
      console.log(`– ${entry.call}: ${entry.reason}`);
    }
  }

  if (calls.length === 0 && !apiConfig.openapi) {
    console.log(
      'No API calls observed. The pages discovery reached made no XHR/fetch ' +
        'requests to a JSON API. To test an API directly, set api.openapi.'
    );
  }

  console.log(`\nSummary: ${paths.apiGeneration}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(70);
});
