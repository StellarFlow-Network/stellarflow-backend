# Implementation Plan: Distributed Trace Propagation

## Overview

Add W3C trace context propagation across Redis Stream and Celery worker pipelines. The TypeScript producer injects `traceparent`/`tracestate` and `emission_timestamp` into stream entries and task headers. Python consumers extract that context, create CONSUMER-kind child spans, and record `event.latency_ms`. All changes are additive — no existing files are modified.

## Tasks

- [ ] 1. Add Python dependencies
  - Append to `requirements.txt`:
    ```
    opentelemetry-sdk>=1.20.0
    opentelemetry-exporter-otlp-proto-http>=1.20.0
    opentelemetry-instrumentation-celery>=0.41b0
    celery>=5.3.0
    hypothesis>=6.100.0
    pytest>=8.0.0
    ```
  - _Requirements: 5.1, 5.2_

- [ ] 2. Implement `src/tracing/trace_consumer.py`
  - Create new file with four public symbols:
    - `init_otel(service_name: str = "stellarflow-worker") -> None` — initialises OTel SDK once per process (module-level `_initialized` bool guard); reads `TRACING_JAEGER_ENDPOINT`; uses `OTLPSpanExporter` when set, falls back to `ConsoleSpanExporter` + `WARNING` log when absent or invalid; sets `W3CTraceContextPropagator` as global propagator; sets resource attribute `service.name = service_name`; never raises on network failure
    - `extract_trace_context(fields: dict[str, str]) -> Context` — calls `W3CTraceContextPropagator().extract(fields)`; returns new root context when `traceparent` is absent or malformed; logs `WARNING` with the invalid value and reason on fallback
    - `start_consumer_span(name: str, ctx: Context, emission_timestamp: str | None) -> Span` — starts a `SpanKind.CONSUMER` span parented to `ctx`; sets `event.latency_ms = int(time.time()*1000) - int(emission_timestamp)` when parseable and non-negative; logs `WARNING` and omits the attribute otherwise
    - `consumer_span(name: str, fields: dict[str, str])` context manager — composes the above three; records `trace.context.extracted` on successful extraction or `trace.context.missing` with `message.id` and `fallback.reason` on fallback; ends the span with `OK` on clean exit or `ERROR` + `record_exception` on unhandled exception
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.2, 6.3, 6.4, 8.2, 8.3, 8.5_

- [ ] 3. Implement `src/tracing/streamTraceProducer.ts`
  - Create new file, importing only `@opentelemetry/api` (already a project dep):
    - `injectTraceContext(fields: Record<string, string>): Record<string, string>` — calls `propagation.inject(context.active(), carrier, setter)`; returns input unchanged when no active span; never throws
    - `buildStreamEntry(payload: Record<string, string>): Record<string, string>` — calls `injectTraceContext`, adds `emission_timestamp: Date.now().toString()`, merges with payload; does not overwrite pre-existing payload keys
    - `xaddWithTrace(client: RedisClientType, stream: string, fields: Record<string, string>): Promise<string>` — calls `buildStreamEntry`, calls `client.xAdd(stream, '*', entry)`, records `trace.context.injected` span event on success; on Redis error records exception on active span and re-throws
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 6.1, 6.5, 7.1, 8.1, 8.4_

- [ ] 4. Implement `src/tracing/celeryTraceProducer.ts`
  - Create new file:
    - `buildCeleryHeaders(): Record<string, string>` — same `propagation.inject` pattern as `injectTraceContext`; returns empty object when no active span
    - `dispatchWithTrace(taskName: string, args: unknown[], kwargs: Record<string, unknown>): Promise<void>` — serialises a Celery JSON envelope with `headers` containing W3C fields; pushes to Redis via `LPUSH` on `process.env.CELERY_QUEUE ?? "celery"`; records `trace.context.injected` span event; does not embed trace fields in `args`/`kwargs`
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 8.1_

- [ ] 5. Implement `src/workers/celery_app.py`
  - Create new file:
    - Define Celery `app` reading broker URL from `REDIS_URL` env var
    - Connect `worker_init` signal to call `init_otel()`
    - Call `CeleryInstrumentor().instrument()` at module level — handles automatic `traceparent`/`tracestate` extraction from `task.headers` and creates CONSUMER spans
    - Define a sample `process_ledger` task that uses `consumer_span` for any sub-operations
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1_

- [ ]* 6. Write TypeScript property tests (`src/tracing/__tests__/streamTraceProducer.property.test.ts`)
  - Use `fast-check` (already a dev dependency); min 100 iterations per property
  - **Property 1** — injection round-trip: for any active mock span, `injectTraceContext({})["traceparent"]` matches W3C regex and encodes matching traceId/spanId — _Validates: Requirements 1.1, 1.2_
  - **Property 2** — no-span isolation: with `ROOT_CONTEXT`, `buildStreamEntry` result has no `traceparent` key — _Validates: Requirements 1.3, 3.3_
  - **Property 3** — payload preservation: all original fields survive `buildStreamEntry` unchanged — _Validates: Requirements 1.4, 3.4_
  - **Property 4** — `emission_timestamp` always a parseable positive integer string — _Validates: Requirements 6.1, 6.5_
  - **Property 8** — `trace.context.injected` event recorded exactly once per successful `xaddWithTrace` when an active span exists — _Validates: Requirement 8.1_
  - **Property 11** — `xaddWithTrace` issues only `xAdd` on the Redis client mock; no `GET`, `SET`, `DEL` calls — _Validates: Requirements 7.1, 7.4_
  - Add comment `// Feature: distributed-trace-propagation, Property {N}: {text}` on each test
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.3, 3.4, 6.1, 6.5, 7.1, 7.4, 8.1_

- [ ]* 7. Write TypeScript example tests (`src/tracing/__tests__/streamTraceProducer.test.ts`)
  - Redis error propagation: mock `xAdd` to reject; assert error re-thrown and recorded on span
  - No active span: assert `buildStreamEntry({})` contains `emission_timestamp` but no `traceparent`
  - Celery headers: `buildCeleryHeaders()` with active span returns object with W3C-format `traceparent`
  - `dispatchWithTrace` serialises `traceparent` only in `headers`, not in body
  - _Requirements: 1.3, 1.5, 3.4, 8.4_

- [ ]* 8. Write Python property tests (`src/tracing/tests/test_trace_consumer_properties.py`)
  - Use `hypothesis`; min 100 examples (default Hypothesis max_examples)
  - **Property 5** — extraction round-trip: `@given(st.from_regex(W3C_REGEX))` — `extract_trace_context({"traceparent": v})` yields matching `trace_id`/`span_id` — _Validates: Requirements 2.1, 4.1_
  - **Property 6** — latency non-negative: `@given(st.integers(max_value=int(time.time()*1000)))` — `event.latency_ms >= 0` — _Validates: Requirement 6.2_
  - **Property 9** — consumer span kind is always `CONSUMER`: `@given(st.dictionaries(...))` with/without `traceparent` — _Validates: Requirements 2.3, 4.3_
  - **Property 10** — `init_otel` is idempotent: `@given(st.integers(min_value=1, max_value=20))` — N calls register exactly one TracerProvider — _Validates: Requirement 5.1_
  - Add comment `# Feature: distributed-trace-propagation, Property {N}: {text}` on each test
  - _Requirements: 2.1, 2.3, 4.1, 4.3, 5.1, 6.2_

- [ ]* 9. Write Python example tests (`src/tracing/tests/test_trace_consumer_examples.py`)
  - Missing `traceparent` → root span + `trace.context.missing` event with `fallback.reason = "absent"`
  - Malformed `traceparent` → root span + WARNING log + `trace.context.missing` event with `fallback.reason = "malformed"`
  - Missing `emission_timestamp` → span created without `event.latency_ms` + WARNING log
  - Unhandled exception inside `consumer_span` → span ends with `ERROR` status + exception recorded
  - `TRACING_JAEGER_ENDPOINT` unset → `ConsoleSpanExporter` used + WARNING logged
  - `init_otel` called twice → no duplicate exporter registered
  - _Requirements: 2.2, 2.4, 2.5, 4.2, 4.4, 5.5, 5.6, 6.3, 8.2, 8.3, 8.5_

- [ ] 10. Checkpoint — Ensure all tests pass
  - Run TypeScript tests: `jest src/tracing/__tests__/`
  - Run Python tests: `pytest src/tracing/tests/`
  - Verify no existing test regressions: `jest` and `pytest tests/`

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Tasks 2–5 are the core implementation; Tasks 6–9 are test coverage
- NO existing files are modified by any task
- The `consumer_span` context manager in `trace_consumer.py` is designed as a drop-in for the `_run` callback inside `queue/pipeline.py` — no changes to `pipeline.py` itself are needed
- Property tests use exact comment format: `// Feature: distributed-trace-propagation, Property N: <text>` (TS) and `# Feature: distributed-trace-propagation, Property N: <text>` (Python)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2", "3", "4"] },
    { "id": 2, "tasks": ["5"] },
    { "id": 3, "tasks": ["6", "7", "8", "9"] },
    { "id": 4, "tasks": ["10"] }
  ]
}
```
