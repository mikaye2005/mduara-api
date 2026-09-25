# mduara-api

## Database setup

The API uses PostgreSQL directly through `pg` and SQL migrations. Copy `.env.example` to `.env`, set `DATABASE_URL`, and configure the initial platform administrator before running migrations.

```bash
SUPER_ADMIN_FULL_NAME=Platform Administrator
SUPER_ADMIN_EMAIL=admin@example.com
SUPER_ADMIN_PHONE=+254712345678
SUPER_ADMIN_PIN=<private-4-to-6-digit-pin>
```

```bash
npm install
npm run migrate
```

`npm run migrate` loads `.env`, applies migrations, then creates an active, verified platform super administrator with `is_platform_admin = true`. It is idempotent: an account with the same email and phone is activated and promoted if necessary, while its existing PIN is preserved. The command validates the four `SUPER_ADMIN_*` values before applying migrations, so a missing or invalid 4-6 digit PIN cannot leave a newly provisioned database without its administrator.

Use `npm run db:migrate` only when a schema-only migration is intentional; it does not bootstrap a super administrator.

### Local payment simulation

Set `MPESA_PROVIDER=console` during local development when Daraja is not integrated. STK initiation is then automatically confirmed through the same callback settlement code used by real M-Pesa payments. This supports Chama registration, commitment deposits, member contributions, and subscription payments without weakening their state transitions or ledger writes. Console payment mode is rejected when `NODE_ENV=production`; production must use `MPESA_PROVIDER=daraja` with valid Daraja credentials and callback URLs.

The canonical initial schema is `migrations/001_initial_schema.sql`. Migration state is tracked by `node-pg-migrate`, and migrations run transactionally so a failed initial provision cannot leave a half-created database. The runtime connection pool is exported from `src/db/client.ts`.

The initial schema intentionally contains the complete Phase 1 data model, including identity/session tables, Chamas and memberships, applications/invitations, versioned Constitution rules and acceptance records, commitment deposits, contributions, double-entry ledger/audit records, loans/guarantors/repayments, meetings, notifications, governance polls, subscriptions and support tickets. Later backend issues should add behaviour around these structures instead of introducing competing tables for the same concepts.

For a disposable local/test database only, the initial migration can be rolled back with:

```bash
npm run db:rollback
```

Do not use rollback as a production data-migration strategy. Production changes after launch remain forward migrations so financial and audit history is preserved.

## Authentication contract

M-Duara has one canonical primary sign-in model: **verified phone number + security PIN**. Email remains profile/contact data; it is not a competing primary credential. Password login and password-reset endpoints are not part of the Phase 1 contract.

- `POST /api/v1/auth/register` accepts `fullName`, E.164 `phone`, `email`, and a 4–6 digit `pin`, stores only a bcrypt hash, creates a pending account, and sends a registration OTP.
- `POST /api/v1/auth/verify-otp` activates the pending account and creates the first JWT session. Registration OTPs can be resent through `POST /api/v1/auth/send-otp` with `purpose: "registration"`.
- `POST /api/v1/auth/login` accepts only `phone` + `pin`. Failed attempts are tracked in PostgreSQL; after `PIN_MAX_FAILED_ATTEMPTS` the account is temporarily locked for `PIN_LOCKOUT_MINUTES`.
- PIN recovery is `phone → OTP → new PIN`: request with `purpose: "pin_reset"`, then call `POST /api/v1/auth/reset-pin`. Recovery responses are deliberately generic so they cannot be used to enumerate registered phone numbers.
- `PATCH /api/v1/auth/pin` requires the current PIN and a different new PIN. PIN changes/recovery invalidate all refresh tokens and increment `users.session_version`, immediately invalidating older access tokens when middleware rechecks PostgreSQL.
- OTP request throttling, resend cooldowns, OTP attempts, credential lockouts, session state, and refresh-token hashes are PostgreSQL-backed. Redis is not part of the Phase 1 runtime.
- Access and refresh JWTs use separate derived/configured secrets. Refresh tokens are stored only as hashes and rotate on refresh; detected refresh-token reuse invalidates every session for that user.
- `GET /api/v1/auth/me` returns authoritative profile/session context, including `isPlatformAdmin` separately from Chama-scoped membership roles. Chama offices are never selected during login.

Relevant settings are documented in `.env.example`: `OTP_*`, `PIN_MAX_FAILED_ATTEMPTS`, `PIN_LOCKOUT_MINUTES`, `BCRYPT_SALT_ROUNDS`, and `JWT_*`.

## Treasury ledger

`LedgerService` in `src/services/ledger.service.ts` is the only application
entry point for changing `chamas.pooled_amount`:

- `recordDeposit` debits the chama treasury and credits member contributions.
- `recordPayout` debits member payouts and credits the chama treasury.
- `recordTransfer` credits one chama treasury and debits the other.

All operations require a unique, stable `reference` (for example an M-Pesa
receipt or a generated idempotency key). The service locks each affected chama
treasury with `FOR UPDATE`, writes both immutable ledger entries, and applies
the balance changes in one serializable database transaction. The database
rejects an unbalanced journal or a direct `pooled_amount` update that has no
matching treasury ledger entry.

## Access control

The middleware is framework-compatible and is installed after the application
has supplied a verifier that validates bearer-token signature, expiry, and
revocation. It never trusts an undecoded/unverified JWT payload.

```ts
app.use(createBearerAuthentication(verifyBearerToken));
app.use(protectAdministrativeRoutes());

// Every transaction-history request must prove active membership.
router.get('/chamas/:chamaId/transactions', requireChamaMembership(), historyHandler);

// Group administration requires the role currently stored in PostgreSQL.
router.patch(
  '/chamas/:chamaId/settings',
  requireChamaRoles(['CHAIRPERSON', 'TREASURER']),
  updateSettingsHandler,
);
```

`requireChamaMembership` queries `chama_members` with
`membership_status = 'active'`; it returns HTTP 403 for users outside the
group or without the required group role. `protectAdministrativeRoutes` limits
`/api/v1/admin/*` to `SUPER_ADMIN` tokens.

## Background scheduling

The separate `node-cron` worker scans existing contribution obligations and loan
contracts. It does not create contribution periods; the contribution workflow
must populate `contributions` with each member's expected amount and due date.

### Run

```bash
npm install
npm run migrate
npm run build
npm start        # API process
npm run worker  # separate, supervised worker process
```

For development, use `npm run worker:dev`. Both processes load `.env`. The
migration CLI requires `DATABASE_URL`; the runtime also supports the `DB_*`
variables in `.env.example`. Apply migrations before starting the updated API or worker. Once an environment contains real financial or audit history, evolve it with forward migrations rather than rolling the initial schema back.

| Work | Schedule in `SCHEDULER_TIMEZONE` (default `Africa/Nairobi`) |
| --- | --- |
| Contribution penalties and loan interest | Midnight daily (`0 0 * * *`) |
| Financial recovery after failures or locked records | Five minutes past every hour |
| Reminder creation and delivery | Every minute |
| Restart recovery | Immediately when the worker starts |

The database stores due dates without a time. A payment is due **by the end of
that local date**; the deadline is the following midnight. For example, a
September 17 obligation has a September 18 00:00 Nairobi deadline, and its
48-hour reminder becomes eligible September 16 00:00 Nairobi. Delivery is
attempted on the first minute tick after eligibility. Following downtime,
unsent reminders are recovered until the deadline; expired reminders are
cancelled. Provider latency and delivery capacity affect actual arrival time.

### Contribution rules

The existing `/api/v1/contribution-rules` API accepts these additional fields:

```json
{
  "late_fee_type": "percentage",
  "late_fee_percentage": 2.5,
  "grace_period_days": 2
}
```

- `late_fee_type: "flat"` uses `late_fee` in whole KES and remains the default
  for existing rules. `"percentage"` uses `late_fee_percentage` (0–100).
- The latest rule effective on the contribution's due date applies. Grace days
  extend the penalty deadline, but do not move the nominal reminder deadline.
- Only confirmed payments made **before** the penalty deadline reduce the
  penalty base. Percentage fees apply to that unpaid amount. Fractional KES
  round upward, matching existing loan pricing; all money arithmetic uses
  `bigint`.
- A late settlement still attracts the fee when the worker catches up. Fully
  paid-on-time and waived contributions, inactive Chamas, and inactive members
  receive no fee. Missing rules or zero fees create no charge. An assessment is
  final; later rule edits or backdated payment corrections require an explicit
  accounting adjustment, not an automatic rewrite of financial history.
- Each charge creates a `penalties` row plus a balanced, immutable journal:
  debit `member_penalty_receivable` (with `ledger_entries.member_id`) and credit
  `penalty_income`. Assessment does not change `chamas.pooled_amount`.

### BE-08 reconciliation gate and automatic default escalation

Penalty assessment is fail-closed against provider recovery. Before a contribution is
marked assessed, charged, or counted as a miss, the worker requires a completed clean
`mpesa` reconciliation run whose window covers the full local due-date start through
the applicable grace deadline. `completed_at` must be present and `mismatch_count`
must be zero. If that evidence is absent or still contains mismatches, the worker leaves
`penalty_checked_at` unset; the hourly recovery scan retries after reconciliation. This
prevents a missed webhook/server outage from turning a provider-confirmed payment into
a false penalty.

Every assessed contribution now stores `missed_at` plus `consecutive_miss_count`. A
late settlement can therefore remain `paid` while still recording that the grace
deadline was missed. A timely assessed contribution resets the stored consecutive count
to zero. Miss escalation uses the latest Constitution version accepted by that
membership and its `default_after_consecutive_misses` value (canonical default: `3`).
The first miss moves a held commitment to `at_risk`; further misses preserve that state;
when the configured consecutive-miss threshold is reached, the same penalty transaction
moves the commitment to `default_triggered` and the membership to `defaulted` with
system financial audit events. No chair/secretary action is involved. Forfeiture after
`default_triggered` remains a separate BE-15/BE-34 rules-engine decision; BE-08 does not
invent partial-forfeiture or re-entry policy.

### Loan interest cycles

Set `interestCycleDays` on `PUT /api/v1/loans/chamas/:chamaId/rules`, alongside
the existing required loan-rule fields. For example, `30` means one cycle every
30 calendar days. Omit the field to preserve an existing setting; pass `null`
to return future loans to one-time interest.

New loans snapshot the cycle length and interest rate when applied for. Existing
loans keep `interest_cycle_days = NULL` and retain their one-time pricing unless
explicitly migrated. The interest already included in `total_due` covers the
first cycle. On successful disbursement the next cycle is scheduled one cycle
after the local disbursement date.

Each elapsed cycle adds simple interest on the **original principal** to
`total_due`, with one `loan_interest_accruals` record and balanced member
interest/income ledger entries. Partial repayments do not compound or reduce
the interest base. No new cycles accrue after the contractual due date, or for
pending, repaid, rejected, cancelled, or defaulted loans. Overdue loans do not
automatically gain a different interest policy. Repayment catches up elapsed
cycles under the same loan lock before calculating the remaining balance.
If a loan has more than 100 missed cycles, repayment requests ask the caller to
retry after worker catch-up, instead of silently omitting charges or holding an
API transaction open indefinitely.

### Delivery and operation

- `REMINDER_CHANNELS` is `sms`, `email`, or `sms,email`. SMS reuses Africa's
  Talking; email uses SMTP. Configure the provider settings in `.env.example`.
  Production worker startup rejects console providers for enabled channels.
- A PostgreSQL outbox deduplicates reminders by obligation, due date, and channel.
  Before sending, the worker rechecks membership, active Chama, current due date,
  and confirmed outstanding balance. Paid or rescheduled reminders are cancelled.
- Delivery retries up to eight attempts with exponential backoff (30 seconds to
  one hour). A 60-second lease recovers abandoned attempts. `sent` means the
  provider accepted the request, not that the recipient has read it. External
  delivery is **at least once**: a crash after provider acceptance but before the
  database acknowledgement can produce a duplicate SMS/email. Financial charges
  remain unique across retries and concurrent workers.
- Worker database connections are separate from the API, capped by
  `WORKER_DB_POOL_MAX` (default 2). Keyset scans use `WORKER_BATCH_SIZE` (default
  100). Short transactions lock only individual obligations using `SKIP LOCKED`;
  ordinary reads stay available. Queries have timeouts and network delivery
  happens after releasing the database connection. Existing-table indexes are
  built concurrently; schema changes use a short lock timeout and should be
  retried if a busy deployment cannot acquire it.
- Logs include job duration, charge counts, delivery results and failed entity
  IDs. Monitor `reminder_deliveries` for `failed` rows, overdue pending work, and
  expired processing leases. Investigate the provider before manually requeueing
  a failed, still-relevant delivery. Supervise the worker with the deployment's
  process manager; SIGINT/SIGTERM stop new work and wait for in-flight work.

### Verification

```bash
npm run typecheck
npm test
# Use a dedicated local/test PostgreSQL database, never production.
TEST_DATABASE_URL=postgres://postgres:password@localhost/mduara_test npm run test:integration
```

On PowerShell, set `$env:TEST_DATABASE_URL` before running the integration
command. The tests apply all migrations in a uniquely named test schema and
remove that schema afterward. They cover deadline boundaries, grace periods,
partial/late payments, rollback, concurrent workers, nonblocking reads,
interest catch-up, the 48-hour reminder window, retries, expired leases and stale
reminder suppression. Integration tests skip when `TEST_DATABASE_URL` is absent.

Implementation references: [node-cron scheduling options](https://nodecron.com/scheduling-options.html),
[PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS),
and [Nodemailer SMTP transport](https://nodemailer.com/smtp).

## Ledger idempotency and provider reconciliation

Phase 1 does not require a contracted M-Pesa/SMS/custody provider. The financial core is provider-agnostic:

- Every ledger mutation requires a stable `reference`. Concurrent requests using the same reference are serialized with a transaction-scoped PostgreSQL advisory lock.
- Replaying the exact same financial instruction returns the existing ledger transaction with `replayed: true`; it does not post a second journal or change the treasury twice.
- Reusing a reference with a different operation, Chama, amount, account composition, or currency throws `IdempotencyConflictError`.
- Treasury rows are locked deterministically with `SELECT ... FOR UPDATE`, balances cannot go below zero, and every journal must balance before commit.
- `LedgerService.reconcileProviderWindow(...)` accepts normalized provider records from any future adapter. It compares them with provider-tagged ledger transactions for a time window and persists matched/missing/amount/currency mismatch evidence in `ledger_reconciliation_runs` and `ledger_reconciliation_items`.
- A future Daraja/bank/custody integration should only fetch/normalize provider transactions and pass them to this reconciliation boundary. Provider SDK/network logic must not be embedded in the ledger engine.

For ledger operations that will later reconcile with a provider, include the provider identity in metadata, for example `{ provider: 'mpesa' }`, and use the provider transaction/receipt identifier as the stable ledger reference where possible.


## User & Chama group management (BE-06)

BE-06 owns authenticated profile metadata and the operational Chama-management lifecycle that sits around the later discovery, commitment and multi-Chama read models. It reuses the canonical `users`, `chamas`, `chama_members`, `chama_applications`, `chama_invitations`, `chama_rules`, `membership_constitution_acceptances` and `commitment_deposits` tables; no parallel membership/application tables are introduced.

Profile management:

- `PATCH /api/v1/users/me` updates only self-service profile metadata (`fullName`, `nationalId`, `dateOfBirth`, `avatarUrl`). Phone, email, PIN, verification and account status are intentionally excluded because they have separate security/verification semantics.
- `/api/v1/auth/me` includes the same profile identity, including `nationalId`, plus Chama-scoped session memberships.

Chama management:

- `POST /api/v1/chamas` atomically creates the Chama, its founder's active `chairperson` membership, and initial active Constitution version 1 from the approved creation contribution terms. Policy fields use canonical database defaults; no separate bootstrap step is required before the Chama can accept members.
- `GET /api/v1/chamas/:id` requires active Chama membership. `PATCH /api/v1/chamas/:id` is restricted to Chairperson/Secretary and updates approved Chama metadata only; unresolved Chama status/archive policy is not guessed here.
- `GET /api/v1/chamas/:id/members` and `PATCH /api/v1/chamas/:id/members/:userId` provide member administration. Exit transitions maintain `exit_date`, reactivation clears it, and the final active chairperson cannot be demoted/exited/suspended until another active chairperson exists.
- `GET /api/v1/chamas/:id/applications` and `PATCH /api/v1/chamas/:id/applications/:applicationId` provide Chairperson/Secretary review. Approval rechecks capacity and the accepted active Constitution under the Chama row lock. If the accepted rule requires a commitment, approval creates a pending membership + `commitment_pending` application + commitment deposit; only BE-34 provider confirmation activates that member.
- `POST /api/v1/chamas/:id/invite`, `GET /api/v1/chamas/:id/invitations`, `DELETE /api/v1/chamas/:id/invitations/:invitationId`, and `POST /api/v1/chamas/:id/invitations/:invitationId/resend` provide the leadership invitation lifecycle. `POST /api/v1/chamas/:id/invitations/:invitationId/reject` is authenticated but does not require membership; the service verifies that the signed-in user is the intended invitee.
- Phone-only invitations may be created before the recipient has an account. After signup, the private join transaction matches the authenticated user's phone, claims the invite to that user, and then applies the same Constitution/capacity/commitment checks as any other private join.

The dedicated integration regression is `src/tests/integration/chama-management.test.ts`.

Constitution version 2+ authoring/activation belongs to BE-15 (Constitution / Rules Engine) and is intentionally not duplicated by BE-06. Chama archive/status-transition governance also remains policy-dependent and is not guessed here. Existing joins continue to consume the immutable active Constitution version, and PD-19 keeps the commitment amount Constitution-backed while fixed-vs-configurable policy remains open.

## Loan origination, guarantor collateral and disbursement (BE-07)

BE-07 uses the canonical `loans`, `loan_rules`, `loan_guarantors`, `loan_disbursements`, `loan_repayments`, `audit_logs` and double-entry ledger tables. The lifecycle is intentionally stateful; an M-Pesa API dispatch acknowledgement is never treated as proof that money moved.

- `POST /api/v1/loans/apply` validates active Chama membership, the configured savings multiplier, minimum guarantors and maximum term. Accepted development/test applications begin in `awaiting_guarantors`. Requests above the configured borrowing capacity return `LOAN_CAPACITY_EXCEEDED` with 422 semantics.
- `POST /api/v1/loans/:id/guarantors` is executable only by a nominated active member. Acceptance immediately encumbers that member's confirmed Chama savings: approved pledges attached to non-terminal loans are deducted from future available-guarantee capacity. Once both the required guarantor count and 100% principal coverage are accepted, the loan moves to `pending_admin_approval`.
- `PATCH /api/v1/loans/:id/approve` is sequential. The Treasurer must approve first, producing `partially_approved` and an immutable financial audit record. Only then may the Chairperson give final approval. Final approval creates a durable `disbursement_pending` row before any provider call.
- Chair approval does not mark a loan disbursed. The Daraja B2C dispatch only stores its ConversationID and leaves both loan/disbursement pending until the verified provider result arrives. Configure `MPESA_B2C_RESULT_URL` to `/api/v1/loans/mpesa/b2c/result` and `MPESA_B2C_TIMEOUT_URL` to `/api/v1/loans/mpesa/b2c/timeout`.
- A successful verified B2C result posts a `loan_disbursement` double-entry journal (`member_loan_principal` debit / `chama_treasury` credit), updates the protected pooled balance in the same PostgreSQL transaction, and moves the loan to `disbursed`. Replayed provider results are idempotent through the provider transaction reference. A failed/timeout result moves the loan to `disbursement_failed`; a dispatched-but-unreconciled payout is not safe to reject.
- `PATCH /api/v1/loans/:id/reject` is restricted to Treasurer/Chairperson and records the reason in immutable audit history. Pre-disbursement rejection immediately releases collateral because rejected loans are excluded from the encumbered-savings calculation.
- `POST /api/v1/loans/:id/repay` no longer lets a borrower self-confirm movement of money. It records borrower-supplied repayment evidence as `pending`; outstanding balance/status are unchanged until a trusted provider/reconciliation boundary confirms settlement.
- `src/tests/integration/loan-lifecycle.test.ts` covers threshold rejection, immediate collateral locking, the 100% guarantor gate, Treasurer→Chair sequencing, provider-pending B2C behavior, provider-confirmed disbursement/ledger idempotency, and collateral release after rejection.

**PD-22 safety boundary:** the exact production interest/amortisation method is still unresolved. Production loan application and final B2C disbursement therefore fail closed with policy-specific errors while PD-22 remains open. Development/test retains the legacy rate calculation only to exercise the state machine. Repayment-schedule generation and the transition from `disbursed` into an approved active repayment contract must not be finalized until PD-22 records the selected interest method, rate interpretation, accrual cadence and rounding rules.

The external provider call cannot be made part of a PostgreSQL ACID transaction. BE-07 therefore uses a durable state machine instead: database approval commits first, provider dispatch is attempted second, and only verified provider result/reconciliation may settle the local financial state. This prevents the API from falsely reporting `DISBURSED` merely because Daraja accepted a request.

## Chama membership roles (BE-25)

M-Duara uses one membership row per `(chama_id, user_id)`. Every `chama_members` row represents a Member. The stored `role` value `member` means that the membership holds no official office; `chairperson`, `secretary`, and `treasurer` represent the single official office held by that membership and inherit ordinary Member capabilities. One official office never implies another official office.

Platform administration is intentionally separate from Chama membership. `users.is_platform_admin` is the only platform-admin source of truth; `super_admin` is not a valid `member_role` value and must never be written to `chama_members`. Chama-scoped authorization always resolves the requested Chama against the live PostgreSQL membership row so an office held in Chama A cannot authorize Chama B. Shared config-driven policies use the same inheritance rule and may opt into platform-admin bypass explicitly with `allowPlatformAdmin`.


## Server-side RBAC (BE-04)

Authorization is fail-closed and server-side. JWT membership claims are session hints only; Chama-scoped middleware re-queries the active `(user_id, chama_id)` membership from PostgreSQL before granting access. `MEMBER` capability is inherited by chairperson, secretary and treasurer, while official offices do not inherit one another.

Every platform-admin path is guarded at `/api/v1/admin` by authenticated `SUPER_ADMIN` identity derived from `users.is_platform_admin`. Platform administration is not encoded in `chama_members.role`. Config-driven Chama policies use the same PostgreSQL membership semantics, and platform-admin bypass must be enabled explicitly with `allowPlatformAdmin`.


## Session context and active Chama selection (BE-26)

`GET /api/v1/auth/me` is the authoritative shell/session-context endpoint. Login, registration verification and refresh return the same context shape alongside token data. The response includes the user profile, separate `isPlatformAdmin`, every Chama membership with `membershipStatus`, stored membership role, derived `officialRole`, Chama name/logo and membership id, plus one deterministic `defaultContext`.

The default active Chama rule is: active memberships first, then newest `joined_at`, then membership id as a stable tie-breaker. Suspended, defaulted or exited memberships may remain visible for history/context, but they are never chosen as `defaultContext` and the authorization middleware will not grant them Chama-scoped privileges. The frontend must not infer a global Chair/Secretary/Treasurer role from this response; office authority belongs only to the corresponding membership.

## Multi-Chama personal member summary (BE-27)

`GET /api/v1/users/me/summary?page=1&per_page=20` returns the authenticated user's own dashboard read model across all Chama memberships. The user id is taken only from the verified session; the endpoint does not accept an arbitrary member/user id.

Money values are returned as decimal strings so BIGINT amounts are not rounded by JavaScript. `confirmedContributedAmount` and the cross-Chama `totalConfirmedContributions` count only `contribution_payments.status = 'confirmed'`. `scheduledExpectedAmount` is the sum of that membership's generated contribution obligations, and `contributionProgressPercent` is confirmed contributions divided by scheduled expected contributions. This is deliberately a contribution-progress metric; the Phase 1 goal-based personal target model is introduced separately by the goal/Mbogi issues.

Each membership card contains its Chama identity, membership status, stored role/active official role, personal contribution totals, and the user's own earliest outstanding contribution for active memberships. Suspended/exited memberships remain visible for context/history but do not expose an actionable next-due item. Cross-Chama `nextUpcomingObligation` always identifies the Chama and membership it belongs to.

The summary service uses bounded pagination (`per_page` 1-50) and set-based PostgreSQL queries rather than one query per Chama. Every financial CTE is first scoped through `chama_members.user_id = authenticatedUserId`; raw amounts belonging to other members are therefore excluded by construction.

## Public Chama discovery and entry (BE-28)

Public marketplace reads do not require authentication:

- `GET /api/v1/chamas/public` lists only `public` and `application` Chamas. Supported filters include goal code, Chama status/type, visibility, location, contribution range, saving duration, and capacity. Responses never contain member phone numbers, payment methods, pooled treasury balances or member-level financial amounts.
- `GET /api/v1/chamas/public/:id` returns the selected public/application Chama, public-safe official names/offices, recruitment/cycle timing, contribution terms and the active Constitution/rules summary. Private Chamas intentionally resolve as not found through the public-detail contract.

The canonical `chamas` model now contains optional `saving_start_date`, `saving_end_date`, `purchase_window_start` and `purchase_window_end` fields. They support the shared saving-cycle timeline approved for goal-based Mbogis while remaining generic enough for other Chama types. These fields live in the single `migrations/001_initial_schema.sql` source of truth.

`POST /api/v1/chamas/:id/apply` is authenticated and re-resolves all state inside a PostgreSQL transaction. The client must acknowledge the current active Constitution by id. Entry behaviour is visibility-specific:

- `application`: records a pending `chama_applications` row with the Constitution version/acceptance timestamp and creates no membership.
- `public`: auto-approves entry, records Constitution acceptance and creates a membership. Where the active Constitution requires a commitment amount, the membership remains `pending` and the response is `commitment_required`; it is not falsely reported active before BE-34's confirmed commitment transition.
- `private`: direct application is rejected. An applicant-specific, unexpired and unused invitation is required; after validation it follows the same commitment gate as direct public entry.

For goal-based Chamas, the legacy Chama-level `target_amount` is not exposed as the member goal target. Phase 1 personal targets and aggregate marketplace target value are modeled by the dedicated goal/Mbogi issues so individual targets can differ without conflating them with a single group target.

## Phase 1 goal catalog (BE-29)

M-Duara keeps the Phase 1 Mbogi marketplace catalog in PostgreSQL. `goal_categories` and `saving_goals` are seeded deterministically by the canonical `migrations/001_initial_schema.sql`; the frontend should consume this catalog instead of hard-coding which goals belong to which category. `chamas.goal_code` remains the compatibility field used by existing Chama flows, but it now references the canonical `saving_goals.code` value.

Public read endpoints are:

- `GET /api/v1/goals/categories` — active categories with their goal counts.
- `GET /api/v1/goals?category_code=home_appliances` — active goals, optionally filtered by category code.
- `GET /api/v1/goals/:identifier` — goal detail by UUID, stable code, or slug.

Stable codes use lowercase snake case (for example `washing_machine`, `professional_course`, and `university_fees`). Category and goal UUIDs are deterministic in the initial schema so development/test resets recreate the same canonical records.

## Goal marketplace aggregate metrics (BE-30)

The public marketplace now has backend-derived goal-card metrics. The API is additive to the BE-29 catalog:

- `GET /api/v1/goals/metrics` — metrics for every active saving goal.
- `GET /api/v1/goals/metrics?category_code=home_appliances` — the same metrics filtered to one active category.
- `GET /api/v1/goals/:identifier/metrics` — metrics for one goal by UUID, stable code or slug.

Each response includes `membersSaving`, `totalTargetValue`, `currency`, and `partnerMerchantCount` together with the canonical goal/category identity. Metric definitions are deliberately server-owned:

- **Eligible Chamas:** only `recruiting` or `active` Chamas with marketplace visibility (`public` or `application`) and `currency = 'KES'`. Draft, inactive, completed, dissolved, archived, private and non-KES Chamas do not contribute to the public Phase 1 aggregate.
- **Members saving:** `COUNT(DISTINCT user_id)` across eligible Chamas where `chama_members.membership_status = 'active'`. A pending membership does not count as saving yet, and one user active in two Chamas for the same goal is counted once.
- **Total target value:** the sum of each eligible Chama's `chamas.target_amount` exactly once. `NULL` targets contribute zero. This is a collective marketplace aggregate; it does not reinterpret a Chama target as an individual member's personal goal target.
- **Partner merchants:** distinct active merchants attached through active, currently valid goal partnerships. BE-33 owns the canonical `partner_merchants` and `goal_merchant_partnerships` schema. Until those tables exist, the BE-30 endpoint returns `partnerMerchantCount: 0`; after BE-33 lands, the same endpoint reads active partnerships without a frontend contract change. The compatibility fields are `partner_merchants.status`, plus `goal_merchant_partnerships(goal_id, merchant_id, status, valid_from, valid_until)`.

The canonical initial schema includes partial indexes for the eligible Chama and active-membership paths used by this aggregate. A materialized view is intentionally not introduced for the small Phase 1 catalog; the API contract can be backed by a materialized/cached aggregate later if production query volume warrants it.



## Goal-to-Chama matching engine v2 (BE-31)

`POST /api/v1/goals/matches` accepts a canonical goal plus the member's practical saving constraints and returns only eligible Chamas in deterministic rank order. The route remains public for ordinary marketplace matching; if a bearer token is supplied, authenticated invite context may also unlock one matching private Chama. A supplied invalid bearer token fails closed.

Example request:

```json
{
  "goalCode": "washing_machine",
  "targetAmount": 120000,
  "contributionCapacity": 5000,
  "contributionFrequency": "monthly",
  "durationMonths": 12,
  "location": "Nairobi",
  "preferredVisibility": "public",
  "limit": 10
}
```

`goalCode` or `savingGoalId` is required. Both may be supplied, but they must identify the same active canonical saving goal. `targetAmount` is retained as Phase 1 funnel context; it is intentionally **not** compared with `chamas.target_amount`, because the latter is a collective Chama target and the schema does not yet define an authoritative personal-target allocation rule.

Hard eligibility is evaluated before scoring. A candidate must use the exact canonical goal, be a `goal_based` Chama in `recruiting` or `active` state, use KES, have the same contribution frequency, require no more than `contributionCapacity`, have free capacity after counting active + pending memberships, and—when start/end dates are known—finish within `durationMonths`. Public and application Chamas are eligible normally. Private Chamas remain hidden unless the request supplies an `invitationId`, the bearer-token user is the invitation's `applicant_id`, the invitation is pending/sent/approved, unexpired and still has an unused slot.

Ranking is deliberately explainable and deterministic. Version `goal-match-v2.1` uses a fixed exact-goal base plus affordability margin, timeline closeness, optional location match and optional visibility preference. Every result contains `score`, `rank`, `joinable`, `entryMode`, and human-readable `matchReasons`. Ties resolve by lower contribution amount, then timeline distance, then Chama UUID, so identical inputs and database state produce identical ordering.

The existing BE-28/BE-30 indexes already cover the dominant goal/status/visibility and membership lookup paths, so BE-31 does not add a competing schema structure or materialized matching table.

## Governed trust score domain (BE-32)

BE-32 introduces the persistence and API contract for trust scoring **without activating an invented formula**. The canonical migration intentionally seeds **zero** trust-score formula versions. Production score generation must remain unavailable until a founder/product-approved, documented formula version is created and activated.

Trust has two subjects:

- **Member trust:** scoped to one `chama_members` membership. M-Duara does not create one global user trust score that silently mixes unrelated Chamas.
- **Chama trust:** scoped to one Chama and intended for safe aggregate transparency on public/application discovery surfaces.

The prototype's `/100` display establishes the API score scale as `0..100`, but it does **not** establish inputs, weights or level thresholds. Those remain part of the versioned formula definition and require explicit product sign-off.

Formula governance is stored in `trust_score_formula_versions`. Definitions contain a subject, version, public methodology text, input contract, weight contract, level contract and definition hash. Draft definitions may be edited; after approval, their definition is immutable. Only one active formula may exist per subject, and active/retired definitions cannot be rolled backward. There is no active formula in seed data.

Historical results are append-only `trust_score_snapshots`. Each snapshot records the formula version, score, level, sanitized factors, `calculation_key`, source fingerprint and calculation timestamp. A correction creates another snapshot rather than mutating history. `calculation_key` uniqueness makes repeated calculation delivery idempotent, and every snapshot automatically creates an immutable `audit_logs` event.

The read contract is:

- `GET /api/v1/trust/chamas/:chamaId` — public aggregate Chama trust for public/application Chamas only.
- `GET /api/v1/trust/memberships/:membershipId` — authenticated owner-only current trust for one membership.
- `GET /api/v1/trust/memberships/:membershipId/history?limit=20` — authenticated owner-only score history, newest first.

Until an approved active formula exists, these endpoints return a neutral unavailable representation with `score: null`, `level: null`, `factors: []`, `calculatedAt: null`, `version: null` and `unavailableReason: "TRUST_SCORE_FORMULA_NOT_ACTIVATED"`. When a formula is active but that subject has not been calculated yet, the reason is `TRUST_SCORE_NOT_CALCULATED`.

Factor payloads are intentionally explanation-only (`code`, `label`, `effect`, `summary`). The trust service does not calculate from or expose raw member contribution amounts, balances, payment methods, phone details or account identifiers. Member trust/history is self-only. Public Chama factors must already be aggregate/sanitized before a snapshot can be recorded.

`TrustScoreService.recordSnapshot()` is the future calculation-job boundary. It refuses inactive formula versions and stores already-sanitized results; BE-32 does not invent a formula, weight set or score level thresholds. Activating the first real version therefore remains a **founder/product decision**, not an engineering default.

## Partner merchants and goal rewards (BE-33)

BE-33 adds the Phase 1 merchant/reward domain while keeping merchant commerce separate from Chama treasury accounting. `partner_merchants` stores merchant display/status data, `goal_merchant_partnerships` stores goal-specific offers and validity windows, and `member_merchant_rewards` stores one server-owned reward state per membership/partnership. None of these tables updates `chamas.pooled_amount`, and the merchant service does not create ledger entries.

The canonical migration seeds three deterministic **demo-only** active Washing Machine partners: HomePlus Appliances, SmartLiving Kenya and Appliance Hub. These names/offers are prototype records for integration testing, not claims of real commercial agreements. Their commercial terms are explicitly marked pending partner agreement.

Public/read contract:

- `GET /api/v1/goals/:identifier/merchants` — lists currently active merchants/partnerships for a goal. Expired, paused/ended partnerships and inactive/suspended merchants are excluded.
- `GET /api/v1/goals/:identifier/merchants?membership_id=<uuid>` — when accompanied by a valid bearer token, also returns that authenticated owner's server-stored reward state for the membership. The membership must be active and belong to a Chama with the requested canonical goal.

The merchant response exposes `locked`, `eligible`, `redeemed`, `expired` or `revoked` reward state. Missing reward rows are reported as `locked`; the client cannot submit a state value or grant itself eligibility. `MerchantRewardService.grantEligibility()` is an internal server/job boundary requiring an active membership, a live active partnership, matching goal identity and server evidence (`eligibility_source`, reference and fingerprint). `recordRedemption()` is also internal and only accepts an already `eligible` reward with server redemption evidence. No public mutation route is registered for either operation.

Offer activation/deactivation and reward state changes automatically write immutable `audit_logs` entries. Reward-state transitions are constrained at the database layer (`locked -> eligible/expired/revoked`, `eligible -> redeemed/expired/revoked`; redeemed/expired/revoked are terminal). A unique redemption reference prevents the same provider/merchant redemption from being applied twice.

The existing BE-30 `partnerMerchantCount` query now reads these tables directly, so the seeded Washing Machine goal reports exactly three active/current partner merchants while inactive or expired partnerships do not inflate the count.



## Commitment mechanism alignment (BE-34)

BE-34 aligns the Phase 1 join flow with the existing `commitment_deposits` and double-entry ledger architecture. The current UI/product materials consistently present a KSh 500 commitment, while the business-rules document still lists the governance decision **fixed platform-wide vs configurable per Chama** as unresolved. The backend therefore continues to read the immutable accepted Constitution version's `commitment_amount` (default KSh 500) instead of silently hard-coding a policy that has not been formally approved.

A commitment is created only after the join transaction has a concrete membership, a `commitment_pending` application, and recorded Constitution acceptance. The row stores and database-enforces the same `user_id`, `chama_id`, `membership_id`, `application_id`, and `chama_rule_id`, making the commitment traceable to one exact join and rule version.

Join gating:

- `application` visibility returns `application_pending`; no membership or commitment is created yet, so the frontend cannot report a successful join before Chair/Secretary approval.
- direct public/invite entry creates an application as `commitment_pending`, a membership as `pending`, and a commitment in `applied` when the accepted Constitution requires a deposit.
- only when `CommitmentService.confirmHoldFromProvider()` receives a server/provider-confirmed payment for the exact required amount does the application become `approved` and the membership become `active`.
- client input cannot mark a payment as successful. There is intentionally no public `pay-confirmed` route.

Owner-facing API:

- `GET /api/v1/memberships/:id/commitment` — returns the signed-in owner's commitment amount/state, membership/application state, accepted Constitution version, and linked ledger transaction IDs.
- `POST /api/v1/memberships/:id/commitment/refund-request` — allowed only after a server/rule-engine transition to `eligible_for_refund` and while no unresolved default exists. This requests a refund; it does not claim money moved.

Server-only financial boundaries:

- `confirmHoldFromProvider()` posts `commitment_hold`: debit `external_clearing`, credit `commitment_escrow`.
- `confirmRefundFromProvider()` posts `commitment_refund`: debit `commitment_escrow`, credit `external_clearing`.
- `forfeitFromRule()` posts `commitment_forfeiture`: debit `commitment_escrow`, credit `commitment_forfeiture`.

These journals are intentionally outside `chama_treasury`; none of them updates `chamas.pooled_amount`. Provider references are unique per provider, ledger references are immutable/idempotent, and a replay of the same confirmed hold/refund returns the already-committed result rather than duplicating value.

The commitment state machine is database-constrained to the currently safe path: `applied -> held -> at_risk/default/refund eligibility`, `default_triggered -> forfeited`, and `eligible_for_refund -> refund_requested -> refunded`. The historical enum still contains `partial_forfeit`, but BE-34 intentionally does not permit that transition until product/legal rules define how the non-forfeited remainder must be settled; this prevents value from being stranded in commitment escrow. State changes automatically write financial audit events containing the membership/application/rule linkage and the relevant ledger IDs/evidence references.

## Authorization regression suite (BE-35)

BE-35 locks the one-account/multi-Chama security model with both middleware-level and PostgreSQL-backed regression tests. Chama office authorization is always resolved against the requested Chama's current **active** `chama_members` row; client-selected active-Chama hints and stale role context are not authorization inputs.

Coverage includes:

- a Secretary in Chama A is denied Secretary-only capability in Chama B when their Chama B membership has another role;
- Treasurer and Chairperson memberships still satisfy ordinary Member self-service capability in their own Chama;
- the unique `(chama_id, user_id)` membership constraint prevents creating a second membership row to hold another office in the same Chama;
- suspended and exited memberships are excluded by the production PostgreSQL membership repository and therefore lose Chama-scoped privileges;
- role reassignment in PostgreSQL takes effect on the next authorization check, so stale client/token context cannot preserve an old Chama office;
- global platform roles derive only from `users.is_platform_admin`: a Chama Secretary/Chair/Treasurer is not a platform admin, while a platform admin does not need a Chama office to satisfy `/api/v1/admin` authorization.

`createPostgresChamaMembershipRepository()` exists as an injectable factory so the regression suite exercises the same SQL used by production middleware against an isolated test schema. The normal production middleware still uses the shared application pool.

## Clean database setup

Migrations create only the schema, reference goal catalog, and the platform administrator configured through `SUPER_ADMIN_*`. They do not create mock users, Chamas, memberships, contribution records, merchant offers, or prototype credentials. Create all operational data through the normal API flows.


## Frontend integration contract (BE-37)

The canonical workspace-aware frontend/API contract is maintained in `docs/M-Duara_Backend_Contract_BE37.md`. It documents exact request/response shapes for `/auth/me`, public Chama discovery/joining, goal catalog/metrics/matching, member commitment state, trust score, merchant rewards, and stable `error.code` handling.

BE-37 also makes centralized API failures machine-readable. The standard failure envelope now includes `error.code` in addition to the existing human-readable `message` and optional `details`. Chama-scoped middleware uses stable domain codes such as `CHAMA_SCOPE_REQUIRED`, `CHAMA_MEMBERSHIP_INACTIVE`, and `CHAMA_ROLE_FORBIDDEN`; join flow uses `PRIVATE_CHAMA_INVITE_REQUIRED`, `CONSTITUTION_NOT_ACCEPTED`, and `CONSTITUTION_VERSION_CONFLICT`. A valid join that still needs the commitment deposit remains a successful `outcome: commitment_required`, not an HTTP error.

## Founder-level financial and business blockers (BE-38)

The canonical open-decision register is `docs/M-Duara_Product_Decisions_Log.md`, section **BE-38 Founder-Level Financial & Business Decision Register** (`be38-open-v1`). PD-18 through PD-25 cover the unresolved join platform fee, commitment fixed-vs-configurable policy, refund SLA, same-Chama re-entry after default, loan-interest method, provider-fee bearer, licensed custody/regulatory arrangement, and SaaS subscription pricing/tier quotas.

These records are intentionally `OPEN`; the backend must not turn prototype numbers, recommended examples, or existing partial implementations into product approval. In particular, production lending pricing and real-money custody deployment remain release-blocked until PD-22 and PD-24 are approved. BE-34 continues to validate the commitment amount from the member's immutable accepted Constitution version (Phase 1/default KSh 500) rather than inventing a platform-wide rule, and commitment refunds preserve explicit provider-confirmed states without an invented SLA timer.


## Merry-go-round cycle scheduler (BE-09)

BE-09 uses explicit cycle, payout-turn, swap-request and provider-attempt records. It reuses the shared Chama treasury ledger and M-Pesa B2C boundary; a provider dispatch acknowledgement is never treated as a completed payout.

API contract:

- `POST /api/v1/chamas/:chamaId/cycles` — leadership creates one active cycle from the current active membership snapshot. `mode: "manual"` requires every active membership exactly once in `memberOrder`; `mode: "randomized"` uses a cryptographically sourced Fisher-Yates shuffle. `mode: "bidding"` fails closed with `MGR_BIDDING_POLICY_NOT_CONFIGURED` because no approved bidding/price-allocation rule exists in the product rules.
- `GET /api/v1/chamas/:chamaId/cycles/current` and `GET /api/v1/cycles/:cycleId` — active members read the queue-board model: past/current/future turns plus swap state.
- `POST /api/v1/cycles/:cycleId/swap-request` — the requester proposes swapping their unresolved turn with another active queued membership. Creating the request records the requester's acceptance.
- `PATCH /api/v1/cycles/:cycleId/swap-requests/:swapId` — only the target member can `accept` or `reject`; the requester may `cancel`. Positions and scheduled dates change only after target acceptance and are updated inside the cycle transaction.
- `POST /api/v1/cycles/:cycleId/disburse` — Chairperson/Treasurer only. It targets exactly `current_position`, verifies the recipient is still active, checks treasury availability, creates a durable provider attempt, and dispatches B2C outside the database transaction.
- `POST /api/v1/cycles/mpesa/b2c/result` and `/timeout` are verified provider callbacks. A successful ResultURL callback posts the member payout journal, marks the turn paid and increments `current_position` in one serializable transaction. The last confirmed turn completes the cycle. A timeout moves the turn to `disputed`; it does not auto-retry because provider outcome is uncertain. A later successful result can still settle that timed-out attempt.

Merry-go-round B2C uses `MPESA_MGR_B2C_RESULT_URL` and `MPESA_MGR_B2C_TIMEOUT_URL`, separate from BE-07 loan callback URLs. This prevents one product flow from consuming another flow's provider callback.

The canonical schema allows only one active merry-go-round cycle per Chama, one turn per active membership per cycle, one position per cycle, and at most one unresolved swap for a pair of turns. Provider attempts retain old ConversationIDs so a definitive failed attempt can be retried without losing replay/audit evidence.

## SaaS subscription and tier billing (BE-10)

BE-10 replaces the former generic CRUD exposure for `platform_subscriptions` and `subscription_payments` with a server-authoritative billing flow. Clients cannot choose a price, mark a payment paid, extend a billing period or directly change subscription status.

Canonical plan model:

- `subscription_plans` defines Free/Premium plan codes, monthly/annual billing frequency, price, maximum members, open/active-loan quota, monthly SMS quota and the `detailed_pdf_export` entitlement.
- Canonical codes are `free`, `premium_monthly` and `premium_annual`. Free has zero price. Premium price/limit fields intentionally remain `NULL` until **PD-25** is approved; prototype figures such as KSh 999, 50 members and 1,000 SMS are not production defaults.
- A Chama with no explicit `platform_subscriptions` row resolves to Free. The first paid checkout creates/uses the durable subscription row automatically.
- `GET /api/v1/subscriptions/plans` exposes the catalog with `priceConfigured` and `commercialLimitsConfigured` flags so clients can disable unresolved commercial options instead of inventing values.
- `GET /api/v1/subscriptions/chamas/:chamaId` returns the signed-in member's current plan, access mode, limits, entitlements and current member/open-loan/SMS usage.

Payment contract:

- `POST /api/v1/subscriptions/pay` accepts only `{ chamaId, planCode, phoneNumber }`. The backend loads the plan price and frequency from PostgreSQL. A Premium plan with no approved positive price fails closed with `SUBSCRIPTION_PRICE_NOT_CONFIGURED`.
- Only active Chairperson/Secretary/Treasurer memberships may initiate billing. At most one pending subscription checkout exists per Chama.
- Subscription STK requests use `MPESA_SUBSCRIPTION_CALLBACK_URL`, separate from contribution STK and B2C ResultURL endpoints. `GET /api/v1/subscriptions/payments/:checkoutId` provides membership-scoped polling.
- `POST /api/v1/subscriptions/mpesa/callback` is provider-facing and uses the same fail-closed callback IP/HMAC verification as contribution collection. Provider failure never upgrades the Chama.
- On verified success, the initiated payment amount/frequency snapshot is authoritative, the payment becomes `paid`, and the Chama subscription is activated/renewed. A monthly/annual period is extended from the current paid-through date when still active, otherwise from settlement time. The seven-day grace window begins exactly at `current_period_end`. Callback replay is idempotent.
- Each successful subscription receipt posts a balanced `platform_fee` journal: debit `external_clearing`, credit `platform_fee_revenue`. It never changes `chamas.pooled_amount`.

Entitlements and degradation:

- Free is always writable subject to configured plan limits. Paid Premium is `active` through `current_period_end`, `grace_period` for the following seven days, then `read_only` until a successful renewal. The access mode is derived on each authorization check, so worker downtime cannot postpone the read-only boundary.
- Unsafe methods passing through Chama membership/role middleware are blocked in `read_only`; generic config-driven Chama mutations use the same guard. Public/direct onboarding, application approval, loan origination and merry-go-round writes also call the service-level guard. Provider callbacks remain allowed so already-initiated money movement can reconcile.
- Member onboarding uses the minimum of the Chama target, the platform hard cap and `subscription_plans.max_members` when configured. Reaching the tier cap returns `SUBSCRIPTION_MEMBER_LIMIT_REACHED`.
- Loan origination applies `max_active_loans` when configured and returns `SUBSCRIPTION_LOAN_LIMIT_REACHED` after the quota is exhausted. The quota conservatively counts non-terminal/open loans, preventing a Chama from bypassing a tier by opening many simultaneous pending loans.
- SMS reminders use transactional monthly quota reservations in `subscription_sms_usage`; concurrent workers cannot race past a configured quota. A provider failure releases the reserved slot, while a provider-accepted send keeps it.
- `requireSubscriptionFeature('detailed_pdf_export')` is the BE-10 middleware boundary for BE-18 reports. Free/read-only access is denied; active/grace Premium is allowed when the plan grants the feature.

PD-25 is the only BE-10 commercial configuration blocker: exact production Free/Premium member, loan and SMS limits plus Premium monthly/annual prices still require founder/finance approval. Once approved, populating those plan rows activates the already-tested enforcement paths without changing API semantics.

## M-Pesa STK contribution collection (BE-05)

BE-05 completes the contribution-collection runtime around the existing `payment_provider_logs` and double-entry ledger architecture.

Endpoints:

- `POST /api/v1/payments/stk-push` — authenticated. Body: `{ contributionId, amount, phoneNumber }`. The contribution must belong to the signed-in user's active Chama membership and the amount cannot exceed its remaining unpaid balance.
- `GET /api/v1/payments/status/:checkoutId` — authenticated, owner-scoped payment polling.
- `POST /api/v1/payments/mpesa/callback` — public provider callback. `/api/v1/payments/callback` remains a compatibility alias for the original tracker wording.

Successful callbacks are idempotent. One confirmed M-Pesa receipt creates at most one `contribution_payments` row and one `ledger_transactions` deposit. The paired ledger entries and `chamas.pooled_amount` update execute in the same serializable database transaction; contribution status is then derived from confirmed payment totals. Failed callbacks never mutate pooled funds.

Callback verification is fail-closed in production: configure `MPESA_CALLBACK_ALLOWED_IPS`, `MPESA_WEBHOOK_HMAC_SECRET`, or both. When an HMAC secret is configured, the reverse proxy/provider adapter must send `x-mduara-signature` (or `x-callback-signature`) as a SHA-256 HMAC of the JSON callback payload. Rejected callbacks are written to the security audit log. Direct Safaricom integration should normally use the source-IP allowlist unless an authenticated proxy is adding the HMAC.

`MPESA_STK_ENABLED=false` is the safe default. BE-05 deliberately does not deduct, gross-up, or allocate provider transaction fees; PD-23 must be approved before fee-bearing behavior is introduced.


## Audit logging, observability and Chama analytics (BE-11)

BE-11 reuses the canonical immutable `audit_logs` table. Rows capture category/action, actor, Chama/entity, IP address, user agent, structured payload and timestamp; the database rejects UPDATE/DELETE on audit history. Administrative membership role/status edits write their audit row in the same transaction as the state change, including before/after values and request context. PIN lockouts also record request IP/user-agent and lockout evidence. Financial modules continue to write immutable financial audit events alongside their ledger state transitions.

Structured application logs remain newline-delimited JSON with `debug`, `info`, `warn` and `error` levels and built-in redaction for credential/token fields. This is the current lightweight structured logger contract; a later deployment may swap the transport for Pino/Winston without changing call sites.

Analytics endpoint:

- `GET /api/v1/analytics/chama/:id?range=1m|3m|6m|1y|all` requires an active Chama membership.
- Responses are pre-bucketed for charts: capital growth (`netChange`, running `balance`), contribution compliance (`obligations`, `compliant`, `ratePct`), and loan repayment (`totalDue`, `repaid`, `ratioPct`).
- Bucket size is day for 1M, week for 3M, and month for 6M/1Y/ALL. Raw payment, ledger or event streams are never exposed through this endpoint.

Regression coverage is in `src/tests/integration/observability-analytics.test.ts`; it proves transactional role-change auditing, audit immutability and chart-ready bucketed analytics. Integration execution still requires `TEST_DATABASE_URL`.

## Chama discovery, matching and marketplace compatibility (BE-12)

BE-12 discovery is implemented by the later Phase 1 goal marketplace contract rather than a competing discovery stack.

- Canonical public discovery remains `GET /api/v1/chamas/public` and `GET /api/v1/chamas/public/:id`; `GET /api/v1/chamas` is also exposed as a backward-compatible list alias for the original BE-12 tracker.
- Canonical goal-based matching remains `POST /api/v1/goals/matches`; `POST /api/v1/chamas/match` is a backward-compatible alias using the same validation/controller/service.
- Public list/detail responses include `recruitmentStatus: OPEN | ALMOST_FULL | CLOSED`. A Chama is closed when its lifecycle is no longer joinable, its recruitment deadline has passed, or configured capacity is exhausted. Finite-capacity Chamas become `ALMOST_FULL` at 90% occupancy.
- Matching continues to hard-exclude full/non-joinable Chamas. Private Chamas require a live applicant-specific invitation; no public listing alias exposes private Chamas.
- The authenticated `GET /api/v1/chamas/:id` route remains intentionally separate from public pre-join detail to preserve the newer BE-37 contract and avoid leaking member-only Chama data.

`src/tests/integration/public-chama.test.ts` covers the public-safe detail contract and now also regression-tests recruitment-status derivation. PostgreSQL-backed cases require `TEST_DATABASE_URL`.

## Commitment deposit and member contribution lifecycle (BE-13)

The original BE-13 client payment wording is implemented through the stricter BE-34 provider-authoritative commitment boundary. A client cannot mark a commitment payment or refund as financially complete by posting a success claim.

- `GET /api/v1/memberships/:id/commitment` returns the signed-in member's commitment state and traceability metadata.
- `GET /api/v1/memberships/:id/contributions` returns that membership owner's scheduled contribution obligations with confirmed paid/remaining amounts plus aggregate scheduled target, paid and remaining values. Pending/failed/reversed payment attempts never inflate progress.
- `POST /api/v1/memberships/:id/commitment/refund-request` records refund intent only when the commitment is eligible and no unresolved default blocks it. Provider/B2C confirmation is still required before the state becomes `refunded` and before the escrow journal changes.
- Commitment hold, refund and forfeiture journals stay outside `chamas.pooled_amount`; commitment custody and ordinary Chama savings remain separate accounting domains.
- BE-08 drives `held -> at_risk -> default_triggered`. Full forfeiture is available only from the internal rules-engine boundary. Partial forfeiture remains fail-closed until its remainder/refund policy is approved; same-Chama re-entry after default remains a product decision rather than an automatic reset.

`src/tests/integration/commitment-alignment.test.ts` also verifies the owner-scoped contribution progress contract. PostgreSQL-backed cases require `TEST_DATABASE_URL`.


## Recruitment, applications and private invitations (BE-14)

BE-14 uses the existing Chama/application/membership model and keeps all final admission checks server-side.

- `POST /api/v1/chamas/:id/apply` creates a pending application for `application` visibility Chamas after current-Constitution acceptance.
- Leadership reviews applications through the Chama-scoped `PATCH /api/v1/chamas/:id/applications/:applicationId` route. Compatibility routes `PATCH /api/v1/applications/:applicationId/approve` and `/reject` are also available; the service itself re-checks that the actor is an active Chairperson or Secretary.
- `POST /api/v1/chamas/:id/invite` remains supported and `POST /api/v1/chamas/:id/invites` is the BE-14 plural alias. Shareable links are limited to Private Chamas, grant base membership only, default to seven-day expiry, and support a bounded `max_uses` value.
- Invitation links contain a cryptographically random token. Only its SHA-256 hash is persisted in `chama_invitations.invite_token_hash`; the raw token is returned only when the invitation is created. The join flow accepts `invitation_token` while retaining `invitation_id` for backward compatibility.
- Private Chamas reject joins without a live, unexhausted invitation. Multi-use tokens remain reusable until `max_uses` is reached, then transition to `accepted` and cannot be consumed again.
- Recruitment deadlines are enforced against the database date. A passed deadline blocks new applications, direct joins, invitations and approval of pending applications.
- When a membership consumes the final configured slot, the Chama row is already locked with `FOR UPDATE`; `recruitment_closed_at` is then set in the same transaction as membership creation. This prevents overbooking and prevents recruitment from silently reopening if someone later exits.
- Public discovery and goal matching treat `recruitment_closed_at`, an expired deadline, or exhausted capacity as closed recruitment.

Regression coverage is included in `src/tests/integration/chama-management.test.ts`.

## Chama Constitution, templates and digital acceptance (BE-15)

BE-15 uses the canonical `chama_rules` and `membership_constitution_acceptances` tables. It does not introduce a second rules store. Constitution versions remain the machine-readable rule snapshots consumed by joining, commitments, penalties and later governance flows.

Constitution contract:

- `GET /api/v1/chamas/constitution/templates` returns the standard structural templates: `savings`, `goal_based`, `merry_go_round`, `investment`, plus `custom`. Templates deliberately avoid inventing unresolved founder-level commercial policy. Known governance defaults such as member-vote dissolution and provider-instructed settlement context are represented structurally.
- `POST /api/v1/chamas` accepts optional `constitution_template` and `constitution` setup overrides. Version 1 is created atomically with the Chama and founder membership. Contribution amount/frequency overrides are synchronized to both the Chama and its Constitution in the same transaction.
- `POST /api/v1/chamas/:id/rules` is Chairperson-only setup configuration. It may update v1 only while that version has never been accepted by a membership or applicant and no later rule version exists. After any acceptance, the version is immutable and the endpoint returns `CONSTITUTION_SETUP_LOCKED`.
- `GET /api/v1/chamas/:id/constitution` requires active Chama membership and returns the current version, the caller's acceptance state, and full version history including creator, timestamps, amendment summary, acceptance count and linked amendment poll where present.
- `POST /api/v1/memberships/:id/accept-constitution` is owner-scoped and accepts the current active version only. Each `(membership, rule version)` is recorded once with timestamp, IP and user-agent. Replays return the original acceptance evidence rather than replacing it. A future active version therefore requires a new acceptance row while preserving prior-version history.
- Join/application acceptance now captures IP and user-agent at the moment the applicant accepts the current rule version. For application-visibility Chamas that evidence is held on the application and transferred unchanged into `membership_constitution_acceptances` when leadership approves the applicant.

Amendment boundary:

- `POST /api/v1/chamas/:id/rules/amend` is the Chairperson-only Constitution amendment boundary and is fully integrated with BE-17 governance.
- It verifies that the supplied poll belongs to the Chama, is a `rule_amendment` decision, targets the current active rule version, is closed, met quorum, met the snapshotted majority threshold, and has not already been acted.
- The amendment poll freezes the validated Constitution `changes` and `amendment_summary` in its `decision_payload`. The amendment request must match that frozen payload exactly; no result is inferred from display labels such as `Approve`.
- A successful amendment supersedes the previous active rule, creates the next immutable Constitution version, marks the poll action as applied in the same transaction, writes the governance audit trail, and dispatches the `constitution_amended` notification after commit.
- Replays or stale/failed governance outcomes are rejected without changing rule state.

`chama_rules` now records `template_code`, `amendment_summary`, optional `amendment_poll_id`, and `updated_at`. The application table preserves Constitution-acceptance IP/user-agent before membership creation. The integration regression coverage is in `src/tests/integration/chama-management.test.ts`. PostgreSQL execution still requires `TEST_DATABASE_URL`.

## Notification service, templates and channel preferences (BE-16)

BE-16 now uses the canonical `notifications` and `notification_preferences` tables rather than introducing a second messaging store. Each requested channel receives its own durable delivery row with status, provider reference (when available), payload, sent/read/failed timestamps and a failure reason. Optional `dedupe_key` values are unique per user/event/channel so an internal retry can be idempotent.

Registered event templates:

- `contribution_due`
- `contribution_received`
- `chama_almost_full`
- `application_approved`
- `missed_contribution`
- `commitment_refund_ready`
- `goal_completed`
- `constitution_amended`

API surface:

- `POST /api/v1/notifications/dispatch` — internal service-to-service dispatch. Requires `x-mduara-internal-secret` matching `NOTIFICATION_DISPATCH_SECRET`.
- `GET /api/v1/users/:id/notifications` — self-only in-app feed with pagination and `unread_only=true|false`.
- `PATCH /api/v1/users/:id/notifications/:notificationId` with `{ "read": true|false }` — mark an in-app notification read/unread.
- `GET /api/v1/users/:id/notification-preferences` — current per-channel preferences.
- `PATCH /api/v1/users/:id/notification-preferences` — update any of `inAppEnabled`, `smsEnabled`, `emailEnabled`, `pushEnabled`.
- `/api/v1/users/me/...` aliases are provided for the same user-facing endpoints.

Channel behavior:

- in-app is persisted and immediately marked sent; read state is independent.
- SMS reuses the existing SMS provider and, for Chama-scoped messages, the BE-10 monthly SMS quota reservation/release mechanism.
- email reuses the existing console/SMTP provider.
- push supports a console adapter for development and a webhook adapter (`PUSH_PROVIDER=webhook`) for a production push gateway.
- disabled preferences or missing contact destinations are recorded as `cancelled`, not silently discarded.
- provider exceptions are caught per channel and persisted as `failed`; they do not roll back the business operation that triggered the notification.

Application approval is the first business flow wired directly into the unified service. It dispatches `application_approved` only after the application review transaction has committed, with a deterministic dedupe key derived from the application id.

`src/tests/integration/notification-lifecycle.test.ts` covers provider-failure isolation, durable failure reasons, dedupe behavior, read/unread state and preference-based cancellation. Like the other PostgreSQL integration suites, it requires `TEST_DATABASE_URL` to execute.


## Voting and decision-making engine (BE-17)

BE-17 uses the canonical `polls`, `poll_options`, `poll_eligible_voters`, and `poll_votes` tables. A poll snapshots the active Constitution rule, quorum/majority thresholds, and the exact active membership electorate when it is created.

Routes:

- `POST /api/v1/chamas/:id/polls` — Chairperson creates a poll with stable option codes. Governance/action polls name an explicit `actionOptionCode`; no outcome is inferred from display labels.
- `GET /api/v1/chamas/:id/polls` — active members list the Chama's polls.
- `POST /api/v1/polls/:pollId/vote` — an eligible active member casts exactly one immutable vote.
- `GET /api/v1/polls/:pollId/results` — returns tallies, turnout, quorum, majority, close reason, and whether a domain action is currently actionable.
- `POST /api/v1/polls/:pollId/act` — applies supported domain outcomes. Member-removal is applied atomically and audit-logged; Constitution amendments are intentionally applied through `POST /api/v1/chamas/:id/rules/amend` so the exact approved rule payload can be versioned.

A poll closes only when its configured deadline is reached or every snapshotted eligible voter has voted. There is no manual early-close path. `poll_votes` also has a PostgreSQL trigger that rejects `UPDATE` and `DELETE`, so cast votes are immutable below the API layer.

Rule-amendment polls freeze `amendment_summary` and the validated Constitution `changes` in `decision_payload`. The Constitution amendment endpoint requires the poll to be closed, quorum-satisfied, majority-approved, unacted, and targeted at the currently active rule. The requested changes must match that frozen payload exactly. Activation supersedes the previous version, creates the new active version, marks the poll acted, and emits an in-app `constitution_amended` notification after commit.

Member-removal polls freeze the target membership ID. A passed outcome can be applied once through `/polls/:pollId/act`; the final active Chairperson cannot be removed. Dissolution and payout-order dispute execution deliberately fail closed until their teardown/settlement policies are approved, rather than inventing financial/lifecycle semantics.

Regression coverage is in `src/tests/integration/voting-lifecycle.test.ts`, including no-early-close behavior, deadline/full-turnout closing, duplicate-vote rejection, database-level vote immutability, governed member removal, and Constitution amendment activation.

## Reports and document export (BE-18)

BE-18 uses the append-only double-entry ledger as the only financial source of truth. JSON statements are captured under a PostgreSQL `REPEATABLE READ READ ONLY` snapshot, and queued PDF/Excel exports use the same snapshot path inside the background worker. Rendering happens only after the read transaction is committed, so document generation never holds ledger locks while bytes are being produced.

Endpoints:

- `GET /api/v1/chamas/:id/reports/financial-statement?format=json|pdf|excel&from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/v1/members/:id/statement?format=json|pdf|excel&from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/v1/reports/:jobId` — metadata-only job polling.
- `GET /api/v1/reports/:jobId/download` — returns `202` while queued/processing, the binary when ready, `422` on final generation failure, or `410` after expiry.

Authorization and billing:

- Chama financial statements require an active Chairperson, Treasurer or Secretary membership.
- A member statement is available only to that membership owner or active leadership of the same Chama.
- Detailed PDF requests are gated through the BE-10 `detailed_pdf_export` entitlement in middleware and re-checked in the report service as defense in depth. Excel-compatible SpreadsheetML (`.xls`) and JSON remain separate formats.
- Report job status/download is requester-only except for platform administrators.

Queue/reliability contract:

- `report_jobs` uses lease tokens plus `FOR UPDATE SKIP LOCKED`, so multiple workers can process the queue without duplicate claims.
- Abandoned `processing` leases are recoverable; failures retry with exponential backoff and eventually become `failed`.
- Completed output is stored with SHA-256, MIME type, byte size, reconciliation metadata and a 7-day expiry. The database constrains ready rows so binary/hash/size/snapshot metadata cannot disagree.
- Member-scoped jobs have a composite membership/Chama foreign key, preventing a report job from pointing at a membership belonging to another Chama.
- Chama snapshots must balance exactly (`totalDebits === totalCredits`) before export. A mismatch fails closed rather than publishing a financial statement.
- Request and terminal generation events are written to `audit_logs`.

Worker integration:

- The existing background scheduler now supports an optional `reports` task and runs report recovery immediately at worker startup as well as every minute.
- Existing financial/reminder scheduler callers remain source-compatible because the reports callback is optional.
- The worker fails fast at startup if `report_jobs` is missing from the deployed schema.

Regression coverage is in `src/tests/integration/report-lifecycle.test.ts`. It covers ledger reconciliation, statement privacy, free-plan PDF denial, queued Excel/PDF generation, integrity hashes, audit events and expiry cleanup. As with the other database suites, it requires `TEST_DATABASE_URL` before it can execute.

### Migration entry point integrity

The root `migrations/001_initial_schema.sql` remains the single canonical schema source. `migrations/001_initial_schema.js` is the node-pg-migrate wrapper used by `npm run db:migrate` and the integration-test migration helper; both intentionally ignore raw `.sql` migration discovery so the schema cannot be executed twice. The initial migration is intentionally irreversible through generic `db:rollback` because automatically dropping the Phase 1 schema would be destructive; disposable environment resets must use an explicit reset workflow.

## Support and dispute ticketing (BE-19)

BE-19 replaces generic CRUD exposure for support tickets with an explicit domain workflow. Ticket evidence, routing, authorization, status transitions and audit behavior are enforced by the service and backed by database constraints/triggers.

Endpoints:

- `POST /api/v1/support/tickets` — open a `payment_issue`, `account_issue`, `refund_issue`, or `chama_issue`.
- `GET /api/v1/support/tickets/:ticketId` — retrieve by internal UUID or public `MD-XXXXXX` code when the caller is authorized.
- `PATCH /api/v1/support/tickets/:ticketId` — Chair/Super Admin management: status, assignment and resolution notes.
- `GET /api/v1/users/:id/tickets` — ticket history, visible only to the user themself or an active platform administrator.
- `/api/v1/support-tickets...` remains a compatibility alias for create/get/update; `/support/tickets...` is canonical.

Evidence and routing:

- public ticket codes are uppercase `MD-XXXXXX`; the service retries the complete creation transaction on the extremely rare code collision while UUID remains the internal primary key.
- `payment_issue` requires a payment reference and snapshots the authenticated user's matching M-Pesa provider record (merchant/checkout IDs, amount/currency, provider status/result, receipt and verified timestamps) without copying raw callback payloads or the payment phone number into the ticket response. These tickets are platform-admin scoped.
- `refund_issue` requires a commitment-deposit ID owned by the caller and snapshots the deposit/refund provider state; these tickets are platform-admin scoped.
- `chama_issue` requires membership history in that Chama, snapshots the membership context and routes initially to an active Chairperson.
- `account_issue` snapshots only minimal account state and routes to platform support.
- identity/evidence fields, including `routing_target` and `context_snapshot`, are immutable below the API layer once the ticket is created.

Lifecycle and authorization:

- explicit transitions are enforced (`open -> in_progress|escalated|resolved`, `in_progress -> escalated|resolved`, `escalated -> in_progress|resolved`, `resolved -> closed|in_progress`, `closed -> in_progress`).
- `resolved`/`closed` states require non-empty resolution notes; reopening clears the resolution actor/timestamp while retaining the historical notes and audit trail.
- Chama Chairpersons can manage only Chama-routed tickets. They cannot inspect or reassign platform-routed payment/refund/account evidence merely because a related transaction has a Chama ID.
- escalating a Chama ticket atomically hands assignment to an active platform administrator when one exists; while escalated, Chair-side mutation is blocked.
- platform administrators may manage all tickets; Chama tickets may be handed back to an active Chair, but platform-only tickets cannot be assigned to a Chair.
- every status transition and assignment change writes an immutable `audit_logs` event in the same transaction as the ticket update.

`src/tests/integration/support-lifecycle.test.ts` covers M-Pesa evidence attachment, privacy, Chair/platform routing, escalation hand-off, transition enforcement, status audit rows, immutable evidence context and self/admin-only history. It requires `TEST_DATABASE_URL` to execute.

## Meetings, RSVP, attendance and reminder delivery (BE-20)

BE-20 replaces the previous generic meeting CRUD surface with a dedicated meeting domain:

- `POST /api/v1/chamas/:id/meetings` — Chairperson/Secretary schedules a future meeting with ISO-8601 date/time, physical location and/or meeting URL, agenda, and optional reminder time. The default reminder is 24 hours before the meeting.
- `GET /api/v1/chamas/:id/meetings` — active members list meetings with their own RSVP/attendance state plus privacy-safe aggregate counts.
- `POST /api/v1/meetings/:meetingId/rsvp` — an active member records or changes their own `going`, `maybe`, or `declined` response before the meeting starts.
- `POST /api/v1/meetings/:meetingId/attendance` — Chairperson/Secretary records per-member attendance only after the meeting has started.
- `GET /api/v1/chamas/:id/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD` — Chairperson/Secretary queries attendance history over a bounded date range.

Database constraints bind RSVP and attendance rows to both the meeting and membership Chama, preventing cross-Chama data corruption even from direct SQL. The background worker leases due meeting reminders, retries orchestration failures with backoff, and dispatches the BE-16 `meeting_reminder` template with a deterministic dedupe key. Reminder delivery state is persisted on the meeting so BE-21 system-health can surface terminal failures later.

Integration coverage lives in `src/tests/integration/meeting-lifecycle.test.ts`. It covers authorization, self-only RSVP, cross-Chama foreign-key rejection, attendance timing, date-range history, retry behavior and reminder deduplication.

## Platform administration, moderation and operational health (BE-21)

BE-21 is a dedicated platform-operations domain. `/api/v1/admin/*` remains protected by the global `SUPER_ADMIN` identity boundary in `app.ts`, and the admin router repeats that role check as defense in depth. Chama office roles never grant platform administration.

Every request that enters the admin router first writes an immutable `platform_admin_access` security audit event containing actor, method, path, IP, user-agent and query **key names only**. Query values are deliberately not copied into access-audit payloads. If this audit write fails, the admin request fails closed.

Read APIs:

- `GET /api/v1/admin/overview` — live user/Chama/application/support counts plus confirmed payment volume for the current Nairobi business day.
- `GET /api/v1/admin/revenue?range=1m|3m|6m|1y|all` — time-bucketed platform revenue from the canonical `platform_fee_revenue` ledger account. Subscription revenue is separated using the immutable ledger transaction metadata written by BE-10; provider/payment tables are not independently summed as accounting revenue.
- `GET /api/v1/admin/users` — paginated/searchable identity status, safe active-Chama count and office contexts.
- `GET /api/v1/admin/search?q=...` — bounded platform search across users, Chamas, provider payments and support tickets.
- `GET /api/v1/admin/users/:userId` — complete operational user view: memberships, recent tickets/payments and related audit events.
- `GET /api/v1/admin/chamas` — paginated/searchable platform metadata and active-member counts. Pooled balances and member financial details are intentionally omitted.
- `GET /api/v1/admin/chamas/:chamaId` — privileged Chama control view with members, leadership, Constitution versions, applications, loans and support cases.
- `GET /api/v1/admin/payments` — read-only provider operational state without phone numbers or raw callback/request payloads.
- `GET /api/v1/admin/payments/:paymentId` — evidence-preserving provider, ledger, reconciliation and audit trace for one payment.
- `GET /api/v1/admin/refunds` and `/defaults` — privacy-reduced commitment lifecycle oversight; monetary amounts are intentionally omitted.
- `GET /api/v1/admin/applications` — Chama application oversight. The response declares the workflow Chama-governed; platform administration does not bypass Chair/Secretary admission rules.
- `GET /api/v1/admin/loans` — platform-wide loan and guarantor-coverage oversight without bypassing the loan approval state machine.
- `GET /api/v1/admin/tickets` (`/complaints` alias) and `GET /tickets/:ticketId` — support queue and evidence/comment history.
- `GET /api/v1/admin/notifications` — paginated delivery history across all supported channels.
- `GET /api/v1/admin/administrators` — active platform-administrator directory and live session counts; grants remain outside generic moderation.
- `GET /api/v1/admin/suspicious-activity` — transparent operational heuristics for rapid joins, repeated failed payments and unusual refund frequency. Rules and windows are returned with the response, and signals are explicitly not fraud determinations.
- `GET /api/v1/admin/system-health` — scheduler run health, report/reminder queues, meeting reminder failures, notification delivery failures, stale provider payments and latest ledger reconciliation state.
- `GET /api/v1/admin/audit-logs` — paginated immutable audit trail.

Safe moderation:

- `PATCH /api/v1/admin/users/:userId/status` accepts `suspend`, `reactivate`, or soft `delete` with a mandatory reason.
- `POST /api/v1/admin/chamas/:chamaId/members` adds an existing account to one Chama with a scoped role, onboarding state and mandatory administrative reason.
- `PATCH /api/v1/admin/chamas/:chamaId/members/:userId/role` changes exactly one Chama-scoped role with old/new role and reason captured in the immutable audit trail.
- `PATCH /api/v1/admin/tickets/:ticketId` reuses the BE-19 assignment/status/resolution state machine; `POST /tickets/:ticketId/comments` adds an evidence-linked note (internal by default).
- `POST /api/v1/admin/broadcasts` queues an audited broadcast to active users, platform administrators or the active members of one Chama. Audience scope, channels, message and reason are validated before any notification rows are written.
- suspension and deletion increment `session_version`, immediately invalidating outstanding sessions; reactivation also increments it so old credentials cannot silently become valid again.
- only previously active users can be suspended and only suspended users can be reactivated through this endpoint.
- an administrator cannot moderate their own account, and platform-admin accounts cannot be changed by this generic moderation path. Admin hierarchy/peer-admin governance requires a separately approved policy.
- every state change is written atomically with a `platform_admin_user_status_changed` moderation audit event.

Money/governance mutation boundaries are deliberately not duplicated in the admin service. Provider-confirmed payment/refund state, contribution defaults, Chama admission and Chama lifecycle transitions remain owned by their existing audited domain workflows. BE-21 provides oversight rather than unsafe `mark paid`, `force refund`, `approve application`, or arbitrary Chama-status shortcuts.

### Background scheduler telemetry

`background_job_runs` persists execution state for `financial`, `reminders`, `reports`, and `meetings`. The production worker records `running -> succeeded|failed`, duration, result metadata and sanitized failure reasons. A telemetry-finalization failure after domain work succeeds is logged but never causes successful financial/notification work to be replayed. The worker fails fast at startup if the telemetry table is missing.

Regression coverage is in `src/tests/integration/admin-lifecycle.test.ts`, including live overview figures, ledger-based revenue, account session revocation, self/peer-admin protection, Chama-financial privacy, successful/failed scheduler telemetry, and query-value-safe admin access auditing. PostgreSQL execution requires `TEST_DATABASE_URL`.


## Private media uploads, scanning and signed delivery (BE-22)

BE-22 adds a quarantine-first media pipeline. Application records never store public bucket URLs and the API never exposes object-listing capability.

- `POST /api/v1/uploads` creates an authenticated upload intent for `profile_avatar`, `chama_logo`, or `support_ticket_attachment`, validates purpose/MIME/size, authorizes the target scope, and returns a short-lived S3-compatible SigV4 PUT URL.
- `POST /api/v1/uploads/:id/complete` HEAD-verifies the private object against the declared byte length and MIME metadata, then moves it to `scan_pending`. Completion alone never makes a file downloadable.
- `POST /api/v1/uploads/scanner/claim` is internal scanner polling authenticated with `x-mduara-scan-secret`. Claims use PostgreSQL `FOR UPDATE SKIP LOCKED`, bounded attempts and five-minute leases so multiple scanner workers cannot process the same upload concurrently.
- `POST /api/v1/uploads/:id/scan-result` accepts the leased scanner verdict. A clean verdict must include SHA-256 and detected MIME type. Infected content is never linked and is deleted from storage best-effort; scanner failures retry and eventually become terminal `scan_failed`.
- Only `clean` uploads can receive a signed GET URL through `GET /api/v1/uploads/:id/download` or the stable `GET /api/v1/uploads/:id/content` redirect. Download URLs are short-lived and object keys are never enumerable through the API.
- Profile avatars and Chama logos are linked atomically only after a clean scan. Previous clean assets are retired. Clients can no longer set arbitrary `avatarUrl`/`logo_url` values through profile or Chama update payloads.
- Support-ticket attachments are private to the ticket access boundary. `GET /api/v1/support/tickets/:id` includes only clean/scanned attachments, each represented by an API content path rather than a bucket URL.
- The default storage adapter implements S3-compatible SigV4 signing using Node crypto, so no additional cloud SDK is required. `OBJECT_STORAGE_ENABLED=false` keeps uploads explicitly disabled in environments that have not configured private storage and the malware scanner.

Storage/scanner variables are documented in `.env.example`. The private bucket must block public access; malware scanning is fail-closed because `initiated`, `scan_pending`, `scan_failed`, `infected`, and `rejected` records cannot be served.


## Member commitment status and privacy-safe member list (BE-23)

BE-23 uses BE-08's already-assessed contribution/default state for a deliberately simple operational status. It does not activate or invent a numeric credit/trust formula; the governed BE-32 trust-score domain remains separate.

- `chama_members.commitment_status` is one of `ON_TRACK`, `MISSED_1`, `MISSED_2`, or `DEFAULT_TRIGGERED` and records `commitment_status_updated_at`.
- The financial scan calls `refreshMemberCommitmentStatuses()` after penalty/interest processing, so recalculation runs on exactly the same midnight/recovery cadence as BE-08. The derivation reads only assessed consecutive-miss counts, membership default state and commitment default/forfeiture state.
- `GET /api/v1/chamas/:id/members` now returns membership identity, role/status, display name/avatar, verification badge, and commitment status. It no longer returns member email addresses or phone numbers, and it never returns contribution amounts, balances, payment methods, provider references or raw trust factors.
- Numeric trust scores/history remain owner-scoped through the BE-32 trust APIs and require an explicitly activated formula version; BE-23 does not silently turn the simple operational status into a credit score.

Regression coverage in `src/tests/integration/member-commitment-status.test.ts` verifies status derivation, same-scan refresh and the member-list privacy projection. PostgreSQL execution requires `TEST_DATABASE_URL`.
