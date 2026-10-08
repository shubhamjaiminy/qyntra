/**
 * Load an OpenAPI document from a repository path or a URL, as JSON or
 * YAML. Kept apart from lib/openapi so the planner stays pure.
 */

import fs from 'fs';
import path from 'path';

import { OpenApiError } from './openapi';

const FETCH_TIMEOUT_MS = 30_000;

/** Specs are large but not this large; refuse rather than hang. */
const MAX_SPEC_BYTES = 20 * 1024 * 1024;

export interface LoadedSpec {
  doc: any;
  /** Absolute path or URL, for resolving relative server URLs. */
  location: string;
}

export async function loadOpenApi(
  location: string,
  rootDir: string
): Promise<LoadedSpec> {
  const isUrl = /^https?:\/\//i.test(location);
  const resolved = isUrl ? location : path.resolve(rootDir, location);

  let text: string;

  if (isUrl) {
    let response: Response;

    try {
      response = await fetch(resolved, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error: any) {
      throw new OpenApiError(
        `Could not fetch the OpenAPI spec at ${resolved}: ${error?.cause?.code ?? error?.message}`
      );
    }

    if (!response.ok) {
      throw new OpenApiError(`Fetching the OpenAPI spec at ${resolved} returned HTTP ${response.status}.`);
    }

    text = await response.text();
  } else {
    if (!fs.existsSync(resolved)) {
      throw new OpenApiError(`OpenAPI spec not found: ${resolved}`);
    }

    if (fs.statSync(resolved).size > MAX_SPEC_BYTES) {
      throw new OpenApiError(`OpenAPI spec is larger than 20 MB: ${resolved}`);
    }

    text = fs.readFileSync(resolved, 'utf-8');
  }

  return { doc: parseSpec(text, resolved), location: resolved };
}

/** JSON first; YAML otherwise. The YAML parser loads only when needed. */
export function parseSpec(text: string, location: string): any {
  const trimmed = text.trimStart();

  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch (error: any) {
      throw new OpenApiError(`OpenAPI spec is not valid JSON (${location}): ${error?.message}`);
    }
  }

  try {
    const { parse } = require('yaml') as typeof import('yaml');
    return parse(text, { maxAliasCount: 1_000 });
  } catch (error: any) {
    throw new OpenApiError(`OpenAPI spec is not valid YAML (${location}): ${error?.message}`);
  }
}
