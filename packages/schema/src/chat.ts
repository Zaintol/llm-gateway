import { z } from 'zod';

/**
 * Canonical chat completion request: the OpenAI wire format the gateway accepts from clients.
 * Objects are non-strict, so unknown fields are stripped (never forwarded to a provider).
 */

const textPart = z.object({ type: z.literal('text'), text: z.string() });
const imagePart = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().min(1),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});
export const contentPartSchema = z.discriminatedUnion('type', [textPart, imagePart]);

export const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const textContent = z.union([z.string(), z.array(textPart)]);

export const chatMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: textContent, name: z.string().optional() }),
  z.object({ role: z.literal('developer'), content: textContent, name: z.string().optional() }),
  z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(contentPartSchema)]),
    name: z.string().optional(),
  }),
  z.object({
    role: z.literal('assistant'),
    content: textContent.nullable().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
    name: z.string().optional(),
  }),
  z.object({ role: z.literal('tool'), content: textContent, tool_call_id: z.string() }),
]);

export const toolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

/** Gateway-specific routing hints, ignored by providers. */
export const gatewayOptionsSchema = z.object({
  min_quality_tier: z.number().int().min(1).max(3).optional(),
  latency_tier: z.enum(['fast', 'standard', 'slow']).optional(),
  max_cost_usd: z.number().positive().optional(),
  /** For a concrete model: append the tenant's default fallback chain after it. */
  fallback: z.boolean().optional(),
});

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  tools: z.array(toolSchema).optional(),
  tool_choice: z
    .union([
      z.enum(['none', 'auto', 'required']),
      z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
    ])
    .optional(),
  response_format: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('text') }),
      z.object({ type: z.literal('json_object') }),
      z.object({
        type: z.literal('json_schema'),
        json_schema: z.object({
          name: z.string(),
          description: z.string().optional(),
          schema: z.record(z.string(), z.unknown()).optional(),
          strict: z.boolean().optional(),
        }),
      }),
    ])
    .optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  user: z.string().optional(),
  gateway: gatewayOptionsSchema.optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatTool = z.infer<typeof toolSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

/** Top-level request fields the gateway understands; anything else is dropped. */
export const knownRequestFields = new Set(Object.keys(chatCompletionRequestSchema.shape));

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export type ChatCompletionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type ChatCompletionResponse = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
    finish_reason: FinishReason | null;
    logprobs: null;
  }>;
  usage: ChatCompletionUsage;
};
