# Requirements Document

## Introduction

StellarFlow's backend pipeline processes Stellar ledger emission events through a multi-hop
architecture: a TypeScript producer enqueues messages into Redis Streams and dispatches Celery
tasks, which are then consumed by Python workers before results become available via the REST
API. Today, the OpenTelemetry SDK is initialised and HTTP requests already carry W3C
`traceparent`/`tracestate` headers, but trace context is lost at the Redis Stream boundary and
the Celery task dispatch boundary. This feature bridges those two gaps so that a single trace
originating at a `LedgerEmission` event can be followed end-to-end in Jaeger, and so that the
end-to-end event latency is measured and recorded as a span attribute.

---

## Glossary

- **TraceProducer**: The TypeScript code responsible for injecting `traceparent` and
  `tracestate` W3C headers into Redis Stream entries (via `XADD` field metadata) and into
  Celery task headers before enqueue.
- **TraceConsumer**: The Python code responsible for extracting `traceparent` and `tracestate`
  from Redis Stream message fields or Celery task headers and creating a child span that
  continues the originating trace.
- **LedgerEmission**: A Stellar ledger event ingested by the pipeline; the point in time at
  which a trace originates and the `emission_timestamp` is recorded.
- **E2E_Latency**: The elapsed time, in milliseconds, from the `LedgerEmission` timestamp to
  the moment the processed result is accessible via the API, recorded as the span attribute
  `event.latency_ms`.
- **W3C_Headers**: The `traceparent` and `tracestate` header fields as defined by the W3C
  Trace Context specification, already used on the HTTP layer via
  `W3CTraceContextPropagator`.
- **StreamEntry**: A single Redis Stream record created with `XADD`; carries both business
  payload fields and the `traceparent`/`tracestate` metadata fields.
- **CeleryTask**: A task dispatched to Python Celery workers; carries both business arguments
  and W3C trace headers in `task.headers`.
- **OTelSDK_Python**: The Python OpenTelemetry SDK (`opentelemetry-sdk` +
  `opentelemetry-exporter-otlp-proto-http`) configured to export spans to the same Jaeger
  endpoint as the TypeScript SDK.
- **JaegerEndpoint**: The collector URL read from `TRACING_JAEGER_ENDPOINT` environment
  variable, shared by both the TypeScript and Python sides.

---

## Requirements

### Requirement 1: Redis Stream Trace Context Injection

**User Story:** As a platform engineer, I want the TypeScript producer to embed W3C trace
context into every Redis Stream entry, so that downstream consumers can reconstruct the
originating trace without losing span continuity.

#### Acceptance Criteria

1. WHEN the `TraceProducer` calls `XADD` on a Redis Stream, THE `TraceProducer` SHALL include
   a `traceparent` field and, when a non-empty trace state exists, a `tracestate` field in
   the same `StreamEntry`.
2. THE `TraceProducer` SHALL derive the `traceparent` value by calling
   `propagation.inject` with the `W3CTraceContextPropagator` against the currently active
   OpenTelemetry context, producing a well-formed W3C `traceparent` string.
3. IF no active OpenTelemetry span exists at injection time, THEN THE `TraceProducer` SHALL
   still call `XADD` and SHALL omit the `traceparent` and `tracestate` fields rather than
   blocking or throwing.
4. THE `TraceProducer` SHALL inject trace context as named string fields within the
   `StreamEntry` metadata and SHALL NOT modify or remove any pre-existing business payload
   fields in the same entry.
5. WHEN the Redis client is unavailable, THE `TraceProducer` SHALL propagate the Redis
   connection error to the caller and SHALL NOT silently swallow it.

---

### Requirement 2: Redis Stream Trace Context Extraction

**User Story:** As a platform engineer, I want the Python Redis Stream consumer to extract W3C
trace context from each `StreamEntry` and create a child span, so that processing work in the
consumer appears as a connected span in the same Jaeger trace.

#### Acceptance Criteria

1. WHEN a `TraceConsumer` reads a `StreamEntry` that contains a `traceparent` field, THE
   `TraceConsumer` SHALL extract the W3C context using the `OTelSDK_Python`
   `W3CTraceContextPropagator` and SHALL start a new child span whose parent is the extracted
   span context.
2. WHEN a `TraceConsumer` reads a `StreamEntry` that does not contain a `traceparent` field,
   THE `TraceConsumer` SHALL start a new root span and SHALL continue processing without
   error.
3. THE `TraceConsumer` SHALL set the child span's `span.kind` to `CONSUMER` for all spans
   created from `StreamEntry` extraction.
4. IF the `traceparent` field value in a `StreamEntry` is malformed and cannot be parsed by
   the `W3CTraceContextPropagator`, THEN THE `TraceConsumer` SHALL start a new root span,
   SHALL log a warning containing the invalid value, and SHALL continue processing the
   message.
5. THE `TraceConsumer` SHALL finish each extracted span, with status `OK` on success or
   `ERROR` on exception, before acknowledging the message to the Redis Stream consumer group.

---

### Requirement 3: Celery Task Trace Context Injection

**User Story:** As a platform engineer, I want the TypeScript producer to embed W3C trace
context into Celery task headers before dispatch, so that Celery workers can attach their
execution spans to the originating ledger trace.

#### Acceptance Criteria

1. WHEN the `TraceProducer` dispatches a `CeleryTask`, THE `TraceProducer` SHALL set
   `task.headers['traceparent']` to the W3C `traceparent` string derived from the currently
   active OpenTelemetry context.
2. WHERE a non-empty trace state exists, THE `TraceProducer` SHALL also set
   `task.headers['tracestate']` to the current trace state value.
3. IF no active OpenTelemetry span exists at task dispatch time, THEN THE `TraceProducer`
   SHALL dispatch the `CeleryTask` without `traceparent` or `tracestate` headers rather than
   blocking or throwing.
4. THE `TraceProducer` SHALL inject trace context exclusively into `task.headers` and SHALL
   NOT embed trace fields in the task `args` or `kwargs`.
5. THE `TraceProducer` SHALL use the same `W3CTraceContextPropagator` instance used by the
   HTTP layer; no custom serialisation format is permitted.

---

### Requirement 4: Celery Task Trace Context Extraction

**User Story:** As a platform engineer, I want Python Celery workers to extract W3C trace
context from task headers and create a child span, so that all Celery worker processing is
visible within the originating ledger trace in Jaeger.

#### Acceptance Criteria

1. WHEN a Celery worker receives a `CeleryTask` whose `task.headers` contains a
   `traceparent` field, THE `TraceConsumer` SHALL extract the W3C context using the
   `opentelemetry-instrumentation-celery` propagator and SHALL execute the task body within
   a child span whose parent is the extracted span context.
2. WHEN a Celery worker receives a `CeleryTask` whose `task.headers` does not contain a
   `traceparent` field, THE `TraceConsumer` SHALL execute the task body within a new root
   span and SHALL continue without error.
3. THE `TraceConsumer` SHALL set the child span's `span.kind` to `CONSUMER` for all
   `CeleryTask`-derived spans.
4. IF the `traceparent` value in `task.headers` is malformed, THEN THE `TraceConsumer`
   SHALL start a new root span, SHALL log a warning containing the malformed value, and
   SHALL not raise an exception to the Celery framework.
5. THE `TraceConsumer` SHALL finish each task span with status `OK` on task success or
   status `ERROR` including the exception detail on task failure.

---

### Requirement 5: Python OpenTelemetry SDK Initialisation

**User Story:** As a platform engineer, I want the Python worker processes to initialise the
OpenTelemetry SDK with an OTLP exporter pointed at the shared Jaeger endpoint, so that Python
spans appear alongside TypeScript spans in the same Jaeger service view.

#### Acceptance Criteria

1. THE `OTelSDK_Python` SHALL be initialised once per worker process before any span is
   created, using the `opentelemetry-sdk` and `opentelemetry-exporter-otlp-proto-http`
   packages.
2. THE `OTelSDK_Python` SHALL read the collector URL from the `TRACING_JAEGER_ENDPOINT`
   environment variable and SHALL export spans via OTLP/HTTP to that endpoint.
3. THE `OTelSDK_Python` SHALL configure the `W3CTraceContextPropagator` as the global
   propagator so that extracted contexts are interoperable with the TypeScript SDK.
4. THE `OTelSDK_Python` SHALL set the service name resource attribute to
   `stellarflow-worker` to distinguish Python worker spans from the TypeScript backend
   spans in Jaeger.
5. IF `TRACING_JAEGER_ENDPOINT` is not set or is empty, THEN THE `OTelSDK_Python`
   SHALL fall back to the `ConsoleSpanExporter` and SHALL log a warning indicating that the
   Jaeger endpoint is not configured.
6. THE `OTelSDK_Python` initialisation SHALL NOT raise an unhandled exception that
   terminates the worker process when the Jaeger endpoint is unreachable at startup.

---

### Requirement 6: End-to-End Latency Measurement

**User Story:** As a platform engineer, I want the end-to-end latency from `LedgerEmission`
to API availability to be recorded as a span attribute, so that I can identify processing
bottlenecks using Jaeger's attribute search.

#### Acceptance Criteria

1. WHEN a `LedgerEmission` event is ingested, THE `TraceProducer` SHALL record the current
   Unix timestamp in milliseconds as the `emission_timestamp` field in the `StreamEntry` or
   `CeleryTask` metadata alongside the W3C trace context fields.
2. WHEN the `TraceConsumer` creates the child span for a `LedgerEmission`-originated
   message, THE `TraceConsumer` SHALL compute `E2E_Latency` as
   `current_time_ms − emission_timestamp` and SHALL set the span attribute `event.latency_ms`
   to this integer value.
3. IF the `emission_timestamp` field is absent or cannot be parsed as an integer, THEN THE
   `TraceConsumer` SHALL omit the `event.latency_ms` attribute and SHALL log a warning;
   THE `TraceConsumer` SHALL NOT abort span creation or message processing.
4. THE `TraceConsumer` SHALL set the `event.latency_ms` attribute before ending the span
   so that the value is exported with the span to Jaeger.
5. THE `TraceProducer` SHALL use `Date.now()` (milliseconds since Unix epoch) as the
   `emission_timestamp` value to ensure consistent units across TypeScript and Python.

---

### Requirement 7: Isolation from Existing Redis Caching and HTTP Tracing

**User Story:** As a platform engineer, I want the distributed trace propagation feature to
be additive only, so that existing Redis caching behaviour and HTTP tracing flows continue to
work without modification.

#### Acceptance Criteria

1. THE `TraceProducer` SHALL inject trace context only into Redis Stream `XADD` calls used
   for the ledger pipeline; THE `TraceProducer` SHALL NOT modify Redis `GET`, `SET`,
   `DEL`, or other caching commands issued by `src/lib/redis.ts`.
2. THE `TraceProducer` SHALL NOT alter the existing `tracingMiddleware` logic in
   `src/middleware/tracingMiddleware.ts` or add new middleware to the Express request
   pipeline.
3. THE `OTelSDK_Python` initialisation SHALL NOT change the TypeScript
   `initializeOpenTelemetry` configuration or any values read from `tracingConfig.ts`.
4. WHILE existing Redis cache entries are present, THE `TraceProducer` SHALL leave those
   entries unchanged when adding trace context fields to new `StreamEntry` records.
5. THE `TraceConsumer` SHALL NOT write back to the Redis caching key namespace; THE
   `TraceConsumer` MAY acknowledge messages to the Redis Stream consumer group using
   `XACK`.

---

### Requirement 8: Observability and Error Transparency

**User Story:** As a platform engineer, I want injection and extraction failures to be
surfaced as span events and log warnings rather than silently dropped, so that I can diagnose
propagation issues in production without needing to redeploy.

#### Acceptance Criteria

1. WHEN the `TraceProducer` successfully injects a `traceparent` into a `StreamEntry` or
   `CeleryTask`, THE `TraceProducer` SHALL record a span event named
   `trace.context.injected` on the active span.
2. WHEN the `TraceConsumer` successfully extracts a `traceparent` and creates a child span,
   THE `TraceConsumer` SHALL record a span event named `trace.context.extracted` on the
   new child span.
3. WHEN the `TraceConsumer` encounters a missing or malformed `traceparent` and falls back to
   a root span, THE `TraceConsumer` SHALL record a span event named
   `trace.context.missing` containing the message ID and the reason for fallback.
4. THE `TraceProducer` SHALL NOT swallow Redis `XADD` errors; IF `XADD` fails, THEN THE
   `TraceProducer` SHALL record the exception on the active span and re-throw it to the
   caller.
5. THE `TraceConsumer` SHALL set the span status to `ERROR` and record the exception detail
   on the active span before re-raising any unhandled exception from message processing.
