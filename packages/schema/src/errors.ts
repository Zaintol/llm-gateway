import { z } from 'zod';

/**
 * OpenAI-compatible error envelope. Every non-2xx response from the gateway uses this shape
 * so that existing OpenAI SDKs surface gateway errors without custom handling.
 */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    type: z.string(),
    code: z.string(),
    message: z.string(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function errorEnvelope(type: string, code: string, message: string): ErrorEnvelope {
  return { error: { type, code, message } };
}
