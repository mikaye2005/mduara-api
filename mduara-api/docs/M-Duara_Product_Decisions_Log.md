# M-Duara Product Decisions & Open Architecture Log

These decisions were confirmed during frontend prototype review and must be treated as product constraints unless explicitly changed later.

## PD-01: One identity, many Chamas
A user has one login identity and may belong to any number of Chamas. No separate credentials are created per Chama.

## PD-02: Base Member + optional official office
Every Chama participant has Member capabilities. A membership may hold one official office: Chairperson, Secretary or Treasurer.

## PD-03: Maximum one official office per Chama
The same membership can never be Secretary + Treasurer, Chair + Secretary, etc.

## PD-04: Official role is Chama-scoped
A role held in Chama A grants no official permissions in Chama B.

## PD-05: Officials still use Member View
Chairperson, Secretary and Treasurer can view their own savings, contributions, loans, statements and normal member experience.

## PD-06: Workspace switching, not account switching
Authenticated officials switch between Member View and their official workspace for the active Chama. They do not log into a second account.

## PD-07: Super Admin is platform-scoped
Super Admin is not publicly selectable and is independent of Chama membership. A platform admin may separately be a Chama member.

## PD-08: No public role picker
Login/registration never asks the user to choose Chair, Secretary, Treasurer or Super Admin. Authorization comes from backend membership/platform context.

## PD-09: Landing is a single-page website
Explore Chamas, How it works, Features, Safety & Trust, Pricing and FAQs scroll to sections on the same landing page.

## PD-10: View Chama opens real selected detail
Public Chama cards open the selected Chama's officials, rules, contribution/commitment data and entry method.

## PD-11: Auth-gated application resumes intent
A signed-out visitor can create/login then resume the same Chama application without rediscovery.

## PD-12: New logo is source branding, not drop-in artwork
The supplied logo is the approved source mark but must be adapted into palette-consistent transparent/inverse/compact variants before product use.

## PD-13: Phase 1 is goal-based saving
Phase 1 user journey: individual goal → group formation around similar goals → contributions → progress tracking → KSh 500 commitment mechanism → trust score → marketplace/merchant reward.

## PD-14: Approved Mbogi categories
HOME APPLIANCES: Washing machine, Fridge, TV, Cooker. TRAVEL: Diani, Zanzibar, Dubai, Maasai Mara. EDUCATION: School fees, Professional course, University fees. PERSONAL: Laptop, Phone, Furniture.

## PD-15: Goal aggregate card pattern
Goal cards may show metrics like Washing Machine Goals / 87 members saving / KSh 3.8M total target value / 3 partner merchants; values must eventually come from backend aggregates.

## PD-16: Prototype uses centralized mock data
Until live APIs are connected, all prototype views must share one deterministic mock-data/state layer so screens cannot disagree.

## PD-17: No dead interaction rule
Any control that looks clickable must work, be disabled with a reason, or be removed.


---

# BE-38 Founder-Level Financial & Business Decision Register

**Register version:** `be38-open-v1`  
**Recorded:** 2026-09-17  
**Status:** OPEN — product/legal decisions required before affected production behaviour is finalized.

The records below intentionally distinguish an approved product decision from a temporary engineering safety posture. `OPEN` does not mean the backend may select a convenient default. Until a record becomes `APPROVED`, dependent code must remain disabled, configurable only inside already accepted Constitution/rule boundaries, or otherwise fail closed.

## PD-18: Platform fee per Chama join

- **Status:** OPEN
- **Decision owner:** Founder / Product + Finance
- **Effective date:** Pending approval
- **Decision version:** Pending
- **Question:** What exact non-refundable M-Duara platform fee is charged when a member joins, and does the amount vary by Chama type?
- **Confirmed constraints:** The platform fee is distinct from the commitment deposit and is platform revenue. Existing product material still specifies `KSh X` rather than an approved amount.
- **Engineering posture until approval:** Do not invent, auto-charge, display as final, or ledger a production join-platform-fee amount. Join APIs may expose commitment requirements independently; platform-fee collection requires this decision first.
- **Dependent areas:** Join/payment orchestration, platform-fee ledger operation, receipts, frontend join confirmation/payment UI, reporting/reconciliation.

## PD-19: KSh 500 commitment — fixed or Constitution-configurable

- **Status:** OPEN
- **Decision owner:** Founder / Product + Finance
- **Effective date:** Pending approval
- **Decision version:** Pending
- **Question:** Is KSh 500 a platform-wide fixed Phase 1 commitment amount, or may an approved Chama Constitution configure another amount?
- **Confirmed constraints:** Phase 1 consistently presents KSh 500. The commitment is member custody money, not M-Duara revenue, and its accepted rule version must be traceable.
- **Engineering posture until approval:** Continue using the immutable accepted Constitution `commitment_amount`, whose Phase 1/default fixture value is KSh 500. Client input can never choose or override the amount. Do not enforce a platform-wide database constant until approved.
- **Dependent areas:** BE-34 commitment service/schema, Chama Constitution editor/templates, join UI, provider amount validation, refunds/forfeitures.

## PD-20: Commitment refund payout SLA

- **Status:** OPEN
- **Decision owner:** Founder / Product + Operations + Finance
- **Effective date:** Pending approval
- **Decision version:** Pending
- **Question:** Within how many business/calendar days after `eligible_for_refund` must a commitment refund be dispatched or completed?
- **Confirmed constraints:** Eligible clean commitments must not be held indefinitely; actual settlement is provider-confirmed.
- **Engineering posture until approval:** Preserve the explicit `eligible_for_refund -> refund_requested -> refunded` states and provider-confirmed settlement. Do not create an automatic SLA timer, breach status, or customer promise using an invented duration.
- **Dependent areas:** Commitment/refund jobs, notifications, support escalation, dashboards, SLA monitoring, Terms & Conditions.

## PD-21: Re-entry after default in the same Chama

- **Status:** OPEN
- **Decision owner:** Founder / Product + Governance/Legal
- **Effective date:** Pending approval
- **Decision version:** Pending
- **Question:** Can a defaulted/exited member rejoin the same Chama? If yes, under what arrears, re-entry fee, approval, recruitment-window, trust-history, and fresh-commitment conditions?
- **Confirmed constraints:** A previous default must remain historically traceable; examples in the business-rules document are alternatives, not approved policy.
- **Engineering posture until approval:** Do not implement automatic same-Chama re-entry or silently reset a defaulted membership. Existing unique membership identity and historical state should remain authoritative until an approved recovery/reactivation transition is specified.
- **Dependent areas:** Membership lifecycle, public join/apply flow, commitment cycle numbering, arrears/default engine, trust history, audit logs.

## PD-22: Loan interest calculation method

- **Status:** OPEN — release blocker for production lending
- **Decision owner:** Founder / Product + Finance + Legal/Compliance
- **Effective date:** Pending approval
- **Decision version:** Pending
- **Question:** Is loan pricing flat/simple, declining-balance, periodic accrued interest, or another explicitly defined method? How are rates interpreted and rounded?
- **Confirmed constraints:** Current drafts conflict. The backend currently contains an upfront percentage `total_due` calculation and optional periodic interest accrual machinery; their coexistence must not be treated as an approved pricing policy.
- **Engineering posture until approval:** Treat production loan pricing/disbursement as not financially approved. Do not market or rely on calculated repayment schedules as final terms until one method, rate interpretation, accrual cadence, rounding policy, and migration treatment are approved and tests are aligned.
- **Dependent areas:** loan controller, `loan_rules`, interest worker/job, financial-math utilities, loan ledger charges, frontend amortization schedule, statements and disclosures.

## PD-23: M-Pesa/provider transaction fee bearer

- **Status:** OPEN
- **Decision owner:** Founder / Product + Finance
- **Effective date:** Pending approval
- **Decision version:** Pending
- **Question:** Who bears provider/M-Pesa transaction and processing fees for contribution collection, commitment hold/refund, loan payout/repayment, and other money movement — member, Chama, M-Duara, or a transaction-specific rule?
- **Confirmed constraints:** Provider movement and M-Duara ledger records must reconcile exactly; fees must not be silently absorbed into member savings or commitment principal.
- **Engineering posture until approval:** Do not net provider fees from principal, pooled savings, commitment custody, or repayment values unless an approved charge policy explicitly authorizes it. Record provider settlement evidence separately when available.
- **Dependent areas:** provider integration, reconciliation, ledger accounts, receipts, contribution/commitment/loan calculations, platform revenue reporting.

## PD-24: Licensed custody/payment partner and regulatory responsibilities

- **Status:** OPEN — legal/compliance release blocker for real-money production
- **Decision owner:** Founder + Legal/Compliance
- **Effective date:** Pending legal/compliance approval
- **Decision version:** Pending
- **Question:** Which licensed entity legally receives/holds/moves member and Chama funds, what account/escrow/sub-ledger structure is used, and what licensing/registration/compliance obligations remain with M-Duara?
- **Confirmed constraints:** M-Duara is designed as the software/instruction/ledger layer and must not represent itself as directly holding member savings or commitment deposits. Daraja is an API rail, not by itself a legal custody determination.
- **Engineering posture until approval:** Keep payment/custody integrations behind provider boundaries and reconciliation. Do not enable or describe a real-money custody arrangement as production-approved until the actual licensed partner, contracts, safeguarding model, settlement flow, KYC/AML/data responsibilities and regulatory position are confirmed by appropriate counsel/compliance owners.
- **Dependent areas:** all real-money flows, provider configuration, reconciliation, Terms & Conditions, privacy/compliance, support/refunds, production deployment approval.

## PD-25: SaaS subscription pricing and tier limits

- **Status:** OPEN — commercial configuration blocker for paid subscription checkout and tier quotas
- **Decision owner:** Founder / Product + Finance
- **Effective date:** Pending approval
- **Decision version:** Pending
- **Question:** What are the approved Free/Premium monthly and annual prices, maximum members, maximum concurrent/open loans, and monthly SMS quotas for each tier?
- **Confirmed constraints:** Product rules require Free/Premium tiers, member/loan/SMS limits, detailed-PDF feature gating and a seven-day unpaid grace period. Existing KSh 999/month, 50-member and 1,000-SMS figures appear only in prototype/demo UI and are explicitly labelled sample/editable values.
- **Engineering posture until approval:** Keep commercial price/limit columns explicit and nullable in the canonical plan catalog. Do not promote prototype figures to production defaults. Paid checkout fails closed when a selected paid plan has no approved positive price. Limit enforcement becomes active automatically when approved numeric limits are populated. The seven-day access lifecycle and plan-feature gates remain deterministic independent of those numbers.
- **Dependent areas:** BE-10 subscription plan catalog, M-Pesa subscription checkout, onboarding capacity, loan quota, SMS quota, PDF/report entitlements, pricing UI, receipts and revenue reporting.

## Approval rule for PD-18 through PD-25

A record leaves `OPEN` only when the authorized decision owner records all of the following: **selected decision, approver/owner, effective date, version, affected Chama/product scope, and migration/compatibility notes**. Legal/compliance-dependent records additionally require the relevant external/qualified review to be recorded. Engineering implementation must reference the approved decision ID/version rather than only a numeric constant or informal message.
