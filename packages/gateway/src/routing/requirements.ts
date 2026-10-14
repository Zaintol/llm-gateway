import type { ChatCompletionRequest } from '@gw/schema';
import type { CatalogModel } from '../catalog/catalog.js';
import { estimateTokens } from '../providers/openai-compatible.js';

/** What a request needs from a model. Richer inference (GW-6.2) builds on this. */
export type Requirements = {
  tools: boolean;
  vision: boolean;
  jsonMode: boolean;
  streaming: boolean;
  /** Estimated prompt tokens plus requested output tokens. */
  minContextTokens: number;
};

export function requirementsOf(request: ChatCompletionRequest): Requirements {
  return {
    tools: (request.tools?.length ?? 0) > 0,
    vision: request.messages.some(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'image_url'),
    ),
    jsonMode:
      request.response_format?.type === 'json_object' ||
      request.response_format?.type === 'json_schema',
    streaming: request.stream === true,
    minContextTokens: estimateTokens(JSON.stringify(request.messages)) + (request.max_tokens ?? 0),
  };
}

/** Human-readable list of requirements the model does not meet; empty when it qualifies. */
export function unmetRequirements(model: CatalogModel, req: Requirements): string[] {
  const unmet: string[] = [];
  if (req.tools && !model.capabilities.tools) unmet.push('tools');
  if (req.vision && !model.capabilities.vision) unmet.push('vision');
  if (req.jsonMode && !model.capabilities.jsonMode) unmet.push('json_mode');
  if (req.streaming && !model.capabilities.streaming) unmet.push('streaming');
  if (req.minContextTokens > model.contextWindow) {
    unmet.push(`context_window >= ${req.minContextTokens} (has ${model.contextWindow})`);
  }
  return unmet;
}
