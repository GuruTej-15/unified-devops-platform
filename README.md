# Unified DevOps Platform

> A self-hosted DevOps control and collaboration platform designed to address DevOps toolchain fragmentation.

---

## The Core Thesis: "Overlay Architecture, Not Wholesale Replacement"

Modern engineering teams use specialized tools for version control, issue tracking, CI/CD, security scanning, governance, and deployment. The problem is not that these tools are individually inadequate — the problem is that **delivery state, workflow context, approvals, and governance are fragmented across them**.

The **Unified DevOps Platform** acts as a unified operational control layer ABOVE existing tools and unifies their delivery state.

```text
Requirement
   ↓
Issue (PAY-101)
   ↓
Branch (feature/PAY-101-validation)
   ↓
Commit ("PAY-101: Add payment validation")
   ↓
Pull Request (PR #42)
   ↓
CI Pipeline (GitHub Actions / BullMQ) ─── [Phase 2A/2B — IMPLEMENTED]
   ↓
Security Gate (PLANNED — Phase 3)
   ↓
Deployment    (PLANNED — Phase 4)
```

---

## Implementation Status by Phase

### [COMPLETE] Phase 1 Core Foundation
- **Authentication & RBAC**: JWT with `HttpOnly SameSite=Strict` cookies, password hashing with `bcryptjs` (12 rounds), project-scoped roles (`owner`, `admin`, `developer`, `viewer`).
- **Sequential Issue Tracking**: Atomically sequenced issue keys starting at 100 (`PAY-101`, `PAY-102`).
- **GitHub VCS Integration**: Repository connection with AES-256-GCM encrypted PAT at rest, GraphQL commit/PR synchronization.
- **Traceability Engine**: Multi-step issue key validation linking code changes and PRs to issues.
- **Unified Delivery State Tracker & Dashboard**: Visual stage progression and real-time project metrics.
- **Append-Only Audit Logging & Socket.io Gateway**: Real-time project room event broadcasting.

### [COMPLETE] Phase 2A — GitHub Actions CI Pipeline Visibility
- **HMAC-SHA256 Webhook Gateway**: Verifies `X-Hub-Signature-256` using constant-time comparison.
- **Idempotent CI Models**: `Pipeline` workflow definitions and `PipelineRun` executions with `{ repository: 1, externalRunId: 1 }` unique indexing.
- **Issue Traceability in CI**: Multi-step extraction linking workflow runs to issues (`PAY-101`).
- **Real-Time Delivery State**: Dynamic CI stage in `DeliveryStateTracker.jsx` and dashboard `PipelineSummary.jsx`.

### [IMPLEMENTED & TESTED] Phase 2B — Durable CI Event Infrastructure & Reconciliation
- **Redis + BullMQ Architecture**: Fast webhook intake (HTTP 202) enqueueing durable jobs to the `ci-events` BullMQ queue.
- **Atomic Delivery Idempotency**: `WebhookDelivery` model with unique `deliveryId` constraint (`X-GitHub-Delivery`) guaranteeing only one job is claimed/enqueued across concurrent delivery races.
- **Dedicated Worker Process**: Standalone executable `npm run worker:ci` consuming CI jobs with bounded exponential backoff (`CI_JOB_ATTEMPTS`, `CI_JOB_BACKOFF_MS`).
- **Terminal Status Protection**: Out-of-order `in_progress` or `queued` events cannot regress a terminal `completed` status or overwrite `conclusion`.
- **Scheduled & On-Demand Reconciliation**: BullMQ repeatable reconciliation scheduler and project-scoped `POST /api/v1/projects/:projectId/cicd/reconcile` endpoint to recover missed runs within a configurable lookback window without overloading GitHub rate limits.
- **Queue Health & Observability**: Project-scoped `GET /api/v1/projects/:projectId/cicd/queue-health` providing real-time backlog diagnostics (waiting, active, failed, delayed jobs).
- **Explicit Redis Failure Semantics**: Redis is strictly required in production; in non-Redis development environments, a non-durable fallback is clearly logged.

---

### [PLANNED] Future Roadmap
- **Phase 2C — Jenkins Integration**: CI provider abstraction for Jenkins build and test jobs.
- **Phase 3 — Governance & Security Gates**: Trivy & Snyk vulnerability scan gates, policy approval sign-offs, and cryptographic audit log hash chaining.
- **Phase 4 — Self-Hosted Deployment & Rollout**: Docker / Kubernetes release deployment tracking, production container packaging, and Cypress E2E automation.

---

## Monorepo Architecture

```text
unified-devops-platform/
├── package.json              # Workspace root scripts (dev, test, build, lint, format)
├── server/                   # Express 5 Modular Monolith API
│   ├── src/
│   │   ├── modules/
│   │   │   ├── auth/         # Authentication & JWT management
│   │   │   ├── users/        # User accounts & directory
│   │   │   ├── projects/     # Projects, membership RBAC, and counters
│   │   │   ├── issues/       # Issue tracking & discussion comments
│   │   │   ├── vcs/          # GitHub GraphQL client & sync engine
│   │   │   ├── cicd/         # CI/CD pipelines, webhook gateway, BullMQ queue, and worker
│   │   │   │   └── queue/    # ciQueue.js, ciWorker.js, reconciliation.service.js
│   │   │   ├── audit/        # Append-only audit logger
│   │   │   └── notifications/# In-process domain event bus
│   │   ├── middleware/       # Auth guard, project RBAC, Zod validation, rate limiter
│   │   ├── shared/           # Crypto (AES-256-GCM), errors, responses, parser
│   │   ├── socket/           # Socket.io gateway with project rooms
│   │   └── workers/          # Standalone worker processes (ci.worker.js)
│   └── tests/                # Automated Jest test suites (in-memory MongoDB)
│
└── client/                   # React 19 SPA (Vite + Tailwind CSS v4)
    └── src/
        ├── features/         # Domain slices, pages, and components
        ├── components/       # Shared UI, layout, and protected route guards
        ├── lib/              # Axios with credentials, Socket.io singleton
        └── routes/           # Declarative React Router mapping
```

---

## Getting Started

### Prerequisites

- **Node.js**: `>= 20.0.0` (Node 22 or 24 LTS recommended)
- **MongoDB**: Running instance on `mongodb://localhost:27017` (or MongoDB Atlas)
- **Redis**: Running instance on `redis://localhost:6379` (Required for Phase 2B BullMQ queue & worker)

### 1. Installation

```bash
git clone https://github.com/GuruTej-15/unified-devops-platform.git
cd unified-devops-platform
npm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Configure `.env`:

```env
NODE_ENV=development
PORT=5000
MONGODB_URI=mongodb://localhost:27017/unified-devops
JWT_SECRET=replace-with-a-strong-random-secret-min-32-chars
JWT_EXPIRES_IN=24h
ENCRYPTION_KEY=replace-with-a-64-char-hex-string-representing-32-bytes
CORS_ORIGIN=http://localhost:5173

# GitHub Webhook Secret
GITHUB_WEBHOOK_SECRET=your-github-webhook-secret-here

# Redis & BullMQ Queue Settings
REDIS_URL=redis://localhost:6379
CI_QUEUE_NAME=ci-events
CI_WORKER_CONCURRENCY=5
CI_JOB_ATTEMPTS=5
CI_JOB_BACKOFF_MS=2000
CI_RECONCILIATION_LOOKBACK_MINUTES=60
CI_RECONCILIATION_INTERVAL_MINUTES=15
```

### 3. Run Development Servers

In production and local environments, run the API server, CI background worker, and frontend SPA:

```bash
# Terminal 1: Backend API Server
npm run dev:server

# Terminal 2: CI Background Worker (BullMQ + Redis)
npm run worker:ci

# Terminal 3: Frontend Client SPA (Vite)
npm run dev:client
```

Open `http://localhost:5173` in your browser.

---

## Testing & Quality Assurance

```bash
# Run all automated backend test suites (37 tests across 5 suites)
npm test

# Run Vite frontend production bundle build
npm run build

# Run ESLint check
npm run lint

# Run Prettier code formatting check
npm run format:check
```
