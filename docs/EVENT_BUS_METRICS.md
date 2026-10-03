# Event Bus Metrics & Queue Backpressure Alert Bot

**Issue #1055** — Monitor message-queue backpressure across the internal Redis
pub/sub channels and the Celery task queues, alert when a backlog exceeds
1,000 unhandled messages, and scale worker containers to match queue depth.

## What runs where

| File | Responsibility |
| --- | --- |
| `src/services/eventBus/config.ts` | Environment parsing and the default queue catalogue |
| `src/services/eventBus/queueDepthCollector.ts` | Probes every watched queue and produces a depth sample |
| `src/services/eventBus/readers.ts` | Real Redis / AMQP probe implementations |
| `src/services/eventBus/eventBusMetrics.ts` | Prometheus `event_bus_*` series |
| `src/services/eventBus/queueBackpressureBot.ts` | Threshold, hysteresis, cooldown, escalation |
| `src/services/eventBus/alertDispatcher.ts` | Slack + PagerDuty delivery |
| `src/services/eventBus/workerAutoscaler.ts` | Queue depth → worker replica count |
| `src/services/eventBus/scaleProviders.ts` | Docker / Kubernetes / webhook scale backends |
| `src/services/eventBus/eventBusService.ts` | Polling loop that ties the above together |

The loop starts from `src/index.ts` after the ingestion path is warm, and stops
during graceful shutdown before Redis and the broker are torn down.

## Deliverable 1 — track pending queue lengths across all worker pools

One collection cycle reads, per queue:

* `pending` — messages waiting for a worker
* `unacked` — delivered-but-unacknowledged (Celery queues, when the RabbitMQ
  management API is reachable)
* `consumers` — live workers attached to the queue
* `oldestPendingAgeSeconds` — head-of-line age, derived from the enqueue
  timestamp stored in the payload

Supported transports:

| Transport | Source | Notes |
| --- | --- | --- |
| `amqp` | passive `queue.declare` on the Celery broker | Also reports consumer count |
| `redis-list` | `LLEN` | Used for the DLQ (`app/queue/dlq.py`) |
| `redis-stream` | `XLEN` | Redis Streams worker pools |
| `redis-set` | `SCARD` | Deduplication / retry sets |
| `redis-pubsub` | `PUBSUB NUMSUB` | Pub/sub drops messages, so `pending` is the local ingestion buffer and `consumers` is the subscriber count — a channel with 0 subscribers is reported as not accepting messages |

Queues are grouped into **worker pools** (`QueueDescriptor.pool`), which is the
unit the autoscaler scales. By default all Celery queues declared in
`app/celery_app.py` (`celery`, `webhook.retry`, `webhook.dead`,
`index-shielded-notes`) share the `celery-webhook` pool, and the Redis DLQ forms
the `ingestion-dlq` pool.

A probe that cannot reach its backend never fails the cycle: the sample is
returned with `pending = -1` and an `error` string, which is visible as
`event_bus_queue_probe_failures_total` and in the probe-error list attached to
alerts.

### Exported metrics

| Series | Type | Labels |
| --- | --- | --- |
| `event_bus_queue_pending_messages` | gauge | `queue`, `pool`, `transport` |
| `event_bus_queue_unacked_messages` | gauge | `queue`, `pool`, `transport` |
| `event_bus_queue_consumers` | gauge | `queue`, `pool`, `transport` |
| `event_bus_queue_backlog_ratio` | gauge | `queue`, `pool`, `transport` |
| `event_bus_queue_oldest_message_age_seconds` | gauge | `queue`, `pool`, `transport` |
| `event_bus_queue_total_pending_messages` | gauge | `environment` |
| `event_bus_queue_probes_total` | counter | `transport`, `outcome` |
| `event_bus_queue_probe_failures_total` | counter | `queue`, `transport` |
| `event_bus_backpressure_alerts_total` | counter | `kind`, `level` |
| `event_bus_backpressure_severity` | gauge | `scope` (0 ok / 1 warning / 2 critical) |
| `event_bus_autoscaler_actions_total` | counter | `action` |
| `event_bus_autoscaler_replicas` | gauge | `pool`, `role` (`current` / `target`) |
| `event_bus_autoscaler_desired_replicas` | gauge | `pool` |

Example alert rules:

```promql
# A single queue is over the backpressure threshold
event_bus_queue_backlog_ratio > 1

# Nobody is consuming a pub/sub channel — messages are being dropped
(event_bus_queue_consumers{transport="redis-pubsub"} == 0)

# The whole bus is backing up
event_bus_queue_total_pending_messages > 1000
```

## Deliverable 2 — Slack / PagerDuty alert above 1,000 unhandled messages

A scope is a queue name, or the synthetic `event-bus-total` scope covering the
summed backlog of every watched queue.

| Backlog | Level | Delivery |
| --- | --- | --- |
| `>= threshold` (1,000) | `warning` | Slack |
| `>= criticalThreshold` (5,000) | `critical` | Slack **and** a PagerDuty `trigger` |
| `< threshold * recoveryRatio` | resolved | PagerDuty `resolve` + Slack note |

Guard rails that keep the pager usable:

* **Hysteresis** — an open incident only closes once the backlog drops below
  `threshold * recoveryRatio` (default 50%), so a queue oscillating around the
  threshold cannot flap.
* **Cooldown** — repeat notifications for an already-alerting scope are
  suppressed for `EVENT_BUS_ALERT_COOLDOWN_MS` and then re-sent as a `reminder`.
* **Escalation** — crossing the critical threshold promotes an open warning
  immediately instead of waiting for the cooldown.
* **Dedup** — PagerDuty uses a deterministic `dedup_key` per scope
  (`stellarflow-queue-backpressure-<scope>`), so a trigger and its resolve always
  match and repeated triggers collapse into a single incident.

Every notification carries the per-queue breakdown (worst first), the aggregate
backlog, the desired replica count and any probe errors, so the responder does
not have to open a dashboard to know which queue is responsible.

## Deliverable 3 — auto-scale worker containers from queue depth

```
desired = ceil(pool backlog / EVENT_BUS_AUTOSCALE_TARGET_MSGS_PER_REPLICA)
desired = clamp(desired, minReplicas, maxReplicas)
```

Guard rails applied in order:

1. `maxScaleStep` caps the change per cycle.
2. `cooldownMs` enforces a minimum gap between two actions on the same pool.
3. `scaleDownStabilizationMs` requires the pool to stay under
   `scaleDownThreshold` before replicas are released, so a draining backlog does
   not cause flapping.
4. `enabled=false` keeps the autoscaler purely advisory — it still reports the
   desired replica count but never calls the provider. This is the default.

Pick a provider with `EVENT_BUS_AUTOSCALE_PROVIDER`:

* `docker` — talks to the Docker Engine API over `EVENT_BUS_DOCKER_SOCKET`; the
  pool is mapped to a container image via `EVENT_BUS_DOCKER_POOL_IMAGES`, and
  scale-in stops the most recently started containers first.
* `kubernetes` — PATCHes the `scale` subresource of the pool's Deployment.
* `webhook` — `GET`/`POST {EVENT_BUS_AUTOSCALE_WEBHOOK_URL}` with
  `{ pool, replicas }`, for ECS/Docker Swarm/anything with an adapter.
* `noop` — logs the intended action.

A cluster autoscaler reading `event_bus_queue_total_pending_messages` is a
valid alternative: leave the built-in autoscaler off and let the platform scale.

## Admin endpoints

All require the admin middleware and the `read:audit` role matrix entry.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/admin/event-bus/queues` | Per-queue depth, consumers, thresholds |
| `GET` | `/api/v1/admin/event-bus/history?limit=60` | Recent backlog trend |
| `GET` | `/api/v1/admin/event-bus/alerts` | Incident levels, peaks, delivery config |
| `GET` | `/api/v1/admin/event-bus/autoscaler` | Replica decisions and guard rails |
| `POST` | `/api/v1/admin/event-bus/collect` | Force a cycle (ADMIN only) |

Read handlers project the last polling cycle rather than probing the broker, so
refreshing a dashboard during an incident cannot add load to a struggling
broker.

## Tests

```bash
npm run test:jest -- test/eventBusQueueDepthCollector.jest.test.ts \
                    test/queueBackpressureBot.jest.test.ts \
                    test/workerAutoscaler.jest.test.ts
```

The suites use fake Redis/AMQP readers, a recording dispatcher and an injected
clock, so no broker, Slack or PagerDuty credentials are needed.
