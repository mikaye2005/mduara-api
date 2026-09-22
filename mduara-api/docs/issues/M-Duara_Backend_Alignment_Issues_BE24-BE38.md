# M-Duara Backend — Alignment Issues for New Frontend/Product Decisions (BE-24 → BE-38)
This tracker extends the existing backend plan and is grounded in the current `mduara-api` schema/API direction. It does not replace the initial schema; where schema changes are required before deployment, they must be reflected in the project's authoritative `001_initial_schema.sql` as requested.

Key current facts considered:
- `users.is_platform_admin` already exists and should remain platform-scoped.
- `chama_members` already enforces one row per `(chama_id, user_id)`.
- `chama_members.role` currently stores one `member_role`.
- `chamas.goal_code` exists, but there is no normalized goal catalog.
- The current schema has commitment/ledger structures, but no trust-score or merchant-partnership domain tables.

## Issue Summary
- **BE-24 — Finalize Authentication Credential Contract — Phone + PIN vs Password** (Critical)
- **BE-25 — Membership Role Semantics — One Membership, Base Member + At Most One Official Office** (Critical)
- **BE-26 — Session Context API — Return All Chama Memberships and Chama-Scoped Roles** (Critical)
- **BE-27 — Multi-Chama Member Summary API** (High)
- **BE-28 — Public Chama Discovery, Detail and Application API** (Critical)
- **BE-29 — Goal Catalog Schema & API for Phase 1 Mbogi Saving** (Critical)
- **BE-30 — Goal Marketplace Aggregate Metrics** (High)
- **BE-31 — Goal-to-Chama Matching Engine v2** (Critical)
- **BE-32 — Trust Score Domain Model, Calculation Contract and History** (High)
- **BE-33 — Partner Merchant & Goal Reward Data Model** (High)
- **BE-34 — Commitment Mechanism Alignment for Goal-Based Joining** (Critical)
- **BE-35 — Authorization Regression Suite for Chama-Scoped Offices and Platform Admin** (Critical)
- **BE-36 — Deterministic Development Seed Data for Multi-Chama and Goal-Marketplace Integration** (Medium)
- **BE-37 — Backend Contract Documentation for Active Chama / Workspace-Aware Frontend** (High)
- **BE-38 — Resolve Remaining Founder-Level Financial & Business Rule Blockers** (Critical)

---
# BE-24: Finalize Authentication Credential Contract — Phone + PIN vs Password

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** Architecture / Auth  
**Priority:** Critical

## Description
Resolve the mismatch between the current schema/API, which stores a required password_hash plus optional pin_hash, and the frontend product flow, which specifies phone + PIN login and PIN recovery. Do not implement two competing primary credential models.

## Tasks
- [ ] Choose and document the canonical primary login credential model.
- [ ] If phone + PIN is canonical, define registration PIN creation, hashing, lockout, reset and migration rules for password_hash requirements.
- [ ] If password remains primary, revise frontend contract and define what PIN protects separately.
- [ ] Define rate limits, failed-attempt lockout, audit events and secure recovery.
- [ ] Update auth validation, routes, tests and README contract after decision.

## Acceptance Criteria
- [ ] One unambiguous login contract exists across schema, API and frontend.
- [ ] PIN/password hashes are never returned by any endpoint.
- [ ] Recovery cannot be used for account enumeration.
- [ ] Integration tests cover successful, failed, locked and recovered authentication.

## Suggested labels
priority: critical

---
# BE-25: Membership Role Semantics — One Membership, Base Member + At Most One Official Office

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** Schema / Authorization  
**Priority:** Critical

## Description
Align the membership model with the confirmed rule: every Chama participant is a member; a membership may additionally hold at most one official office (chairperson, secretary or treasurer). One person can hold different offices in different Chamas, but never two official offices in the same Chama.

## Tasks
- [ ] Keep the existing unique (chama_id, user_id) membership constraint as the single membership row.
- [ ] Define role semantics so chairperson/secretary/treasurer still inherit Member capabilities.
- [ ] Prevent more than one official office for the same membership.
- [ ] Keep platform Super Admin separate via users.is_platform_admin; do not treat super_admin as a Chama membership role in runtime logic.
- [ ] Audit/change member_role enum usage so super_admin cannot be assigned to chama_members.
- [ ] Audit all authorization middleware for Chama-scoped role checks.

## Acceptance Criteria
- [ ] A user can be Secretary in Chama A and Treasurer in Chama B.
- [ ] A user cannot be Secretary and Treasurer in the same Chama.
- [ ] Officials retain their own Member capabilities.
- [ ] Platform admin privilege cannot be created by changing a Chama membership role.

## Suggested labels
priority: critical

---
# BE-26: Session Context API — Return All Chama Memberships and Chama-Scoped Roles

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** API / Auth  
**Priority:** Critical

## Description
One login must return enough authorized context for users who belong to multiple Chamas. Roles are scoped to memberships, not represented as one global user role.

## Tasks
- [ ] Extend GET /auth/me (or a dedicated context endpoint) to return user profile, isPlatformAdmin and active memberships.
- [ ] For each membership return chamaId, name, logo, membershipStatus, official role and safe summary needed by the shell.
- [ ] Do not mint a global Treasurer/Secretary/Chair role that applies to every Chama.
- [ ] Define deterministic default active-Chama selection without forcing the frontend to guess.
- [ ] Ensure refresh/session restoration returns equivalent context.

## Acceptance Criteria
- [ ] A user with 3+ memberships receives all authorized Chama contexts in one response.
- [ ] Role for Chama A cannot authorize Chama B.
- [ ] Platform-admin status is returned separately from membership roles.
- [ ] Suspended/exited memberships are clearly represented and cannot be selected for privileged actions.

## Suggested labels
priority: critical

---
# BE-27: Multi-Chama Member Summary API

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** API  
**Priority:** High

## Description
Support the member dashboard that aggregates the signed-in user's own information across multiple Chamas while keeping each Chama's private scope separate.

## Tasks
- [ ] Provide the user's membership cards/summaries: own contributed amount/progress, next due item, status and official role for each Chama.
- [ ] Provide cross-Chama personal aggregates only for the signed-in user's own data.
- [ ] Return next upcoming obligation across Chamas.
- [ ] Design pagination/limits for users with many memberships.
- [ ] Ensure no other member's raw financial data is included.

## Acceptance Criteria
- [ ] Dashboard can render 3+ memberships without N+1 frontend calls.
- [ ] All aggregate financial values belong only to the authenticated user.
- [ ] Upcoming contribution data identifies its Chama unambiguously.

## Suggested labels
priority: high

---
# BE-28: Public Chama Discovery, Detail and Application API

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** API  
**Priority:** Critical

## Description
Complete the missing public discovery/application contract required by the landing page and marketplace.

## Tasks
- [ ] Add public Chama list endpoint with filters for goal, status, contribution range, duration, capacity, location and visibility.
- [ ] Add public Chama detail endpoint with public-safe officials, rules summary, recruitment data and commitment/fee information.
- [ ] Add authenticated application/join endpoint with PUBLIC/APPLICATION/PRIVATE branching.
- [ ] Reject PRIVATE direct applications without valid invite.
- [ ] Return current Constitution version/acceptance requirements before joining.
- [ ] Preserve privacy: no member balances, phones or payment methods in public responses.

## Acceptance Criteria
- [ ] Unauthenticated users can browse and inspect public Chamas.
- [ ] Authenticated users can apply/join according to visibility rules.
- [ ] Public detail exposes only public-safe official identity information.
- [ ] Integration tests cover public, application and private entry modes.

## Suggested labels
priority: critical

---
# BE-29: Goal Catalog Schema & API for Phase 1 Mbogi Saving

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** Schema / API  
**Priority:** Critical

## Description
The current chamas table has goal_code but there is no normalized goal catalog. Add Phase 1 goal categories/items so discovery, aggregate metrics, matching and merchant partnerships use stable identifiers.

## Tasks
- [ ] Extend the initial schema with goal_categories and saving_goals (or equivalent normalized tables) and stable codes/slugs.
- [ ] Seed HOME APPLIANCES: Washing machine, Fridge, TV, Cooker.
- [ ] Seed TRAVEL: Diani, Zanzibar, Dubai, Maasai Mara.
- [ ] Seed EDUCATION: School fees, Professional course, University fees.
- [ ] Seed PERSONAL: Laptop, Phone, Furniture.
- [ ] Relate chamas.goal_code (or a new FK) to the canonical saving goal.
- [ ] Add read APIs for categories, goals and goal detail.

## Acceptance Criteria
- [ ] Each approved goal has one stable backend identifier.
- [ ] Chamas can be queried reliably by goal.
- [ ] Frontend does not need to hard-code category membership.
- [ ] Seed data is deterministic in development/test environments.

## Suggested labels
priority: critical

---
# BE-30: Goal Marketplace Aggregate Metrics

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** API / Query  
**Priority:** High

## Description
Provide data for aggregate goal cards such as 'Washing Machine Goals — 87 members saving — KSh 3.8M total target value — 3 partner merchants'.

## Tasks
- [ ] Define what counts as a member saving toward a goal (active/pending membership rules).
- [ ] Aggregate member count across relevant active/recruiting Chamas.
- [ ] Aggregate target value using a documented definition (individual targets vs Chama targets) without double-counting.
- [ ] Return partner merchant count from active goal partnerships.
- [ ] Add indexes/materialization strategy if aggregation becomes expensive.

## Acceptance Criteria
- [ ] Goal metrics are computed from data, not frontend constants.
- [ ] Metric definitions are documented and tested.
- [ ] Closed/dissolved Chamas are excluded unless explicitly requested.
- [ ] API returns the three values needed by aggregate goal cards.

## Suggested labels
priority: high

---
# BE-31: Goal-to-Chama Matching Engine v2

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** Feature / API  
**Priority:** Critical

## Description
Align Chama matching with the Phase 1 funnel: individual goal → savings capacity/timeline → compatible Chamas.

## Tasks
- [ ] Accept canonical savingGoalId/goalCode plus target amount, contribution capacity, frequency, duration and optional location/preferences.
- [ ] Rank recruiting/public/application Chamas by goal compatibility and practical contribution fit.
- [ ] Exclude full, closed, dissolved or incompatible/private Chamas unless valid invite context exists.
- [ ] Return explainable match reasons for the frontend.
- [ ] Make ranking deterministic for identical input in tests.

## Acceptance Criteria
- [ ] Matching starts from the canonical goal catalog.
- [ ] Results explain why each Chama matched.
- [ ] Ineligible Chamas never appear as joinable results.
- [ ] Tests cover exact goal match, capacity mismatch, full groups and visibility modes.

## Suggested labels
priority: critical

---
# BE-32: Trust Score Domain Model, Calculation Contract and History

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** Architecture / Feature  
**Priority:** High

## Description
Introduce the Phase 1 trust-score capability without inventing an opaque or privacy-invasive score. The scoring formula is a founder/product decision and must be documented before production calculation.

## Tasks
- [ ] Define trust-score subject(s): member, Chama, or both.
- [ ] Define approved score inputs and weights with product sign-off.
- [ ] Store score snapshots/history and calculation version if persistence is required.
- [ ] Expose explainable factors, not just a number.
- [ ] Prevent raw private member financial data from appearing in another member's score explanation.
- [ ] Audit score changes and protect against simple gaming.

## Acceptance Criteria
- [ ] No trust score is generated until a documented formula/version exists.
- [ ] API returns score, level, factors and calculatedAt/version.
- [ ] Historical score changes are traceable.
- [ ] Privacy rules are preserved.

## Suggested labels
priority: high

---
# BE-33: Partner Merchant & Goal Reward Data Model

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** Schema / API  
**Priority:** High

## Description
Add the merchant partnership layer needed for Phase 1 marketplace rewards while keeping merchant commerce separate from Chama pooled-fund accounting.

## Tasks
- [ ] Add partner_merchants and goal_merchant_partnerships (or equivalent) to the initial schema.
- [ ] Store merchant status, display information, goal association, offer/reward rules and validity window.
- [ ] Add read endpoints for merchants by goal.
- [ ] Model member reward eligibility/redemption separately from Chama treasury ledger entries unless money movement explicitly requires accounting.
- [ ] Add audit trail for offer activation/deactivation and redemptions.

## Acceptance Criteria
- [ ] Washing Machine goal can return 3 active partner merchants from seed/mock backend data.
- [ ] Expired/inactive partnerships are excluded from active marketplace counts.
- [ ] Reward eligibility cannot be forged by the client.
- [ ] Merchant reward records do not directly mutate Chama pooled_amount.

## Suggested labels
priority: high

---
# BE-34: Commitment Mechanism Alignment for Goal-Based Joining

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** Feature / Financial  
**Priority:** Critical

## Description
Reuse the existing commitment_deposits and ledger architecture for the KSh 500 Phase 1 commitment mechanism and ensure joining/application status is correctly gated.

## Tasks
- [ ] Define whether KSh 500 remains fixed platform-wide or becomes configurable; keep this as a product blocker until answered.
- [ ] Link commitment record to the correct user, Chama/application and Constitution version.
- [ ] Use existing commitment ledger operation types for hold/refund/forfeiture; never mutate pooled_amount directly.
- [ ] Expose commitment status to frontend join flow.
- [ ] Define refund/forfeit transitions and idempotent payment handling.

## Acceptance Criteria
- [ ] Commitment payment can be traced from application/membership to ledger transaction.
- [ ] Repeated callbacks cannot duplicate the held amount.
- [ ] Join/application state cannot falsely report success before confirmed commitment when required.
- [ ] Refund/forfeiture transitions are auditable.

## Suggested labels
priority: critical

---
# BE-35: Authorization Regression Suite for Chama-Scoped Offices and Platform Admin

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** Security / Testing  
**Priority:** Critical

## Description
Add security tests for the newly confirmed one-account/multi-Chama model so role leakage cannot occur.

## Tasks
- [ ] Test Secretary in Chama A cannot call Secretary-only actions in Chama B.
- [ ] Test Treasurer/Chair retain Member self-service capabilities in their own Chama.
- [ ] Test one membership cannot hold two official offices.
- [ ] Test users.is_platform_admin controls platform routes independently of Chama role.
- [ ] Test changing active Chama on the client cannot change backend authorization.
- [ ] Test suspended/exited memberships lose Chama-scoped privileges.

## Acceptance Criteria
- [ ] All cross-Chama privilege escalation tests fail closed.
- [ ] Platform-admin and Chama-office authorization are independently verified.
- [ ] Role inheritance for Member self-service is covered.

## Suggested labels
priority: critical

---
# BE-36: Deterministic Development Seed Data for Multi-Chama and Goal-Marketplace Integration

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** Developer Experience / Testing  
**Priority:** Medium

## Description
Provide seed fixtures that mirror the approved prototype so frontend integration can be tested against realistic, repeatable backend data.

## Tasks
- [ ] Cover a user with 3+ Chama memberships and one official role in exactly one Chama in integration tests.
- [ ] Seed Member-only Chamas including Future Home and Washing Machine Mbogi.
- [ ] Seed approved goal categories/items and goal aggregate data inputs.
- [ ] Seed public/application/private Chamas with officials and Constitution/rules.
- [ ] Seed merchants/goal partnerships once BE-33 is available.
- [ ] Keep fixtures explicitly development/test-only.

## Acceptance Criteria
- [ ] Resetting the development database recreates the same fixture IDs/codes or stable lookup keys.
- [ ] Frontend can demonstrate multi-Chama switching and official workspace switching without manual DB edits.
- [ ] No seed data path can run in production.

## Suggested labels
priority: medium

---
# BE-37: Backend Contract Documentation for Active Chama / Workspace-Aware Frontend

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** Documentation / API  
**Priority:** High

## Description
Document the canonical response/request shapes the frontend will use for membership context, public discovery, goal marketplace, trust and merchant rewards.

## Tasks
- [ ] Document auth/session context response including memberships and isPlatformAdmin.
- [ ] Document public Chama list/detail/application endpoints.
- [ ] Document goal catalog, aggregate metrics and match endpoints.
- [ ] Document trust-score and merchant-reward response shapes.
- [ ] Document error codes for unauthorized Chama context, suspended membership, private Chama, Constitution not accepted and commitment required.
- [ ] Provide examples using the approved multi-Chama fixture user.

## Acceptance Criteria
- [ ] Frontend can implement against documented contracts without guessing field names.
- [ ] Every documented error has a stable machine-readable code.
- [ ] Examples distinguish Member View, official workspace and platform-admin context.

## Suggested labels
priority: high

---
# BE-38: Resolve Remaining Founder-Level Financial & Business Rule Blockers

**Repository:** `DeKUTSDA-learn/mduara-api`  
**Type:** Product / Architecture  
**Priority:** Critical

## Description
Several existing product questions still block final backend behaviour. Track them explicitly rather than letting implementation guess.

## Tasks
- [ ] Decide exact platform fee amount(s) per Chama type.
- [ ] Decide whether KSh 500 commitment is fixed platform-wide or configurable.
- [ ] Decide commitment refund SLA after eligibility.
- [ ] Decide re-entry rules for a defaulted member attempting to rejoin the same Chama.
- [ ] Decide loan interest method (flat vs declining balance).
- [ ] Decide who bears M-Pesa transaction/processing fees.
- [ ] Confirm licensed custody/payment partner and regulatory responsibilities with appropriate legal/compliance advice.

## Acceptance Criteria
- [ ] Each blocker has a recorded decision, owner and effective date/version.
- [ ] Dependent backend issues reference the resolved decision rather than hard-coding assumptions.
- [ ] Regulatory/custody behaviour is not implemented from guesswork.

## Suggested labels
priority: critical

---
