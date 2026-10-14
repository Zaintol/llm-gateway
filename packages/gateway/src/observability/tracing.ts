import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * Tracing for the request lifecycle. Spans carry identifiers, counts, timings and outcomes only:
 * never prompt or completion content. Without initTracing() every call here is a cheap no-op.
 */
export const tracer = () => trace.getTracer('llm-gateway');

export function initTracing(options: {
  serviceName: string;
  /** OTLP/HTTP endpoint base, e.g. http://otel-collector:4318. */
  endpoint?: string;
  /** Head sampling ratio for new root traces; keep 1 when the collector tail-samples. */
  sampleRatio: number;
  /** Extra processors (tests use an in-memory exporter). */
  processors?: SpanProcessor[];
}): NodeTracerProvider {
  const processors = [...(options.processors ?? [])];
  if (options.endpoint) {
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${options.endpoint.replace(/\/+$/, '')}/v1/traces` }),
      ),
    );
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(options.sampleRatio) }),
    spanProcessors: processors,
  });
  provider.register({ propagator: new W3CTraceContextPropagator() });
  return provider;
}

/** Runs `fn` in a child span of the active context, recording failures on the span. */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      markError(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Synchronous variant of inSpan for CPU-only stages such as validation. */
export function inSpanSync<T>(name: string, attributes: Attributes, fn: (span: Span) => T): T {
  return tracer().startActiveSpan(name, { attributes }, (span) => {
    try {
      return fn(span);
    } catch (err) {
      markError(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

export function markError(span: Span, err: unknown): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err instanceof Error ? err.message : String(err),
  });
  if (err instanceof Error) span.setAttribute('error.type', err.name);
}

/** Root server span for an incoming request, continuing any W3C traceparent the client sent. */
export function startRequestSpan(
  name: string,
  headers: Record<string, string | string[] | undefined>,
  attributes: Attributes,
): { span: Span; ctx: Context } {
  const parent = propagation.extract(context.active(), headers);
  const span = tracer().startSpan(name, { kind: SpanKind.SERVER, attributes }, parent);
  return { span, ctx: trace.setSpan(parent, span) };
}

/** trace_id and span_id of the active span, for log correlation. */
export function activeTraceIds(): { trace_id?: string; span_id?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !trace.isSpanContextValid(spanContext)) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

export { SpanStatusCode, context, trace };
export type { Span };
