import { describe, expect, it } from 'vitest';
import { errorEnvelope, errorEnvelopeSchema } from '../src/index.js';

describe('errorEnvelope', () => {
  it('builds an OpenAI-shaped error body', () => {
    const body = errorEnvelope('invalid_request_error', 'not_found', 'Route GET /nope not found');
    expect(errorEnvelopeSchema.parse(body)).toEqual({
      error: {
        type: 'invalid_request_error',
        code: 'not_found',
        message: 'Route GET /nope not found',
      },
    });
  });
});
