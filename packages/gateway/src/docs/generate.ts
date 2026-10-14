/**
 * Generates the API reference from the code: the data-plane spec from the shared Zod request
 * schema, the admin spec from the admin route table. `--check` fails if the committed files are
 * stale, which CI runs so a schema change cannot ship without regenerated docs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatCompletionRequestSchema } from '@gw/schema';
import { z } from 'zod';
import { adminOpenApi } from '../admin/openapi.js';
import { adminRoutes, type AdminDeps } from '../admin/routes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const outDir = path.join(root, 'docs/api');

const schema = (s: z.ZodType) => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(s, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return rest;
};

const errorResponse = {
  description: 'OpenAI-style error envelope',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [
                  'invalid_request',
                  'authentication',
                  'permission',
                  'not_found',
                  'rate_limited',
                  'budget_exceeded',
                  'provider_error',
                  'provider_timeout',
                  'no_eligible_model',
                  'internal',
                ],
              },
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

export function dataPlaneOpenApi(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'LLM gateway data-plane API',
      version: '0.1.0',
      description: 'OpenAI-compatible. Point an OpenAI SDK at <gateway>/v1 with a gateway API key.',
    },
    security: [{ bearer: [] }],
    paths: {
      '/v1/chat/completions': {
        post: {
          summary: 'Create a chat completion (streaming with stream: true)',
          parameters: [
            {
              name: 'x-gateway-timeout-ms',
              in: 'header',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 300000 },
              description: 'Request deadline (default 60000, capped at 300000)',
            },
            {
              name: 'traceparent',
              in: 'header',
              required: false,
              schema: { type: 'string' },
              description: 'W3C trace context to continue',
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schema(chatCompletionRequestSchema) } },
          },
          responses: {
            '200': {
              description:
                'chat.completion JSON, or text/event-stream of chat.completion.chunk events ending in [DONE]',
              headers: Object.fromEntries(
                [
                  'x-request-id',
                  'x-trace-id',
                  'x-gateway-provider',
                  'x-gateway-model',
                  'x-gateway-attempts',
                  'x-gateway-route-reason',
                  'x-gateway-deadline-ms',
                  'x-gateway-emulated',
                  'x-ratelimit-limit-requests',
                  'x-ratelimit-remaining-requests',
                  'x-ratelimit-limit-tokens',
                  'x-ratelimit-remaining-tokens',
                ].map((h) => [h, { schema: { type: 'string' } }]),
              ),
            },
            '400': errorResponse,
            '401': errorResponse,
            '402': errorResponse,
            '413': errorResponse,
            '429': errorResponse,
            '502': errorResponse,
            '503': errorResponse,
            '504': errorResponse,
          },
        },
      },
      '/v1/models': {
        get: {
          summary: 'Enabled models with capabilities and pricing under `gateway`',
          responses: { '200': { description: 'OpenAI list of models' }, '401': errorResponse },
        },
      },
    },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'Gateway API key gw_live_…' },
      },
    },
  };
}

export function generate(): Record<string, string> {
  // The admin route table needs dependencies only to run handlers; documenting it needs none.
  const routes = adminRoutes({} as AdminDeps);
  return {
    'data-plane.openapi.json': `${JSON.stringify(dataPlaneOpenApi(), null, 2)}\n`,
    'admin.openapi.json': `${JSON.stringify(adminOpenApi(routes, '0.1.0'), null, 2)}\n`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  for (const [file, content] of Object.entries(generate())) {
    const target = path.join(outDir, file);
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      // missing counts as stale
    }
    if (current === content) continue;
    if (check) stale.push(file);
    else writeFileSync(target, content);
  }
  if (stale.length) {
    console.error(`API docs are out of date: ${stale.join(', ')}. Run: pnpm docs:api`);
    process.exit(1);
  }
  console.log(
    check ? 'API docs are up to date' : `API docs written to ${path.relative(root, outDir)}`,
  );
}
