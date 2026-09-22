# M-Duara Backend Contract — Workspace-Aware Frontend (BE-37)

**Contract version:** `be37-v1`  
**API base:** `/api/v1`  
**Status:** canonical Phase 1 frontend integration contract  
**Scope:** authentication/session context, Chama discovery/joining, goal marketplace, commitment state, trust scores, merchant rewards, and stable frontend-facing error codes.

This document describes the field names and state transitions implemented by the current backend. Frontend code should not infer Chama authority from local workspace state, role labels, or prototype data. Route-scoped authorization is always resolved server-side from PostgreSQL.

## 1. Response envelopes

Most feature controllers return:

```json
{
  "data": {}
}
```

Authentication endpoints implemented through the shared response helper return:

```json
{
  "success": true,
  "data": {}
}
```

All centralized API errors return:

```json
{
  "success": false,
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Human-readable explanation",
    "details": {}
  }
}
```

`details` is optional. Frontend branching must use `error.code`, never exact message text.

Chama authorization middleware may return the same `error.code`/`message` object without the outer `success` field. Clients should therefore treat `error.code` as the canonical discriminator.

## 2. Authentication and session context

### `GET /auth/me`

Requires `Authorization: Bearer <access-token>`.

Response:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "fullName": "Jane Mwangi",
      "phone": "+254712345678",
      "email": "jane@example.com",
      "avatarUrl": null,
      "dateOfBirth": null,
      "status": "active",
      "isEmailVerified": true,
      "createdAt": "timestamp",
      "updatedAt": "timestamp"
    },
    "isPlatformAdmin": false,
    "memberships": [
      {
        "membershipId": "uuid",
        "chamaId": "uuid",
        "name": "Diani Holiday 2027",
        "logoUrl": null,
        "membershipStatus": "active",
        "role": "secretary",
        "officialRole": "secretary",
        "joinedAt": "timestamp"
      }
    ],
    "defaultContext": {
      "chamaId": "uuid",
      "membershipId": "uuid",
      "workspace": "member"
    }
  }
}
```

Membership `role` values are `member | chair | secretary | treasurer`. `officialRole` is the same office role only when the membership is active and is otherwise `null`.

`defaultContext.workspace` is deliberately `member`. An office holder remains a Member and may enter the official workspace in the client using the same `membershipId`; the server does not accept a client-selected role as proof of authority.

### Multi-Chama context

The session returns every membership created for the authenticated user. The default context is selected from the authoritative database ordering. Switching between Chamas must not preserve an official role from the previously selected Chama.

A platform administrator is represented independently by `isPlatformAdmin: true`. Chama office roles never imply platform administration.

## 3. Public Chama marketplace

### `GET /chamas/public`

No authentication required.

Supported query parameters:

- `page` default `1`
- `per_page` default `20`, maximum `50`
- `goal_code`
- `status`: `recruiting | active | completed`
- `visibility`: `public | application`
- `type`: `goal_based | table_banking | merry_go_round | welfare | investment`
- `location`
- `min_contribution`
- `max_contribution`
- `min_duration_months`
- `max_duration_months`
- `has_capacity=true|false`
- `min_available_spots`

Without a status filter, only `recruiting` and `active` Chamas are returned. Private Chamas are never returned by this endpoint.

Response:

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Washing Machine Mbogi",
      "description": "...",
      "type": "goal_based",
      "status": "recruiting",
      "visibility": "public",
      "goalCode": "washing_machine",
      "location": "Nairobi",
      "logoUrl": null,
      "targetMembers": 30,
      "recruitmentDeadline": "2026-12-31",
      "savingStartDate": "2026-10-01",
      "savingEndDate": "2028-01-31",
      "purchaseWindowStart": null,
      "purchaseWindowEnd": null,
      "durationMonths": 16,
      "contributionAmount": "3000",
      "contributionFrequency": "monthly",
      "currency": "KES",
      "memberCount": 5,
      "occupiedCount": 5,
      "availableSpots": 25,
      "commitmentAmount": "500"
    }
  ],
  "meta": {
    "total": 1,
    "page": 1,
    "perPage": 20,
    "totalPages": 1
  }
}
```

Monetary values are strings when sourced from PostgreSQL `BIGINT`; clients should format them as currency rather than coercing them through floating-point arithmetic.

### `GET /chamas/public/:id`

Returns one public/application Chama. A private Chama is intentionally not discoverable through this endpoint.

Additional detail fields include:

```json
{
  "data": {
    "officials": [
      { "name": "James Kariuki", "role": "chairperson" }
    ],
    "constitution": {
      "id": "uuid",
      "version": 1,
      "purposeGoal": "Washing Machine",
      "contributionAmount": "3000",
      "contributionFrequency": "monthly",
      "contributionDueDay": null,
      "lateFine": {
        "type": "flat",
        "amount": "0",
        "percentage": "0.00"
      },
      "commitmentAmount": "500",
      "defaultGracePeriodDays": 5,
      "defaultAfterConsecutiveMisses": 3,
      "quorumThresholdPct": "50.00",
      "majorityThresholdPct": "50.00",
      "exitWithdrawalPolicy": {},
      "payoutPolicy": {},
      "conductDisputePolicy": {},
      "dissolutionPolicy": {},
      "effectiveFrom": "timestamp",
      "acceptanceRequired": true
    }
  }
}
```

For `goal_based` Chamas, the public detail deliberately reports `targetAmount: null`; the collective Chama target must not be presented as the individual member's personal savings target.

## 4. Join/application contract

## 4. Start a Chama

### `POST /chamas`

Requires authentication. Launch accepts only `goal_based` Chamas and requires `goal_code`, contribution amount/frequency, target members, recruitment deadline, saving dates, visibility, Constitution fields, and `phone_number`.

This endpoint starts a KSh 3,000 M-Pesa STK payment; it does **not** create a Chama yet. A successful response is HTTP `202` and includes `paymentId`, `checkoutRequestId`, `amount: "3000"`, and `status: "pending"`.

### `GET /chamas/registration-payments/:checkoutId`

Requires the founder's authentication. Use this to poll the payment status. Once the provider callback is confirmed, it returns `status: "confirmed"` and the created `chamaId`.

The provider callback is `POST /chamas/registration-payments/mpesa/callback`. It is signature/source verified server-side. Only a confirmed callback for the exact KSh 3,000 amount creates the Chama, its founder chairperson membership, initial Constitution, and immutable platform-fee journal.

## 5. Join/application contract

### `POST /chamas/:id/apply`

Requires authentication.

Request:

```json
{
  "constitution_rule_id": "uuid",
  "accept_constitution": true,
  "message": "Optional message",
  "invitation_id": "optional-uuid"
}
```

`accept_constitution` must be explicitly `true`. The supplied Constitution rule must still be the active rule version at transaction time.

### Application visibility outcome

HTTP `202`:

```json
{
  "data": {
    "outcome": "application_pending",
    "application": {
      "id": "uuid",
      "status": "pending",
      "created_at": "timestamp"
    },
    "membership": null,
    "commitment": {
      "required": true,
      "amount": "500",
      "state": "awaiting_application_approval"
    },
    "constitution": {
      "id": "uuid",
      "version": 1,
      "accepted": true
    }
  }
}
```

No membership/commitment row is created until the application is approved.

### Direct public/invite outcome requiring commitment

HTTP `201`:

```json
{
  "data": {
    "outcome": "commitment_required",
    "application": {
      "id": "uuid",
      "status": "commitment_pending",
      "created_at": "timestamp"
    },
    "membership": {
      "id": "uuid",
      "chama_id": "uuid",
      "user_id": "uuid",
      "role": "member",
      "membership_status": "pending",
      "joined_at": "timestamp"
    },
    "commitment": {
      "required": true,
      "amount": "500",
      "state": "applied",
      "id": "uuid"
    },
    "constitution": {
      "id": "uuid",
      "version": 1,
      "accepted": true
    }
  }
}
```

`commitment_required` is a successful machine-readable transition outcome, **not an HTTP error**. The frontend should proceed to the provider/STK payment experience. The membership must not be presented as active yet.

Only server/provider confirmation of the exact commitment amount changes the commitment to `held`, membership to `active`, and application to `approved`.

### No-commitment outcome

When the accepted Constitution requires no commitment:

```json
{
  "data": {
    "outcome": "joined",
    "commitment": {
      "required": false,
      "amount": "0",
      "state": "not_required"
    }
  }
}
```

## 5. Member commitment status

### `GET /memberships/:id/commitment`

Authenticated owner only.

Representative held response:

```json
{
  "data": {
    "commitmentId": "uuid",
    "membershipId": "uuid",
    "applicationId": "uuid",
    "chamaId": "uuid",
    "required": true,
    "amount": "500",
    "currency": "KES",
    "state": "held",
    "membershipStatus": "active",
    "applicationStatus": "approved",
    "canStartSaving": true,
    "constitution": {
      "id": "uuid",
      "version": 1
    },
    "provider": "mpesa",
    "providerReference": "provider-reference",
    "timestamps": {
      "heldAt": "timestamp",
      "atRiskAt": null,
      "defaultTriggeredAt": null,
      "eligibleForRefundAt": null,
      "refundRequestedAt": null,
      "refundedAt": null,
      "forfeitedAt": null
    },
    "ledger": {
      "holdTransactionId": "uuid",
      "terminalTransactionId": null
    }
  }
}
```

Commitment states currently exposed are:

`not_initialized | not_required | applied | held | at_risk | default_triggered | eligible_for_refund | refund_requested | refunded | forfeited`.

The historical enum also contains `partial_forfeit`, but the current service intentionally does not permit that transition until the remaining-balance policy is approved.

### `POST /memberships/:id/commitment/refund-request`

Authenticated owner only. This changes state to `refund_requested` only when the commitment is already `eligible_for_refund`; it does not claim that money has moved. Provider confirmation remains the money-movement boundary.

## 6. Goal catalog

### `GET /goals/categories`

```json
{
  "data": [
    {
      "id": "uuid",
      "code": "home_appliances",
      "slug": "home-appliances",
      "name": "Home Appliances",
      "displayOrder": 1,
      "goalCount": 4
    }
  ]
}
```

### `GET /goals?category_code=home_appliances`

```json
{
  "data": [
    {
      "id": "uuid",
      "code": "washing_machine",
      "slug": "washing-machine",
      "name": "Washing Machine",
      "description": null,
      "displayOrder": 1,
      "category": {
        "id": "uuid",
        "code": "home_appliances",
        "slug": "home-appliances",
        "name": "Home Appliances"
      }
    }
  ]
}
```

### `GET /goals/:identifier`

`:identifier` may be canonical UUID, goal code, or slug.

## 7. Goal marketplace metrics

### `GET /goals/metrics`
### `GET /goals/metrics?category_code=home_appliances`
### `GET /goals/:identifier/metrics`

Metric shape:

```json
{
  "data": {
    "id": "uuid",
    "code": "washing_machine",
    "slug": "washing-machine",
    "name": "Washing Machine",
    "category": {
      "id": "uuid",
      "code": "home_appliances",
      "slug": "home-appliances",
      "name": "Home Appliances"
    },
    "membersSaving": 5,
    "totalTargetValue": "1440000",
    "currency": "KES",
    "partnerMerchantCount": 3
  }
}
```

`membersSaving` counts distinct active users across eligible recruiting/active public/application Chamas. `totalTargetValue` sums eligible Chama collective target amounts once per Chama and is not a personal savings target.

## 8. Goal-to-Chama matching

### `POST /goals/matches`

Authentication is optional. A supplied invalid bearer token still fails closed. Private Chamas can only be unlocked by an authenticated applicant-specific valid invitation.

Request:

```json
{
  "goalCode": "washing_machine",
  "targetAmount": 48000,
  "contributionCapacity": 5000,
  "contributionFrequency": "monthly",
  "durationMonths": 18,
  "location": "Nairobi",
  "preferredVisibility": "public",
  "limit": 10
}
```

At least one of `savingGoalId` or `goalCode` is required. If both are supplied they must identify the same active canonical goal.

Response:

```json
{
  "data": {
    "goal": {
      "id": "uuid",
      "code": "washing_machine",
      "slug": "washing-machine",
      "name": "Washing Machine",
      "category": {
        "id": "uuid",
        "code": "home_appliances",
        "slug": "home-appliances",
        "name": "Home Appliances"
      }
    },
    "request": {
      "targetAmount": "48000",
      "contributionCapacity": "5000",
      "contributionFrequency": "monthly",
      "durationMonths": 18,
      "location": "Nairobi",
      "preferredVisibility": "public"
    },
    "matches": [
      {
        "rank": 1,
        "score": 87,
        "joinable": true,
        "entryMode": "public",
        "matchReasons": [
          "Exact canonical saving-goal match"
        ],
        "chama": {
          "id": "uuid",
          "name": "Washing Machine Mbogi",
          "description": "...",
          "status": "recruiting",
          "visibility": "public",
          "location": "Nairobi",
          "logoUrl": null,
          "targetMembers": 30,
          "occupiedCount": 5,
          "availableSpots": 25,
          "contributionAmount": "3000",
          "contributionFrequency": "monthly",
          "targetAmount": "1440000",
          "savingStartDate": "2026-10-01",
          "savingEndDate": "2028-01-31",
          "durationMonths": 16,
          "currency": "KES"
        }
      }
    ],
    "meta": {
      "count": 1,
      "scoringVersion": "goal-match-v2.1",
      "targetAmountScoring": "context_only"
    }
  }
}
```

The user's `targetAmount` is retained as funnel context and is deliberately not scored against the collective `chamas.target_amount`.

## 9. Trust score

### `GET /trust/chamas/:chamaId`

Public-safe Chama trust response.

### `GET /trust/memberships/:membershipId`
### `GET /trust/memberships/:membershipId/history?limit=20`

Member trust/history is authenticated and owner-only.

When no active scoring formula has been provisioned:

```json
{
  "data": {
    "subject": {
      "type": "member",
      "membershipId": "uuid",
      "chamaId": "uuid",
      "chamaName": "Diani Holiday 2027"
    },
    "available": false,
    "score": null,
    "level": null,
    "factors": [],
    "calculatedAt": null,
    "version": null,
    "methodology": null,
    "unavailableReason": "TRUST_SCORE_FORMULA_NOT_ACTIVATED"
  }
}
```

Available snapshots use:

```json
{
  "available": true,
  "score": 91,
  "level": "...",
  "factors": [
    {
      "code": "...",
      "label": "...",
      "effect": "positive",
      "summary": "Sanitized explanation"
    }
  ],
  "calculatedAt": "timestamp",
  "version": "formula-version",
  "methodology": "public formula description",
  "unavailableReason": null
}
```

Frontend code must never expect raw contribution amounts, balances, payment methods, phone numbers, or account identifiers inside trust factors.

## 10. Goal merchant rewards

### `GET /goals/:identifier/merchants`

Public offer catalog. Only active merchants and active/current partnerships are returned.

### `GET /goals/:identifier/merchants?membership_id=<uuid>`

When a valid bearer token is supplied and the membership belongs to that user and goal, the same response includes the server-stored membership reward state.

Response:

```json
{
  "data": {
    "goal": {
      "id": "uuid",
      "code": "washing_machine",
      "slug": "washing-machine",
      "name": "Washing Machine"
    },
    "membershipId": "uuid-or-null",
    "merchants": [
      {
        "partnershipId": "uuid",
        "merchant": {
          "id": "uuid",
          "code": "homeplus_appliances",
          "name": "HomePlus Appliances",
          "description": "...",
          "logoUrl": null,
          "websiteUrl": null,
          "isDemo": true
        },
        "offer": {
          "title": "...",
          "summary": "...",
          "terms": null,
          "rewardRules": {},
          "validFrom": null,
          "validUntil": null,
          "isDemo": true
        },
        "reward": {
          "id": null,
          "state": "locked",
          "eligibleAt": null,
          "redeemedAt": null,
          "serverConfirmed": false
        }
      }
    ],
    "meta": {
      "count": 3,
      "rewardStateAuthority": "server"
    }
  }
}
```

Reward states are `locked | eligible | redeemed | expired | revoked`. The client cannot grant eligibility or redemption; no public mutation route exists for either operation.

## 11. Stable frontend-facing error codes

| Code | HTTP | Meaning / frontend action |
|---|---:|---|
| `VALIDATION_FAILED` | 400 | Request shape/query failed validation. Use field details when present. |
| `UNAUTHORIZED` | 401 | Authentication is absent/invalid/expired. Return to sign-in or refresh flow. |
| `CHAMA_SCOPE_REQUIRED` | 403 | A Chama-scoped route was called without the required route Chama context. |
| `CHAMA_MEMBERSHIP_INACTIVE` | 403 | No active membership exists for this user in the route's Chama. Covers unrelated, suspended, exited or otherwise non-active membership. |
| `CHAMA_ROLE_FORBIDDEN` | 403 | Active member exists, but the current Chama office is insufficient for this action. |
| `PRIVATE_CHAMA_INVITE_REQUIRED` | 403 | Private Chama requires a valid applicant-specific invitation. |
| `CHAMA_ENTRY_MODE_FORBIDDEN` | 403 | Requested direct-entry path is incompatible with the Chama visibility mode. |
| `CONSTITUTION_NOT_ACCEPTED` | 400 or server-side conflict boundary | Explicit Constitution acceptance is missing, or commitment evidence is not backed by the accepted rule. |
| `CONSTITUTION_NOT_AVAILABLE` | 409 | Chama has no active Constitution and cannot be joined. |
| `CONSTITUTION_VERSION_CONFLICT` | 409 | Client submitted a stale Constitution rule ID; refresh Chama detail and re-confirm. |
| `COMMITMENT_NOT_PENDING` | 409 | Provider confirmation does not correspond to a commitment-pending application. |
| `COMMITMENT_MEMBERSHIP_STATE_INVALID` | 409 | Membership state changed unexpectedly before commitment confirmation. |
| `COMMITMENT_OWNER_REQUIRED` | 403 | Commitment details/refund state are private to the membership owner. |
| `BAD_REQUEST` | 400 | Stable generic bad-request fallback. |
| `FORBIDDEN` | 403 | Stable generic forbidden fallback. |
| `NOT_FOUND` | 404 | Requested resource does not exist or is intentionally undiscoverable. |
| `CONFLICT` | 409 | Stable generic state-conflict fallback. |
| `UNPROCESSABLE_ENTITY` | 422 | Semantically invalid financial/domain input. |
| `TOO_MANY_REQUESTS` | 429 | Rate limit reached; inspect optional retry details. |
| `SERVICE_UNAVAILABLE` | 503 | Required backend capability/configuration is temporarily unavailable. |
| `ROUTE_NOT_FOUND` | 404 | No API route matches the method/path. |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected server error; do not expose internal details to the user. |

### Commitment-required note

A valid join that still requires the KSh 500/default Constitution commitment does **not** return an error code. It returns:

```json
{ "outcome": "commitment_required" }
```

This is the stable machine-readable next-action state. Treating it as an HTTP error would incorrectly imply that the join request failed.

## 12. Workspace implementation rules for frontend

1. Store `membershipId` and `chamaId` as the selected workspace context; never store an elevated role as an authorization token.
2. Build the workspace switcher from `/auth/me.memberships`.
3. Show an official workspace option only when that selected membership's `officialRole` is non-null.
4. Always call Chama-scoped endpoints with the Chama ID in the route expected by the endpoint; the server ignores spoofable active-Chama UI hints for authorization.
5. On `CHAMA_MEMBERSHIP_INACTIVE`, refresh `/auth/me` before assuming the user's local membership state is current.
6. On `CHAMA_ROLE_FORBIDDEN`, stay within the same membership but remove/disable that official action.
7. On `CONSTITUTION_VERSION_CONFLICT`, reload public Chama detail and require explicit acceptance of the current Constitution version before retrying.
8. On `outcome: commitment_required`, continue to the commitment/STK flow and do not render the membership as active until commitment status becomes `held` and `canStartSaving` is true.
9. Do not derive trust scores, merchant eligibility, or financial standing client-side.
10. Treat all KES `BIGINT` values returned as strings as exact money values.

## 13. Clean database initialization

`npm run migrate` requires `SUPER_ADMIN_FULL_NAME`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PHONE`, and `SUPER_ADMIN_PIN` in `.env`; it creates only the configured platform administrator and required reference catalog data. Users and Chamas are created through the normal API flows. Use `npm run db:migrate` only for an intentional schema-only migration.
