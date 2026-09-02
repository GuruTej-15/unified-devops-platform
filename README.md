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
CI Pipeline   (PLANNED — Phase 2)
   ↓
Security Gate (PLANNED — Phase 3)
   ↓
Deployment    (PLANNED — Phase 4)
```

---

## Implementation Status by Phase

### [IMPLEMENTED] Phase 1 Core Foundation

1. **Authentication & Identity**:
   - `HttpOnly SameSite=Strict` cookie session for browser clients (XSS protection).
   - Fallback `Authorization: Bearer <token>` support for API / CLI consumers.
   - Password hashing with `bcryptjs` (12 rounds). Plaintext passwords never stored.
   - JWT secret configured via environment variables.

2. **Project Management & Project-Level RBAC**:
   - Project lifecycle (create, read, update, archive).
   - Atomic sequential issue counter starting at 100 (`PAY-101`, `PAY-102`).
   - Project-level authorization: `owner`, `admin`, `developer`, `viewer`. Non-members strictly forbidden (403) from accessing project details, issues, repositories, and project audit records.

3. **Issue Tracking & Discussion**:
   - Full issue lifecycle (Open, In Progress, In Review, Done, Closed).
   - Priority levels (Low, Medium, High, Critical) and issue types (Task, Bug, Feature, Improvement).
   - Discussion stream with real-time Socket.io project room updates.

4. **GitHub VCS Integration**:
   - Repository connection with validation against GitHub GraphQL v4 API.
   - Live branch querying, commit synchronization, and pull request synchronization.
   - Cursor-based pagination and rate limit error handling.
   - Synchronization failure handling: captures error reasons, maintains `lastSuccessfulSyncAt`, and renders failure states gracefully without crashing.

5. **PAT Security at Rest**:
   - Personal Access Tokens (PATs) encrypted at rest with **AES-256-GCM** using `ENCRYPTION_KEY`.
   - PATs are never returned to clients, stored in Redux, logged, exposed in URLs, or serialized in responses. Schema-level transforms and token masking (`••••••••abcd`) ensure zero token leakage.

6. **Traceability Engine**:
   - Multi-step validation: `Candidate Keys -> Valid Project Namespace -> Existing Issue Record -> Verified Traceability Link`.
   - Commit messages, PR titles, PR bodies, and branch names linked to project issues. Duplicate sync calls update existing records without creating duplicate entries.

7. **Unified Delivery State Tracker**:
   - Interactive visual lifecycle component in the issue detail view showing stage progression (Issue -> Branch -> Commit -> Pull Request -> CI/CD -> Security -> Deploy).

8. **Engineering Dashboard**:
   - Aggregated metrics, delivery status breakdown charts powered by Recharts, recent commits widget, and recent project activity stream.

9. **Application-Level Append-Only Audit Logging**:
   - Append-only event stream logging authentication, project updates, membership changes, issue status/assignments, and repository sync operations.
   - Strict read-only API (no update/delete endpoints). Sensitive credentials and passwords are never included in audit metadata.

10. **In-Process Domain Event Bus & Real-Time Gateway**:
    - In-process event bus for decoupled domain events, designed for replacement by durable Redis/BullMQ infrastructure in Phase 2.
    - Socket.io gateway with authenticated project rooms (`project:{projectId}`) enforcing membership authorization.

---

### [PLANNED] Future Roadmap

- **Phase 2 — CI/CD Pipeline Visibility**: GitHub Actions & Jenkins webhook ingestion, live build/test status, BullMQ / Redis Streams queue persistence.
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
│   │   │   ├── auth/         # Authentication & token generation
│   │   │   ├── users/        # User accounts & directory
│   │   │   ├── projects/     # Projects, membership RBAC, and counters
│   │   │   ├── issues/       # Issue tracking & discussion comments
│   │   │   ├── vcs/          # GitHub GraphQL client & sync engine
│   │   │   ├── audit/        # Append-only audit logger
│   │   │   └── notifications/# In-process domain event bus
│   │   ├── middleware/       # Auth guard, project RBAC, Zod validation, rate limiter
│   │   ├── shared/           # Crypto (AES-256-GCM), errors, responses, parser
│   │   └── socket/           # Socket.io gateway with project rooms
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

- **Node.js**: >= 20.0.0 (Node 22 or 24 LTS recommended)
- **MongoDB**: Running instance on `mongodb://localhost:27017` (or MongoDB Atlas)

### 1. Installation

```bash
git clone <repo-url>
cd unified-devops-platform
npm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Generate secure secrets:

```bash
# Generate 32-byte JWT Secret:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate 32-byte (64 hex characters) AES-256-GCM Encryption Key:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Configure `.env`:

```env
NODE_ENV=development
PORT=5000
MONGODB_URI=mongodb://localhost:27017/unified-devops
JWT_SECRET=<your-64-character-jwt-secret>
JWT_EXPIRES_IN=24h
ENCRYPTION_KEY=<your-64-character-hex-encryption-key>
CORS_ORIGIN=http://localhost:5173
```

### 3. Run Development Servers

```bash
npm run dev
```

Or run services individually:

```bash
npm run dev:server    # Backend API on port 5000
npm run dev:client    # Frontend SPA on port 5173
```

Open `http://localhost:5173` in your browser.

---

## Testing & Quality Assurance

```bash
# Run automated backend test suites (in-memory MongoDB)
npm test

# Run Vite frontend production bundle build
npm run build

# Run ESLint check
npm run lint

# Run Prettier code formatting check
npm run format:check
```

---

## End-to-End Verification Flow

1. **Register & Authenticate**: Create an account at `/register` -> automatically sets `HttpOnly` cookie.
2. **Create Project**: Create "Payment Service" with key `PAY` -> `ProjectCounter` initialized.
3. **Manage Members**: Add team members with roles (`developer`, `viewer`, `admin`).
4. **Create Issues**: Create tasks -> sequentially assigned `PAY-101`, `PAY-102`.
5. **Connect GitHub Repository**: Provide repo name and GitHub PAT -> PAT encrypted via AES-256-GCM at rest.
6. **Sync Repository**: Sync commits and PRs -> candidate issue keys matched against verified project issues.
7. **Trace Delivery**: Open issue `PAY-101` -> `DeliveryStateTracker` displays associated branch, commits, PRs, and future phase gates.
8. **Inspect Dashboard**: View real-time KPIs, Recharts delivery distribution chart, and commit streams.
9. **Review Audit Trail**: Open `/audit-logs` -> inspect append-only event stream.
