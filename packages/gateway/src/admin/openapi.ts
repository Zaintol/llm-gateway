import { z } from 'zod';
import type { AdminRoute } from './routes.js';

/** OpenAPI 3.1 document generated from the same route table that registers the routes. */
export function adminOpenApi(routes: AdminRoute[], version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const path = `/admin/v1${route.url.replace(/:([a-z_]+)/g, '{$1}')}`;
    const parameters = [
      ...(route.params
        ? Object.keys(route.params.shape).map((name) => ({
            name,
            in: 'path',
            required: true,
            schema: { type: 'string' },
          }))
        : []),
      ...(route.query ? queryParameters(route.query) : []),
    ];
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = {
      summary: route.summary,
      description: `Roles: ${route.roles.join(', ')}`,
      ...(parameters.length ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: jsonSchema(route.body) } },
            },
          }
        : {}),
      responses: {
        [String(route.status ?? 200)]: {
          description: 'Success',
          content: {
            'application/json': {
              schema: route.response ? jsonSchema(route.response) : { type: 'object' },
            },
          },
        },
        '400': { $ref: '#/components/responses/Error' },
        '401': { $ref: '#/components/responses/Error' },
        '403': { $ref: '#/components/responses/Error' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'LLM gateway admin API', version },
    servers: [{ url: '/' }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'Admin JWT (15 min) or service token gw_admin_…',
        },
      },
      responses: {
        Error: {
          description: 'Error envelope',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: {
                  error: {
                    type: 'object',
                    required: ['type', 'code', 'message'],
                    properties: {
                      type: { type: 'string' },
                      code: { type: 'string' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return rest;
}

function queryParameters(schema: z.ZodType): Array<Record<string, unknown>> {
  const json = jsonSchema(schema) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, prop]) => ({
    name,
    in: 'query',
    required: json.required?.includes(name) ?? false,
    schema: prop,
  }));
}
