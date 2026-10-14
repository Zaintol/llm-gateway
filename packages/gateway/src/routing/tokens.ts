import type { ChatCompletionRequest, ChatMessage } from '@gw/schema';
import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';

/**
 * Pre-request token estimates, used for admission (TPM limits, budget reservations) before the
 * provider reports real usage. OpenAI models use their actual tokenizer; other providers do not
 * publish one, so a calibrated characters-per-token ratio is used and corrected after the call.
 */
const CHARS_PER_TOKEN: Record<string, number> = { anthropic: 3.5, default: 4 };
/** Role markers and separators the chat format adds per message. */
const PER_MESSAGE_OVERHEAD = 4;
/** Images are billed separately by providers; this is a deliberately pessimistic placeholder. */
const IMAGE_TOKENS = 1000;

let encoder: Tiktoken | undefined;
const openAiTokens = (text: string) => (encoder ??= new Tiktoken(o200k)).encode(text).length;

function textOf(message: ChatMessage): { text: string; images: number } {
  const content = 'content' in message ? message.content : null;
  if (typeof content === 'string') return { text: content, images: 0 };
  let text = '';
  let images = 0;
  for (const part of content ?? []) {
    if (part.type === 'text') text += part.text;
    else images++;
  }
  if (message.role === 'assistant' && message.tool_calls)
    text += JSON.stringify(message.tool_calls);
  return { text, images };
}

export function estimatePromptTokens(request: ChatCompletionRequest, provider: string): number {
  let text = request.tools ? JSON.stringify(request.tools) : '';
  let images = 0;
  for (const message of request.messages) {
    const part = textOf(message);
    text += part.text;
    images += part.images;
  }
  const textTokens =
    provider === 'openai'
      ? openAiTokens(text)
      : Math.ceil(text.length / (CHARS_PER_TOKEN[provider] ?? CHARS_PER_TOKEN.default!));
  return textTokens + images * IMAGE_TOKENS + request.messages.length * PER_MESSAGE_OVERHEAD;
}
