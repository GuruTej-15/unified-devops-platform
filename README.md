# Unified DevOps Platform

> A self-hosted DevOps control, governance, and collaboration platform designed to unify fragmented engineering toolchains into a single operational lifecycle.

---

## The Core Thesis: "Overlay Architecture, Not Wholesale Replacement"

Modern engineering teams use specialized tools for version control, issue tracking, CI/CD, security scanning, governance, and cloud-native deployment. The problem is not that these individual tools are inadequate — the problem is that **delivery state, workflow context, policy evaluations, and deployment governance are fragmented across them**.

The **Unified DevOps Platform** acts as an operational control and visualization layer ABOVE existing tools, observing and correlating their state without displacing them:

```text
Requirement
   ↓
Issue (e.g. PAY-101)
   ↓
Branch (feature/PAY-101-checkout)
   ↓
Commit ("PAY-101: Add stripe checkout flow")
   ↓
Pull Request (PR #42)
   ↓
CI Pipeline (GitHub Actions / Jenkins) ──── [Phase 2A / 2B / 2C]
   ↓
Security & Vulnerability Gate (Trivy) ───── [Phase 3]
   ↓
Deployment Governance Policy Evaluation ─── [Phase 3]
   ↓
Cloud-Native Orchestration (K8s / Argo CD) ─ [Phase 4]
   ↓
Real-Time Unified Delivery State (Socket.io)
```

---

## Architectural Guarantees & Philosophy

1. **Strict Overlay Architecture**: The platform observes external systems (Kubernetes, Argo CD, Jenkins, GitHub Actions) via their read-only APIs and webhooks. It **never** acts as a Kubernetes control plane, **never** executes `kubectl` or shell commands, and **never** performs destructive cluster operations (no apply/delete/patch/sync).
2. **Single Authoritative Source of Truth**: Delivery state is projected authoritatively from MongoDB via `GET /api/v1/projects/:projectId/issues/:issueKey/delivery-state`. The frontend never calculates shadow state or calls external clusters directly.
3. **Zero-Secret Exposure**: Sensitive credentials (tokens, CA certificates, IVs, AES auth tags) are encrypted at rest with AES-256-GCM and never exposed to REST endpoints, Socket.io event payloads, or browser DOM.
4. **Idempotent, Bounded Processing**: All webhook ingestion and orchestration observation uses atomic claim records (`WebhookDelivery`, `OrchestrationDelivery`) and BullMQ durable queues with bounded retry backoff.
5. **Real-Time Reactive Updates**: State changes are published to Redis Pub/Sub (`cicd:pipeline-events`) and broadcast via Socket.io to project rooms, prompting reactive client updates without full page reloads or polling loops.

---

## Implementation Status by Phase

### [COMPLETE] Phase 1 — Core Foundation

- **Authentication & RBAC**: JWT with `HttpOnly SameSite=Strict` cookies, password hashing with `bcryptjs` (12 rounds), project-scoped roles (`owner`, `admin`, `developer`, `viewer`).
- **Sequential Issue Tracking**: Atomically sequenced issue keys starting at 100 (`PAY-101`, `PAY-102`).
- **GitHub VCS Integration**: Repository connection with AES-256-GCM encrypted PAT at rest, GraphQL commit/PR synchronization.
- **Traceability Engine**: Multi-step issue key validation linking code changes and PRs to issues.
- **Delivery State Tracker & Dashboard**: Visual stage progression and real-time project metrics.
- **Append-Only Audit Logging & Socket.io Gateway**: Real-time project room event broadcasting.

### [COMPLETE] Phase 2A — GitHub Actions CI Pipeline Visibility

- **HMAC-SHA256 Webhook Gateway**: Verifies `X-Hub-Signature-256` using constant-time comparison.
- **Idempotent CI Models**: `Pipeline` workflow definitions and `PipelineRun` executions with unique indexing.
- **Traceability in CI**: Multi-step extraction linking workflow runs to issues (`PAY-101`).
- **Real-Time Delivery State**: Dynamic CI stage in `DeliveryStateTracker.jsx` and dashboard `PipelineSummary.jsx`.

### [COMPLETE] Phase 2B — Durable CI Event Infrastructure & Reconciliation

- **Redis + BullMQ Architecture**: Webhook intake (HTTP 202) enqueueing durable jobs to the `ci-events` queue.
- **Atomic Delivery Idempotency**: `WebhookDelivery` model with unique `deliveryId` constraint (`X-GitHub-Delivery`).
- **Dedicated CI Worker Process**: Standalone executable `npm run worker:ci` consuming jobs with exponential backoff.
- **Terminal Status Protection**: Out-of-order events cannot regress a terminal `completed` status or overwrite `conclusion`.
- **Scheduled & On-Demand Reconciliation**: BullMQ repeatable reconciliation scheduler and manual reconcile endpoint.
- **Queue Health Diagnostics**: Project-scoped `GET /api/v1/projects/:projectId/cicd/queue-health`.

### [COMPLETE] Phase 2C — Jenkins Integration

- **Jenkins Provider Abstraction**: Normalized CI provider interface with read-only API client.
- **CSRF Crumb & Basic Auth**: Secure token-based communication with external Jenkins controllers.
- **Multi-Branch Pipeline Support**: Workload detection, build tracking, and log extraction.

### [COMPLETE] Phase 3 — Security Scanning & Deployment Governance

- **Security Provider Abstraction**: Pluggable security scanner architecture with Trivy provider implementation.
- **Vulnerability Ingestion & Deduplication**: Canonical schema mapping CVEs, severity ratings, and package metadata.
- **Policy Gate Engine**: Configurable release policies (e.g. `max_severity_count`, `blocking` enforcement).
- **Manual Exception Overrides**: Controlled gate overrides with audit logging.
- **Deployment Governance Projection**: Authoritative evaluation blocking unapproved deployment states.

### [COMPLETE] Phase 4 — Cloud-Native DevOps Orchestration

- **Integration Management**: Secure Kubernetes and Argo CD credentials stored encrypted at rest (AES-256-GCM) with SSRF validation.
- **Argo CD Provider**: Read-only HTTPS client for application health, sync status, and webhook ingestion.
- **Kubernetes Provider**: Read-only HTTPS client observing Deployments, StatefulSets, DaemonSets, and Pods with custom CA validation.
- **Drift Detection Engine**: Deterministic divergence detection (generation mismatch, replica divergence, degraded conditions).
- **Durable Orchestration Queue & Worker**: Standalone `npm run worker:orchestration` BullMQ worker with duplicate suppression.
- **Deployment State Correlation**: Auto-correlates live cluster workloads to issues and commits via `DeploymentService`.
- **Governance Violation Integration**: Surfaces critical alerts when an external deployment completes despite a `BLOCKED` policy gate.
- **Cloud-Native Frontend UI**: Workload cards, health/sync badges, replica monitors, drift alerts, and Argo zero-applications state.
- **Live Infrastructure Verification**: Verified against live Kind Kubernetes cluster (`v1.36.1`), Argo CD server (`v3.5.3`), and Redis/BullMQ.

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
│   │   │   ├── issues/       # Issue tracking, comments, & delivery-state
│   │   │   ├── vcs/          # GitHub GraphQL client & sync engine
│   │   │   ├── cicd/         # CI/CD pipelines, BullMQ queue, & Event Bridge
│   │   │   ├── security/     # Vulnerability scanning & policy engine
│   │   │   ├── deployment/   # Deployment records, governance, & delivery projection
│   │   │   ├── orchestration/# K8s/ArgoCD providers, BullMQ queue, & worker
│   │   │   ├── audit/        # Append-only audit logger
│   │   │   └── notifications/# In-process domain event bus
│   │   ├── middleware/       # Auth guard, project RBAC, Zod validation, rate limiter
│   │   ├── shared/           # Crypto (AES-256-GCM), errors, responses, URL validator
│   │   ├── socket/           # Socket.io gateway with project rooms
│   │   └── workers/          # Standalone workers (ci.worker.js, orchestration.worker.js)
│   └── tests/                # Automated Jest test suites (in-memory MongoDB)
│
└── client/                   # React 19 SPA (Vite + Tailwind CSS v4)
    └── src/
        ├── features/         # Domain slices, pages, and components
        │   ├── auth/         # Login, register, profile
        │   ├── dashboard/    # Project dashboard & stats overview
        │   ├── issues/       # Issue board, details, & DeliveryStateTracker
        │   ├── cicd/         # CI/CD pipelines & queue health
        │   └── security/     # Security scans & policy gates
        ├── components/       # Shared UI, layout, and protected route guards
        ├── lib/              # Axios with credentials, Socket.io singleton
        └── routes/           # Declarative React Router mapping
```

---

## Getting Started

### Prerequisites

| Service               | Version                               | Purpose                          | Requirement               |
| :-------------------- | :------------------------------------ | :------------------------------- | :------------------------ |
| **Node.js**           | `>= 20.0.0` (Node 22 LTS recommended) | Runtime environment              | **Required**              |
| **MongoDB**           | `>= 6.0`                              | Primary application database     | **Required**              |
| **Redis**             | `>= 6.2`                              | BullMQ queues and Pub/Sub bridge | **Required**              |
| **Kind / Kubernetes** | `v1.28+`                              | External cloud-native cluster    | _Optional (for Live E2E)_ |
| **Argo CD**           | `v2.8+`                               | GitOps deployment controller     | _Optional (for Live E2E)_ |

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

Key variables to configure in `.env`:

```env
NODE_ENV=development
PORT=5000
MONGODB_URI=mongodb://localhost:27017/unified-devops
JWT_SECRET=your-random-32-character-secret
ENCRYPTION_KEY=your-random-64-char-hex-encryption-key
CORS_ORIGIN=http://localhost:5173
REDIS_URL=redis://localhost:6379

# Cloud-Native Orchestration (allow localhost/private IP clusters in dev)
ALLOW_PRIVATE_ORCHESTRATION_URLS=true
```

### 3. Running Development Services

In terminal sessions:

```bash
# Terminal 1: Backend API Server (Express)
npm run dev:server

# Terminal 2: CI Background Worker (BullMQ + Redis)
npm run worker:ci

# Terminal 3: Cloud-Native Orchestration Worker (BullMQ + Redis)
npm run worker:orchestration

# Terminal 4: Frontend Client SPA (Vite)
npm run dev:client
```

Open `http://localhost:5173` in your browser.

---

## Verification & Quality Assurance

The platform enforces automated quality gates with zero warnings and zero regressions:

```bash
# Run full automated backend regression suite (449 tests across 25 suites)
npm test

# Run all Phase 4 Cloud-Native Orchestration tests (155 tests across 6 suites)
npm test -- server/src/modules/orchestration

# Run Vite frontend production bundle build
npm run build

# Run ESLint check (0 errors, 0 warnings enforced)
npm run lint

# Run Prettier code style check
npm run format:check
```

---

## License

This project is licensed under the MIT License.
