# StellarFlow Backend — Product Roadmap

This document defines the public milestone structure for the StellarFlow backend.
It gives contributors and stakeholders a clear view of what is planned, in progress, and blocked.

---

## Milestones

### v0.1 — Testnet MVP
**Target date:** Q2 2026
**Goal:** A fully functional oracle backend running on Stellar testnet, capable of fetching, reviewing, and submitting African market rates on-chain.

**Success criteria:**
- Price fetchers operational for NGN, KES, and GHS
- Prisma/PostgreSQL persistence for price history and on-chain confirmations
- Multi-signature approval workflow functional end-to-end
- Redis multi-level caching live (L1 + L2)
- Swagger API docs published at `/api/v1/docs`
- CI pipeline green on all PRs
- Basic rate limiting and auth in place

---

### v0.2 — Security Hardening
**Target date:** Q3 2026
**Goal:** Harden the backend against common attack vectors and establish operational best practices.

**Success criteria:**
- Brute-force protection on all auth endpoints (per-IP and per-wallet tracking)
- Consistent naming conventions enforced via ESLint (`@typescript-eslint/naming-convention`)
- Payload sanitization and input validation on all routes
- Gas balance monitoring and alerting
- Secrets rotation service operational
- Audit log coverage for all sensitive operations
- Load and soak tests passing under expected traffic

---

### v1.0 — Mainnet Launch
**Target date:** Q4 2026
**Goal:** Production-ready oracle network live on Stellar mainnet, with issuer onboarding and full observability.

**Success criteria:**
- Issuer onboarding workflow live (self-service application → admin approval → contract allowlist)
- OpenTelemetry tracing and Prometheus metrics in production
- Multi-region Redis failover tested
- Soroban event listener stable under mainnet load
- SLA: 99.9% uptime, <200 ms p95 API latency
- Security audit completed with no critical findings
- Public documentation and contributor guide up to date

---

## Issue Triage

All open issues should be assigned to one of the milestones above.
Issues that do not fit any milestone are placed in the **Backlog** and reviewed at the start of each sprint.

| Label | Meaning |
|---|---|
| `v0.1` | Required for testnet MVP |
| `v0.2` | Security hardening scope |
| `v1.0` | Mainnet launch scope |
| `backlog` | Triaged but not yet scheduled |
| `blocked` | Waiting on external dependency |

---

## Contributing

See [README.md](./README.md) for setup instructions.
Open issues are the best place to start — look for the `good first issue` label.
