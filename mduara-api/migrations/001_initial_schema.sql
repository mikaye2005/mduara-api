-- M-DUARA PostgreSQL initial schema.
-- Monetary values are stored as whole KES in BIGINT columns.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_status AS ENUM ('pending', 'active', 'suspended', 'deleted');
CREATE TYPE chama_type AS ENUM ('goal_based', 'table_banking', 'merry_go_round', 'welfare', 'investment');
CREATE TYPE chama_status AS ENUM ('draft', 'recruiting', 'active', 'inactive', 'completed', 'dissolved', 'archived');
CREATE TYPE member_role AS ENUM ('member', 'treasurer', 'secretary', 'chairperson');
CREATE TYPE membership_status AS ENUM ('active', 'pending', 'suspended', 'defaulted', 'exited');
CREATE TYPE member_commitment_status AS ENUM ('ON_TRACK', 'MISSED_1', 'MISSED_2', 'DEFAULT_TRIGGERED');
CREATE TYPE invitation_status AS ENUM ('pending', 'sent', 'approved', 'accepted', 'rejected', 'cancelled', 'expired', 'delivery_failed');
CREATE TYPE chama_visibility AS ENUM ('public', 'application', 'private');
CREATE TYPE application_status AS ENUM ('pending', 'commitment_pending', 'approved', 'rejected', 'withdrawn');
CREATE TYPE constitution_status AS ENUM ('draft', 'active', 'superseded');
CREATE TYPE commitment_state AS ENUM ('applied', 'held', 'at_risk', 'default_triggered', 'forfeited', 'partial_forfeit', 'eligible_for_refund', 'refund_requested', 'refunded');
CREATE TYPE notification_channel AS ENUM ('in_app', 'sms', 'email', 'push');
CREATE TYPE notification_status AS ENUM ('pending', 'sent', 'failed', 'cancelled');
CREATE TYPE poll_status AS ENUM ('draft', 'open', 'closed', 'cancelled');
CREATE TYPE support_ticket_category AS ENUM ('payment_issue', 'account_issue', 'refund_issue', 'chama_issue');
CREATE TYPE contribution_status AS ENUM ('pending', 'partially_paid', 'paid', 'late', 'waived');
CREATE TYPE payment_method AS ENUM ('mpesa', 'bank', 'cash', 'card');
CREATE TYPE payment_status AS ENUM ('pending', 'confirmed', 'failed', 'reversed');
CREATE TYPE loan_status AS ENUM ('pending', 'awaiting_guarantors', 'pending_admin_approval', 'partially_approved', 'approved', 'disbursement_pending', 'disbursement_failed', 'disbursed', 'active', 'partially_repaid', 'repaid', 'rejected', 'defaulted', 'cancelled');
CREATE TYPE repayment_status AS ENUM ('pending', 'confirmed', 'failed', 'reversed');
CREATE TYPE subscription_status AS ENUM ('active', 'paused', 'cancelled');
CREATE TYPE billing_status AS ENUM ('pending', 'paid', 'failed', 'refunded');
CREATE TYPE support_ticket_status AS ENUM ('open', 'in_progress', 'escalated', 'resolved', 'closed');
CREATE TYPE meeting_rsvp_status AS ENUM ('going', 'maybe', 'declined');
CREATE TYPE mgr_generation_mode AS ENUM ('manual', 'randomized', 'bidding');
CREATE TYPE mgr_cycle_status AS ENUM ('active', 'completed', 'cancelled');
CREATE TYPE mgr_payout_status AS ENUM ('scheduled', 'disbursement_pending', 'paid', 'skipped', 'disputed');
CREATE TYPE mgr_swap_status AS ENUM ('pending', 'accepted', 'rejected', 'cancelled');
CREATE TYPE mgr_disbursement_status AS ENUM ('pending', 'dispatched', 'confirmed', 'failed', 'timed_out');
CREATE TYPE ledger_entry_side AS ENUM ('debit', 'credit');
CREATE TYPE ledger_account AS ENUM (
    'chama_treasury',
    'member_contribution',
    'member_payout',
    'external_clearing',
    'member_penalty_receivable',
    'penalty_income',
    'member_interest_receivable',
    'interest_income',
    'commitment_escrow',
    'commitment_forfeiture',
    'member_loan_principal',
    'loan_default_recovery',
    'platform_fee_revenue'
);
CREATE TYPE audit_event_category AS ENUM ('security', 'financial', 'moderation', 'system');
CREATE TYPE audit_actor_role AS ENUM ('member', 'treasurer', 'secretary', 'chairperson', 'platform_admin', 'system');
CREATE TYPE trust_score_subject AS ENUM ('member', 'chama');
CREATE TYPE trust_score_formula_status AS ENUM ('draft', 'approved', 'active', 'retired');
CREATE TYPE merchant_status AS ENUM ('draft', 'active', 'inactive', 'suspended');
CREATE TYPE merchant_partnership_status AS ENUM ('draft', 'active', 'paused', 'ended');
CREATE TYPE merchant_reward_state AS ENUM ('locked', 'eligible', 'redeemed', 'expired', 'revoked');
CREATE TYPE media_upload_purpose AS ENUM ('profile_avatar', 'chama_logo', 'support_ticket_attachment');
CREATE TYPE media_upload_state AS ENUM ('initiated', 'scan_pending', 'clean', 'infected', 'scan_failed', 'rejected', 'deleted');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    pin_changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
    login_locked_until TIMESTAMPTZ,
    session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
    is_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at TIMESTAMPTZ,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    avatar_url TEXT,
    national_id TEXT,
    date_of_birth DATE,
    status user_status NOT NULL DEFAULT 'pending',
    status_reason TEXT,
    suspended_at TIMESTAMPTZ,
    suspended_by UUID REFERENCES users(id) ON DELETE SET NULL,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_users_email_lower ON users (lower(email));
CREATE UNIQUE INDEX idx_users_phone_unique ON users (phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX idx_users_national_id_unique ON users (national_id) WHERE national_id IS NOT NULL;
CREATE INDEX idx_users_status ON users (status);
CREATE INDEX idx_users_login_locked_until ON users (login_locked_until) WHERE login_locked_until IS NOT NULL;

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens (user_id);

CREATE TABLE email_verification_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens (user_id);

CREATE TABLE otp_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'registration',
    CONSTRAINT chk_otp_codes_purpose
        CHECK (purpose IN ('registration', 'pin_reset')),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_otp_codes_user_id ON otp_codes (user_id);
CREATE INDEX idx_otp_codes_phone_purpose_created_at
    ON otp_codes (phone, purpose, created_at DESC);
CREATE INDEX idx_otp_codes_pending_lookup
    ON otp_codes (phone, purpose, created_at DESC) WHERE consumed_at IS NULL;

CREATE TABLE otp_request_events (
    id BIGSERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    purpose TEXT NOT NULL,
    CONSTRAINT chk_otp_request_events_purpose
        CHECK (purpose IN ('registration', 'pin_reset')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_otp_request_events_rate_limit
    ON otp_request_events (phone, purpose, created_at DESC);

-- Canonical Phase 1 goal catalog. Codes are stable API identifiers; UUIDs are
-- deterministic product identifiers so development, test and production all
-- refer to the same approved goal records.
CREATE TABLE goal_categories (
    id UUID PRIMARY KEY,
    code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
    slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
    name TEXT NOT NULL,
    display_order SMALLINT NOT NULL CHECK (display_order >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_goal_categories_active_order
    ON goal_categories (is_active, display_order, code);

CREATE TABLE saving_goals (
    id UUID PRIMARY KEY,
    category_id UUID NOT NULL REFERENCES goal_categories(id) ON DELETE RESTRICT,
    code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
    slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
    name TEXT NOT NULL,
    description TEXT,
    display_order SMALLINT NOT NULL CHECK (display_order >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_saving_goal_category_order UNIQUE (category_id, display_order)
);
CREATE INDEX idx_saving_goals_category_active_order
    ON saving_goals (category_id, is_active, display_order, code);

INSERT INTO goal_categories (id, code, slug, name, display_order) VALUES
    ('10000000-0000-4000-8000-000000000001', 'home_appliances', 'home-appliances', 'Home Appliances', 10),
    ('10000000-0000-4000-8000-000000000002', 'travel', 'travel', 'Travel', 20),
    ('10000000-0000-4000-8000-000000000003', 'education', 'education', 'Education', 30),
    ('10000000-0000-4000-8000-000000000004', 'personal', 'personal', 'Personal', 40);

INSERT INTO saving_goals (id, category_id, code, slug, name, display_order) VALUES
    ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'washing_machine', 'washing-machine', 'Washing Machine', 10),
    ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'fridge', 'fridge', 'Fridge', 20),
    ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'tv', 'tv', 'TV', 30),
    ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'cooker', 'cooker', 'Cooker', 40),
    ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000002', 'diani', 'diani', 'Diani', 10),
    ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000002', 'zanzibar', 'zanzibar', 'Zanzibar', 20),
    ('20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000002', 'dubai', 'dubai', 'Dubai', 30),
    ('20000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000002', 'maasai_mara', 'maasai-mara', 'Maasai Mara', 40),
    ('20000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000003', 'school_fees', 'school-fees', 'School Fees', 10),
    ('20000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000003', 'professional_course', 'professional-course', 'Professional Course', 20),
    ('20000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000003', 'university_fees', 'university-fees', 'University Fees', 30),
    ('20000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000004', 'laptop', 'laptop', 'Laptop', 10),
    ('20000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000004', 'phone', 'phone', 'Phone', 20),
    ('20000000-0000-4000-8000-000000000014', '10000000-0000-4000-8000-000000000004', 'furniture', 'furniture', 'Furniture', 30);

CREATE TABLE chamas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    type chama_type NOT NULL,
    status chama_status NOT NULL DEFAULT 'active',
    visibility chama_visibility NOT NULL DEFAULT 'application',
    goal_code TEXT REFERENCES saving_goals(code) ON UPDATE CASCADE ON DELETE RESTRICT,
    location TEXT,
    logo_url TEXT,
    target_members INTEGER CHECK (target_members IS NULL OR target_members >= 2),
    recruitment_deadline DATE,
    recruitment_closed_at TIMESTAMPTZ,
    saving_start_date DATE,
    saving_end_date DATE,
    purchase_window_start DATE,
    purchase_window_end DATE,
    contribution_amount BIGINT NOT NULL CHECK (contribution_amount > 0),
    contribution_frequency TEXT NOT NULL,
    meeting_schedule TEXT,
    target_amount BIGINT CHECK (target_amount IS NULL OR target_amount > 0),
    pooled_amount BIGINT NOT NULL DEFAULT 0 CHECK (pooled_amount >= 0),
    currency TEXT NOT NULL DEFAULT 'KES',
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_chama_saving_period CHECK (
        saving_start_date IS NULL OR saving_end_date IS NULL OR saving_end_date >= saving_start_date
    ),
    CONSTRAINT chk_chama_purchase_window CHECK (
        purchase_window_start IS NULL OR purchase_window_end IS NULL OR purchase_window_end >= purchase_window_start
    )
);
CREATE INDEX idx_chamas_status ON chamas (status);
CREATE INDEX idx_chamas_created_by ON chamas (created_by);
CREATE INDEX idx_chamas_marketplace ON chamas (status, visibility, type);
CREATE INDEX idx_chamas_public_discovery
    ON chamas (goal_code, status, visibility, contribution_amount)
    WHERE visibility IN ('public', 'application');
CREATE INDEX idx_chamas_goal_marketplace_metrics
    ON chamas (goal_code, status, currency) INCLUDE (target_amount)
    WHERE goal_code IS NOT NULL
      AND visibility IN ('public', 'application')
      AND status IN ('recruiting', 'active');
CREATE INDEX idx_chamas_recruitment_deadline ON chamas (recruitment_deadline) WHERE recruitment_deadline IS NOT NULL;
CREATE INDEX idx_chamas_recruitment_closed_at ON chamas (recruitment_closed_at) WHERE recruitment_closed_at IS NOT NULL;
CREATE INDEX idx_chamas_saving_period ON chamas (saving_start_date, saving_end_date)
    WHERE saving_start_date IS NOT NULL AND saving_end_date IS NOT NULL;

-- An accounting transaction is only valid when its entries balance.  It is
-- deliberately separate from operational payment tables so every movement of
-- pooled funds has a durable, auditable accounting record.
CREATE TABLE ledger_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_type TEXT NOT NULL CHECK (operation_type IN (
        'deposit', 'payout', 'transfer', 'manual_adjustment',
        'contribution_penalty', 'loan_interest',
        'commitment_hold', 'commitment_refund', 'commitment_forfeiture',
        'loan_disbursement', 'loan_repayment', 'loan_default_recovery',
        'platform_fee'
    )),
    reference TEXT NOT NULL UNIQUE,
    initiated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ledger_transactions_created_at ON ledger_transactions (created_at DESC);

-- Entries are append-only. Amounts are positive and the side determines the
-- sign; for each ledger transaction, total debits must equal total credits.
CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ledger_transaction_id UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE RESTRICT,
    account ledger_account NOT NULL,
    side ledger_entry_side NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL DEFAULT 'KES',
    member_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ledger_entries_transaction_id ON ledger_entries (ledger_transaction_id);
CREATE INDEX idx_ledger_entries_chama_account ON ledger_entries (chama_id, account, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger records are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_transactions_immutable
BEFORE UPDATE OR DELETE ON ledger_transactions
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER trg_ledger_entries_immutable
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE OR REPLACE FUNCTION assert_ledger_transaction_balanced()
RETURNS TRIGGER AS $$
DECLARE
    entry_count INTEGER;
    net_amount NUMERIC;
BEGIN
    SELECT COUNT(*), COALESCE(SUM(
        CASE WHEN side = 'debit' THEN amount ELSE -amount END
    ), 0)
    INTO entry_count, net_amount
    FROM ledger_entries
    WHERE ledger_transaction_id = NEW.ledger_transaction_id;

    IF entry_count < 2 OR net_amount <> 0 THEN
        RAISE EXCEPTION 'ledger transaction % is not balanced', NEW.ledger_transaction_id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Deferred so the two sides can be inserted in one transaction; checked at
-- COMMIT, which turns an incomplete journal into a full rollback.
CREATE CONSTRAINT TRIGGER trg_ledger_entries_balanced
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();


-- Provider reconciliation is intentionally provider-agnostic. External adapters
-- (M-Pesa, bank, custody partner) fetch records and the application records a
-- durable comparison result here. This allows Phase 1 to be complete before a
-- specific provider is contracted.
CREATE TYPE ledger_reconciliation_item_status AS ENUM (
    'matched',
    'missing_ledger',
    'missing_provider',
    'amount_mismatch',
    'currency_mismatch'
);

CREATE TABLE ledger_reconciliation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    provider_record_count INTEGER NOT NULL DEFAULT 0 CHECK (provider_record_count >= 0),
    matched_count INTEGER NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
    mismatch_count INTEGER NOT NULL DEFAULT 0 CHECK (mismatch_count >= 0),
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    CONSTRAINT chk_reconciliation_window CHECK (window_end > window_start)
);
CREATE INDEX idx_ledger_reconciliation_runs_provider_window
    ON ledger_reconciliation_runs (provider, window_start DESC, window_end DESC);

CREATE TABLE ledger_reconciliation_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ledger_reconciliation_runs(id) ON DELETE CASCADE,
    ledger_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    provider_reference TEXT NOT NULL,
    status ledger_reconciliation_item_status NOT NULL,
    provider_amount BIGINT CHECK (provider_amount IS NULL OR provider_amount > 0),
    ledger_amount BIGINT CHECK (ledger_amount IS NULL OR ledger_amount > 0),
    provider_currency TEXT,
    ledger_currency TEXT,
    provider_occurred_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_ledger_reconciliation_item UNIQUE (run_id, provider_reference)
);
CREATE INDEX idx_ledger_reconciliation_items_run_status
    ON ledger_reconciliation_items (run_id, status);
CREATE INDEX idx_ledger_reconciliation_items_ledger_transaction
    ON ledger_reconciliation_items (ledger_transaction_id)
    WHERE ledger_transaction_id IS NOT NULL;

CREATE TRIGGER trg_ledger_reconciliation_items_immutable
BEFORE UPDATE OR DELETE ON ledger_reconciliation_items
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category audit_event_category NOT NULL,
    action TEXT NOT NULL,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_role audit_actor_role,
    chama_id UUID REFERENCES chamas(id) ON DELETE SET NULL,
    entity_type TEXT,
    entity_id UUID,
    ip_address INET,
    user_agent TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_audit_logs_actor_id ON audit_logs (actor_id);
CREATE INDEX idx_audit_logs_chama_id ON audit_logs (chama_id);
CREATE INDEX idx_audit_logs_category ON audit_logs (category);
CREATE INDEX idx_audit_logs_action ON audit_logs (action);
CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at);

CREATE TRIGGER trg_audit_logs_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE OR REPLACE FUNCTION require_ledger_for_treasury_update()
RETURNS TRIGGER AS $$
DECLARE
    current_ledger_transaction_id UUID;
    balance_delta BIGINT;
    required_side ledger_entry_side;
BEGIN
    IF NEW.pooled_amount = OLD.pooled_amount THEN
        RETURN NEW;
    END IF;

    current_ledger_transaction_id := NULLIF(
        current_setting('app.ledger_transaction_id', TRUE), ''
    )::UUID;
    balance_delta := NEW.pooled_amount - OLD.pooled_amount;
    required_side := CASE WHEN balance_delta > 0 THEN 'debit' ELSE 'credit' END;

    IF current_ledger_transaction_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM ledger_entries
        WHERE ledger_transaction_id = current_ledger_transaction_id
          AND chama_id = NEW.id
          AND account = 'chama_treasury'
          AND side = required_side
          AND amount = ABS(balance_delta)
    ) THEN
        RAISE EXCEPTION 'pooled_amount may only change with a matching treasury ledger entry';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_chamas_require_ledger_for_treasury_update
BEFORE UPDATE OF pooled_amount ON chamas
FOR EACH ROW EXECUTE FUNCTION require_ledger_for_treasury_update();

CREATE TABLE chama_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role member_role NOT NULL DEFAULT 'member',
    membership_status membership_status NOT NULL DEFAULT 'pending',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    exit_date TIMESTAMPTZ,
    commitment_status member_commitment_status NOT NULL DEFAULT 'ON_TRACK',
    commitment_status_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_chama_member UNIQUE (chama_id, user_id),
    CONSTRAINT uq_chama_member_identity UNIQUE (id, chama_id),
    CONSTRAINT uq_chama_member_full_identity UNIQUE (id, chama_id, user_id)
);
CREATE INDEX idx_chama_members_chama_id ON chama_members (chama_id);
CREATE INDEX idx_chama_members_user_id ON chama_members (user_id);
CREATE INDEX idx_chama_members_commitment_status ON chama_members (chama_id, commitment_status, membership_status);

COMMENT ON COLUMN chama_members.role IS
    'member means no official office; treasurer, secretary and chairperson each represent the single official office held by a membership and inherit Member capabilities';
COMMENT ON COLUMN users.is_platform_admin IS
    'Platform-scoped administrator flag. Never derive or grant this privilege from chama_members.role';

-- BE-32 governed trust-score domain. Member trust is membership/Chama-scoped;
-- Chama trust is Chama-scoped. No formula row is seeded: production scoring
-- remains disabled until founder/product sign-off creates and activates a
-- versioned definition.
CREATE TABLE trust_score_formula_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_type trust_score_subject NOT NULL,
    version TEXT NOT NULL UNIQUE CHECK (version ~ '^[a-z0-9][a-z0-9._-]*$'),
    status trust_score_formula_status NOT NULL DEFAULT 'draft',
    public_description TEXT NOT NULL,
    inputs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(inputs) = 'array'),
    weights JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(weights) = 'object'),
    levels JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(levels) = 'array'),
    definition_hash TEXT NOT NULL UNIQUE CHECK (length(definition_hash) >= 32),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    activated_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_trust_formula_id_subject UNIQUE (id, subject_type),
    CONSTRAINT chk_trust_formula_approval CHECK (
        (status = 'draft' AND approved_at IS NULL AND approved_by IS NULL)
        OR (status IN ('approved', 'active', 'retired') AND approved_at IS NOT NULL AND approved_by IS NOT NULL)
    ),
    CONSTRAINT chk_trust_formula_activation CHECK (
        status <> 'active' OR activated_at IS NOT NULL
    ),
    CONSTRAINT chk_trust_formula_retirement CHECK (
        status <> 'retired' OR retired_at IS NOT NULL
    ),
    CONSTRAINT chk_trust_formula_documented_definition CHECK (
        status = 'draft'
        OR (jsonb_array_length(inputs) > 0
            AND weights <> '{}'::jsonb
            AND jsonb_array_length(levels) > 0
            AND length(trim(public_description)) > 0)
    )
);
CREATE UNIQUE INDEX uq_trust_formula_one_active_subject
    ON trust_score_formula_versions (subject_type) WHERE status = 'active';
CREATE INDEX idx_trust_formula_subject_status
    ON trust_score_formula_versions (subject_type, status, created_at DESC);

CREATE OR REPLACE FUNCTION protect_trust_formula_version()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status <> 'draft' AND (
        NEW.subject_type IS DISTINCT FROM OLD.subject_type
        OR NEW.version IS DISTINCT FROM OLD.version
        OR NEW.public_description IS DISTINCT FROM OLD.public_description
        OR NEW.inputs IS DISTINCT FROM OLD.inputs
        OR NEW.weights IS DISTINCT FROM OLD.weights
        OR NEW.levels IS DISTINCT FROM OLD.levels
        OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
    ) THEN
        RAISE EXCEPTION 'Approved trust-score formula definitions are immutable; create a new version';
    END IF;

    IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
        RAISE EXCEPTION 'Retired trust-score formula versions cannot be reactivated';
    END IF;
    IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'retired') THEN
        RAISE EXCEPTION 'Active trust-score formula versions may only remain active or retire';
    END IF;
    IF OLD.status = 'approved' AND NEW.status NOT IN ('approved', 'active', 'retired') THEN
        RAISE EXCEPTION 'Approved trust-score formula versions cannot return to draft';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_trust_formula_version_protection
BEFORE UPDATE ON trust_score_formula_versions
FOR EACH ROW EXECUTE FUNCTION protect_trust_formula_version();

CREATE TABLE trust_score_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_type trust_score_subject NOT NULL,
    formula_version_id UUID NOT NULL,
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
    membership_id UUID,
    score NUMERIC(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
    level TEXT NOT NULL CHECK (length(trim(level)) > 0),
    factors JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(factors) = 'array'),
    calculation_key TEXT NOT NULL UNIQUE CHECK (length(calculation_key) >= 16),
    source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) >= 32),
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_trust_snapshot_formula_subject
        FOREIGN KEY (formula_version_id, subject_type)
        REFERENCES trust_score_formula_versions(id, subject_type) ON DELETE RESTRICT,
    CONSTRAINT fk_trust_snapshot_membership_chama
        FOREIGN KEY (membership_id, chama_id)
        REFERENCES chama_members(id, chama_id) ON DELETE CASCADE,
    CONSTRAINT chk_trust_snapshot_subject CHECK (
        (subject_type = 'member' AND membership_id IS NOT NULL)
        OR (subject_type = 'chama' AND membership_id IS NULL)
    )
);
CREATE INDEX idx_trust_snapshots_member_current
    ON trust_score_snapshots (membership_id, calculated_at DESC, id DESC)
    WHERE subject_type = 'member';
CREATE INDEX idx_trust_snapshots_chama_current
    ON trust_score_snapshots (chama_id, calculated_at DESC, id DESC)
    WHERE subject_type = 'chama';
CREATE INDEX idx_trust_snapshots_formula_version
    ON trust_score_snapshots (formula_version_id, calculated_at DESC);

-- Snapshots are historical evidence. A correction creates a new snapshot; old
-- rows cannot be edited or deleted.
CREATE TRIGGER trg_trust_score_snapshots_immutable
BEFORE UPDATE OR DELETE ON trust_score_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE OR REPLACE FUNCTION audit_trust_score_snapshot_insert()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO audit_logs (
        category, action, actor_role, chama_id, entity_type, entity_id, payload
    ) VALUES (
        'system',
        'trust_score_snapshot_created',
        'system',
        NEW.chama_id,
        'trust_score_snapshot',
        NEW.id,
        jsonb_build_object(
            'subjectType', NEW.subject_type,
            'membershipId', NEW.membership_id,
            'formulaVersionId', NEW.formula_version_id,
            'score', NEW.score,
            'level', NEW.level,
            'calculationKey', NEW.calculation_key,
            'sourceFingerprint', NEW.source_fingerprint,
            'calculatedAt', NEW.calculated_at
        )
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_trust_score_snapshot_audit
AFTER INSERT ON trust_score_snapshots
FOR EACH ROW EXECUTE FUNCTION audit_trust_score_snapshot_insert();


-- BE-33 partner merchant and reward domain. Merchant commerce is intentionally
-- separate from Chama pooled-fund accounting; these tables never mutate pooled_amount.
CREATE TABLE partner_merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT,
    logo_url TEXT,
    website_url TEXT,
    status merchant_status NOT NULL DEFAULT 'draft',
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_partner_merchants_status ON partner_merchants (status, name);

CREATE TABLE goal_merchant_partnerships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    goal_id UUID NOT NULL REFERENCES saving_goals(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL REFERENCES partner_merchants(id) ON DELETE RESTRICT,
    status merchant_partnership_status NOT NULL DEFAULT 'draft',
    offer_title TEXT NOT NULL CHECK (length(trim(offer_title)) > 0),
    offer_summary TEXT NOT NULL CHECK (length(trim(offer_summary)) > 0),
    offer_terms TEXT,
    reward_rules JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reward_rules) = 'object'),
    valid_from TIMESTAMPTZ,
    valid_until TIMESTAMPTZ,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_goal_merchant_partnership_window CHECK (
        valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from
    )
);
CREATE INDEX idx_goal_merchant_partnerships_goal_status
    ON goal_merchant_partnerships (goal_id, status, valid_from, valid_until, merchant_id);
CREATE INDEX idx_goal_merchant_partnerships_merchant
    ON goal_merchant_partnerships (merchant_id, status);

CREATE TABLE member_merchant_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    membership_id UUID NOT NULL REFERENCES chama_members(id) ON DELETE CASCADE,
    partnership_id UUID NOT NULL REFERENCES goal_merchant_partnerships(id) ON DELETE RESTRICT,
    state merchant_reward_state NOT NULL DEFAULT 'locked',
    eligibility_source TEXT,
    eligibility_reference TEXT,
    eligibility_fingerprint TEXT CHECK (eligibility_fingerprint IS NULL OR length(eligibility_fingerprint) >= 32),
    eligible_at TIMESTAMPTZ,
    redemption_source TEXT,
    redemption_reference TEXT,
    redemption_fingerprint TEXT CHECK (redemption_fingerprint IS NULL OR length(redemption_fingerprint) >= 32),
    redeemed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_member_merchant_reward UNIQUE (membership_id, partnership_id),
    CONSTRAINT chk_member_reward_locked CHECK (
        state <> 'locked'
        OR (eligibility_source IS NULL AND eligibility_reference IS NULL AND eligibility_fingerprint IS NULL
            AND eligible_at IS NULL AND redemption_source IS NULL AND redemption_reference IS NULL
            AND redemption_fingerprint IS NULL AND redeemed_at IS NULL)
    ),
    CONSTRAINT chk_member_reward_eligibility CHECK (
        state NOT IN ('eligible', 'redeemed')
        OR (eligibility_source IS NOT NULL AND eligibility_reference IS NOT NULL
            AND eligibility_fingerprint IS NOT NULL AND eligible_at IS NOT NULL)
    ),
    CONSTRAINT chk_member_reward_redemption CHECK (
        state <> 'redeemed'
        OR (redemption_source IS NOT NULL AND redemption_reference IS NOT NULL
            AND redemption_fingerprint IS NOT NULL AND redeemed_at IS NOT NULL)
    )
);
CREATE INDEX idx_member_merchant_rewards_membership
    ON member_merchant_rewards (membership_id, state, partnership_id);
CREATE UNIQUE INDEX uq_member_merchant_rewards_redemption_reference
    ON member_merchant_rewards (redemption_reference) WHERE redemption_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_member_merchant_reward_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.state = OLD.state THEN
        RETURN NEW;
    END IF;

    IF OLD.state = 'locked' AND NEW.state NOT IN ('eligible', 'expired', 'revoked') THEN
        RAISE EXCEPTION 'Invalid merchant reward transition from locked to %', NEW.state;
    END IF;
    IF OLD.state = 'eligible' AND NEW.state NOT IN ('redeemed', 'expired', 'revoked') THEN
        RAISE EXCEPTION 'Invalid merchant reward transition from eligible to %', NEW.state;
    END IF;
    IF OLD.state IN ('redeemed', 'expired', 'revoked') THEN
        RAISE EXCEPTION 'Terminal merchant reward state % cannot transition', OLD.state;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_member_merchant_reward_transition
BEFORE UPDATE OF state ON member_merchant_rewards
FOR EACH ROW EXECUTE FUNCTION enforce_member_merchant_reward_transition();

CREATE OR REPLACE FUNCTION audit_goal_merchant_partnership_change()
RETURNS TRIGGER AS $$
DECLARE
    old_status TEXT;
    audit_action TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        old_status := NULL;
        audit_action := 'merchant_partnership_created';
    ELSE
        old_status := OLD.status::text;
        audit_action := 'merchant_partnership_status_changed';
    END IF;

    INSERT INTO audit_logs (
        category, action, actor_role, entity_type, entity_id, payload
    ) VALUES (
        'system', audit_action, 'system', 'goal_merchant_partnership', NEW.id,
        jsonb_build_object(
            'goalId', NEW.goal_id,
            'merchantId', NEW.merchant_id,
            'oldStatus', old_status,
            'newStatus', NEW.status,
            'validFrom', NEW.valid_from,
            'validUntil', NEW.valid_until
        )
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_goal_merchant_partnership_audit
AFTER INSERT OR UPDATE OF status ON goal_merchant_partnerships
FOR EACH ROW EXECUTE FUNCTION audit_goal_merchant_partnership_change();

CREATE OR REPLACE FUNCTION audit_member_merchant_reward_change()
RETURNS TRIGGER AS $$
DECLARE
    target_chama_id UUID;
    old_state TEXT;
    audit_action TEXT;
BEGIN
    SELECT chama_id INTO target_chama_id
    FROM chama_members
    WHERE id = NEW.membership_id;

    IF TG_OP = 'INSERT' THEN
        old_state := NULL;
        audit_action := 'merchant_reward_created';
    ELSE
        old_state := OLD.state::text;
        audit_action := 'merchant_reward_state_changed';
    END IF;

    INSERT INTO audit_logs (
        category, action, actor_role, chama_id, entity_type, entity_id, payload
    ) VALUES (
        'system', audit_action, 'system', target_chama_id, 'member_merchant_reward', NEW.id,
        jsonb_build_object(
            'membershipId', NEW.membership_id,
            'partnershipId', NEW.partnership_id,
            'oldState', old_state,
            'newState', NEW.state,
            'eligibilityReference', NEW.eligibility_reference,
            'redemptionReference', NEW.redemption_reference
        )
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_member_merchant_reward_audit
AFTER INSERT OR UPDATE OF state ON member_merchant_rewards
FOR EACH ROW EXECUTE FUNCTION audit_member_merchant_reward_change();

ALTER TABLE ledger_entries
    ADD CONSTRAINT fk_ledger_entries_member
    FOREIGN KEY (member_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE RESTRICT;

CREATE TABLE chama_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
    applicant_id UUID REFERENCES users(id) ON DELETE CASCADE,
    recipient_phone TEXT,
    recipient_email TEXT,
    invite_token_hash TEXT UNIQUE,
    requested_role member_role NOT NULL DEFAULT 'member',
    message TEXT,
    status invitation_status NOT NULL DEFAULT 'pending',
    max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
    use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    expires_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_chama_invitation_recipient CHECK (
        applicant_id IS NOT NULL OR recipient_phone IS NOT NULL OR recipient_email IS NOT NULL OR invite_token_hash IS NOT NULL
    ),
    CONSTRAINT chk_chama_invitation_use_count CHECK (use_count <= max_uses)
);
CREATE INDEX idx_chama_invitations_chama_id ON chama_invitations (chama_id);
CREATE INDEX idx_chama_invitations_applicant_id ON chama_invitations (applicant_id) WHERE applicant_id IS NOT NULL;
CREATE INDEX idx_chama_invitations_phone ON chama_invitations (recipient_phone) WHERE recipient_phone IS NOT NULL;
CREATE INDEX idx_chama_invitations_status ON chama_invitations (status);
CREATE INDEX idx_chama_invitations_expiry ON chama_invitations (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE chama_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT,
    status application_status NOT NULL DEFAULT 'pending',
    chama_rule_id UUID,
    constitution_accepted_at TIMESTAMPTZ,
    constitution_acceptance_ip INET,
    constitution_acceptance_user_agent TEXT,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_chama_application_constitution_acceptance CHECK (
        (chama_rule_id IS NULL AND constitution_accepted_at IS NULL)
        OR (chama_rule_id IS NOT NULL AND constitution_accepted_at IS NOT NULL)
    ),
    CONSTRAINT uq_chama_application_full_identity UNIQUE (id, chama_id, user_id)
);
CREATE INDEX idx_chama_applications_chama_status ON chama_applications (chama_id, status, created_at DESC);
CREATE INDEX idx_chama_applications_user ON chama_applications (user_id, created_at DESC);
CREATE UNIQUE INDEX uq_chama_application_pending
    ON chama_applications (chama_id, user_id) WHERE status = 'pending';

-- Versioned, machine-readable Chama Constitution and non-loan policy snapshot.
-- Financial/background services may continue reading their specialized rule tables,
-- while every membership acceptance points to an immutable Constitution version.
CREATE TABLE chama_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version >= 1),
    status constitution_status NOT NULL DEFAULT 'draft',
    template_code TEXT NOT NULL DEFAULT 'custom' CHECK (template_code IN ('custom','savings','goal_based','merry_go_round','investment')),
    purpose_goal TEXT NOT NULL DEFAULT '',
    contribution_amount BIGINT NOT NULL CHECK (contribution_amount > 0),
    contribution_frequency TEXT NOT NULL,
    contribution_due_day INTEGER CHECK (contribution_due_day IS NULL OR contribution_due_day BETWEEN 1 AND 31),
    late_fine_type TEXT NOT NULL DEFAULT 'flat' CHECK (late_fine_type IN ('flat', 'percentage')),
    late_fine_amount BIGINT NOT NULL DEFAULT 0 CHECK (late_fine_amount >= 0),
    late_fine_percentage NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (late_fine_percentage BETWEEN 0 AND 100),
    commitment_amount BIGINT NOT NULL DEFAULT 500 CHECK (commitment_amount >= 0),
    default_grace_period_days INTEGER NOT NULL DEFAULT 0 CHECK (default_grace_period_days >= 0),
    default_after_consecutive_misses INTEGER NOT NULL DEFAULT 3 CHECK (default_after_consecutive_misses >= 1),
    quorum_threshold_pct NUMERIC(5,2) NOT NULL DEFAULT 50 CHECK (quorum_threshold_pct BETWEEN 0 AND 100),
    majority_threshold_pct NUMERIC(5,2) NOT NULL DEFAULT 50 CHECK (majority_threshold_pct > 0 AND majority_threshold_pct <= 100),
    exit_withdrawal_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
    payout_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
    conduct_dispute_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
    dissolution_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    effective_from TIMESTAMPTZ,
    supersedes_id UUID REFERENCES chama_rules(id) ON DELETE SET NULL,
    amendment_summary TEXT,
    amendment_poll_id UUID,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (chama_id, version),
    UNIQUE (id, chama_id)
);
CREATE INDEX idx_chama_rules_history ON chama_rules (chama_id, version DESC);
CREATE UNIQUE INDEX uq_chama_rules_active ON chama_rules (chama_id) WHERE status = 'active';

ALTER TABLE chama_applications
    ADD CONSTRAINT fk_chama_applications_rule
    FOREIGN KEY (chama_rule_id, chama_id) REFERENCES chama_rules(id, chama_id) ON DELETE RESTRICT;

CREATE TABLE membership_constitution_acceptances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
    membership_id UUID NOT NULL,
    chama_rule_id UUID NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ip_address INET,
    user_agent TEXT,
    UNIQUE (membership_id, chama_rule_id),
    FOREIGN KEY (membership_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE CASCADE,
    FOREIGN KEY (chama_rule_id, chama_id) REFERENCES chama_rules(id, chama_id) ON DELETE RESTRICT
);
CREATE INDEX idx_membership_constitution_acceptances_membership
    ON membership_constitution_acceptances (membership_id, accepted_at DESC);

-- BE-34 commitment alignment. The amount remains Constitution-backed because the
-- product decision on platform-wide fixed vs configurable KSh 500 is still open.
-- Phase 1 rules default to 500, but financial transitions never trust the client.
CREATE TABLE commitment_deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    membership_id UUID NOT NULL,
    application_id UUID NOT NULL,
    chama_rule_id UUID NOT NULL,
    cycle_no INTEGER NOT NULL DEFAULT 1 CHECK (cycle_no >= 1),
    amount BIGINT NOT NULL CHECK (amount > 0),
    state commitment_state NOT NULL DEFAULT 'applied',
    provider TEXT,
    provider_reference TEXT,
    terminal_provider TEXT,
    terminal_provider_reference TEXT,
    last_transition_source TEXT NOT NULL DEFAULT 'join_flow' CHECK (length(trim(last_transition_source)) > 0),
    last_transition_reference TEXT NOT NULL CHECK (length(trim(last_transition_reference)) > 0),
    forfeited_amount BIGINT NOT NULL DEFAULT 0 CHECK (forfeited_amount >= 0),
    refunded_amount BIGINT NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
    hold_ledger_transaction_id UUID UNIQUE REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    terminal_ledger_transaction_id UUID UNIQUE REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    held_at TIMESTAMPTZ,
    at_risk_at TIMESTAMPTZ,
    default_triggered_at TIMESTAMPTZ,
    eligible_for_refund_at TIMESTAMPTZ,
    refund_requested_at TIMESTAMPTZ,
    refunded_at TIMESTAMPTZ,
    forfeited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_commitment_deposit_cycle UNIQUE (membership_id, cycle_no),
    CONSTRAINT chk_commitment_deposit_terminal_amounts CHECK (
        forfeited_amount + refunded_amount <= amount
    ),
    CONSTRAINT chk_commitment_hold_provider_pair CHECK (
        (provider IS NULL AND provider_reference IS NULL)
        OR (provider IS NOT NULL AND provider_reference IS NOT NULL)
    ),
    CONSTRAINT chk_commitment_terminal_provider_pair CHECK (
        (terminal_provider IS NULL AND terminal_provider_reference IS NULL)
        OR (terminal_provider IS NOT NULL AND terminal_provider_reference IS NOT NULL)
    ),
    FOREIGN KEY (membership_id, chama_id, user_id)
        REFERENCES chama_members(id, chama_id, user_id) ON DELETE RESTRICT,
    FOREIGN KEY (application_id, chama_id, user_id)
        REFERENCES chama_applications(id, chama_id, user_id) ON DELETE RESTRICT,
    FOREIGN KEY (chama_rule_id, chama_id)
        REFERENCES chama_rules(id, chama_id) ON DELETE RESTRICT
);
CREATE INDEX idx_commitment_deposits_chama_state ON commitment_deposits (chama_id, state);
CREATE INDEX idx_commitment_deposits_membership ON commitment_deposits (membership_id, created_at DESC);
CREATE INDEX idx_commitment_deposits_application ON commitment_deposits (application_id);
CREATE UNIQUE INDEX uq_commitment_deposits_provider_reference
    ON commitment_deposits (provider, provider_reference)
    WHERE provider IS NOT NULL AND provider_reference IS NOT NULL;
CREATE UNIQUE INDEX uq_commitment_deposits_terminal_provider_reference
    ON commitment_deposits (terminal_provider, terminal_provider_reference)
    WHERE terminal_provider IS NOT NULL AND terminal_provider_reference IS NOT NULL;
CREATE UNIQUE INDEX uq_commitment_deposits_live_membership
    ON commitment_deposits (membership_id)
    WHERE state IN ('applied', 'held', 'at_risk', 'default_triggered', 'eligible_for_refund', 'refund_requested');

CREATE OR REPLACE FUNCTION enforce_commitment_deposit_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.state <> 'applied' THEN
        RAISE EXCEPTION 'new commitment deposits must start in applied state';
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.state IS DISTINCT FROM OLD.state THEN
        IF NOT (
            (OLD.state = 'applied' AND NEW.state = 'held')
            OR (OLD.state = 'held' AND NEW.state IN ('at_risk', 'eligible_for_refund'))
            OR (OLD.state = 'at_risk' AND NEW.state IN ('held', 'default_triggered', 'eligible_for_refund'))
            OR (OLD.state = 'default_triggered' AND NEW.state = 'forfeited')
            OR (OLD.state = 'eligible_for_refund' AND NEW.state = 'refund_requested')
            OR (OLD.state = 'refund_requested' AND NEW.state = 'refunded')
        ) THEN
            RAISE EXCEPTION 'invalid commitment transition: % -> %', OLD.state, NEW.state;
        END IF;
    END IF;

    IF NEW.state <> 'applied' AND NEW.hold_ledger_transaction_id IS NULL THEN
        RAISE EXCEPTION 'held commitment states require the hold ledger transaction';
    END IF;
    IF NEW.state <> 'applied' AND (NEW.provider IS NULL OR NEW.provider_reference IS NULL OR NEW.held_at IS NULL) THEN
        RAISE EXCEPTION 'held commitment states require provider confirmation';
    END IF;
    IF NEW.state = 'at_risk' AND NEW.at_risk_at IS NULL THEN
        RAISE EXCEPTION 'at_risk commitment requires at_risk_at';
    END IF;
    IF NEW.state = 'default_triggered' AND NEW.default_triggered_at IS NULL THEN
        RAISE EXCEPTION 'default_triggered commitment requires default_triggered_at';
    END IF;
    IF NEW.state = 'eligible_for_refund' AND NEW.eligible_for_refund_at IS NULL THEN
        RAISE EXCEPTION 'eligible_for_refund commitment requires eligibility timestamp';
    END IF;
    IF NEW.state = 'refund_requested' AND NEW.refund_requested_at IS NULL THEN
        RAISE EXCEPTION 'refund_requested commitment requires request timestamp';
    END IF;
    IF NEW.state = 'refunded' THEN
        IF NEW.terminal_ledger_transaction_id IS NULL OR NEW.terminal_provider IS NULL
           OR NEW.terminal_provider_reference IS NULL OR NEW.refunded_at IS NULL
           OR NEW.refunded_amount <= 0 OR NEW.refunded_amount + NEW.forfeited_amount <> NEW.amount THEN
            RAISE EXCEPTION 'refunded commitment requires a complete terminal refund ledger record';
        END IF;
    END IF;
    IF NEW.state = 'forfeited' THEN
        IF NEW.terminal_ledger_transaction_id IS NULL OR NEW.terminal_provider IS NULL
           OR NEW.terminal_provider_reference IS NULL OR NEW.forfeited_at IS NULL
           OR NEW.forfeited_amount <> NEW.amount THEN
            RAISE EXCEPTION 'forfeited commitment requires a complete terminal forfeiture ledger record';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_commitment_deposit_transition
BEFORE INSERT OR UPDATE ON commitment_deposits
FOR EACH ROW EXECUTE FUNCTION enforce_commitment_deposit_transition();

CREATE OR REPLACE FUNCTION audit_commitment_deposit_change()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO audit_logs (
        category, action, actor_role, chama_id, entity_type, entity_id, payload
    ) VALUES (
        'financial',
        CASE WHEN TG_OP = 'INSERT' THEN 'commitment_deposit_created' ELSE 'commitment_state_changed' END,
        'system',
        NEW.chama_id,
        'commitment_deposit',
        NEW.id,
        jsonb_build_object(
            'oldState', CASE WHEN TG_OP = 'UPDATE' THEN OLD.state ELSE NULL END,
            'newState', NEW.state,
            'userId', NEW.user_id,
            'membershipId', NEW.membership_id,
            'applicationId', NEW.application_id,
            'chamaRuleId', NEW.chama_rule_id,
            'cycleNo', NEW.cycle_no,
            'amount', NEW.amount,
            'provider', NEW.provider,
            'providerReference', NEW.provider_reference,
            'holdLedgerTransactionId', NEW.hold_ledger_transaction_id,
            'terminalLedgerTransactionId', NEW.terminal_ledger_transaction_id,
            'transitionSource', NEW.last_transition_source,
            'transitionReference', NEW.last_transition_reference
        )
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_commitment_deposit_audit_insert
AFTER INSERT ON commitment_deposits
FOR EACH ROW EXECUTE FUNCTION audit_commitment_deposit_change();

CREATE TRIGGER trg_commitment_deposit_audit_state
AFTER UPDATE OF state ON commitment_deposits
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION audit_commitment_deposit_change();

CREATE TABLE contribution_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL CHECK (amount > 0),
    frequency TEXT NOT NULL,
    due_day INTEGER CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),
    late_fee BIGINT NOT NULL DEFAULT 0 CHECK (late_fee >= 0),
    late_fee_type TEXT NOT NULL DEFAULT 'flat' CHECK (late_fee_type IN ('flat', 'percentage')),
    late_fee_percentage NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (late_fee_percentage BETWEEN 0 AND 100),
    grace_period_days INTEGER NOT NULL DEFAULT 0 CHECK (grace_period_days >= 0),
    effective_from DATE NOT NULL,
    effective_to DATE CHECK (effective_to IS NULL OR effective_to >= effective_from),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_contribution_rules_chama_id ON contribution_rules (chama_id);

CREATE TABLE contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE RESTRICT,
    member_id UUID NOT NULL REFERENCES chama_members(id) ON DELETE RESTRICT,
    expected_amount BIGINT NOT NULL CHECK (expected_amount > 0),
    due_date DATE NOT NULL,
    status contribution_status NOT NULL DEFAULT 'pending',
    period_label TEXT NOT NULL,
    penalty_checked_at TIMESTAMPTZ,
    missed_at TIMESTAMPTZ,
    consecutive_miss_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_miss_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id, chama_id, member_id),
    CONSTRAINT chk_contribution_miss_marker CHECK (
        (missed_at IS NULL AND consecutive_miss_count = 0)
        OR (missed_at IS NOT NULL AND consecutive_miss_count >= 1)
    ),
    FOREIGN KEY (member_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE RESTRICT
);
CREATE INDEX idx_contributions_chama_id ON contributions (chama_id);
CREATE INDEX idx_contributions_member_id ON contributions (member_id);
CREATE INDEX idx_contributions_status ON contributions (status);
CREATE INDEX idx_contributions_member_assessed_due
    ON contributions (member_id, due_date DESC, created_at DESC, id DESC)
    WHERE penalty_checked_at IS NOT NULL;

CREATE TABLE contribution_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contribution_id UUID NOT NULL REFERENCES contributions(id) ON DELETE RESTRICT,
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE RESTRICT,
    member_id UUID NOT NULL REFERENCES chama_members(id) ON DELETE RESTRICT,
    amount BIGINT NOT NULL CHECK (amount > 0),
    payment_method payment_method NOT NULL,
    provider TEXT,
    provider_reference TEXT UNIQUE,
    receipt_number TEXT UNIQUE,
    status payment_status NOT NULL DEFAULT 'pending',
    paid_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (member_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE RESTRICT,
    FOREIGN KEY (contribution_id, chama_id, member_id) REFERENCES contributions(id, chama_id, member_id) ON DELETE RESTRICT
);
CREATE INDEX idx_contribution_payments_contribution_id ON contribution_payments (contribution_id);
CREATE INDEX idx_contribution_payments_chama_id ON contribution_payments (chama_id);
CREATE INDEX idx_contribution_payments_member_id ON contribution_payments (member_id);

CREATE TABLE payment_provider_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    contribution_id UUID REFERENCES contributions(id) ON DELETE RESTRICT,
    chama_id UUID REFERENCES chamas(id) ON DELETE RESTRICT,
    member_id UUID REFERENCES chama_members(id) ON DELETE RESTRICT,
    merchant_request_id TEXT,
    checkout_request_id TEXT UNIQUE,
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
    phone_number TEXT NOT NULL,
    status payment_status NOT NULL DEFAULT 'pending',
    result_code INTEGER,
    result_desc TEXT,
    receipt_number TEXT UNIQUE,
    request_payload JSONB,
    raw_payload JSONB,
    callback_verified_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE RESTRICT,
    FOREIGN KEY (contribution_id, chama_id, member_id) REFERENCES contributions(id, chama_id, member_id) ON DELETE RESTRICT
);
CREATE INDEX idx_payment_provider_logs_user_id ON payment_provider_logs (user_id);
CREATE INDEX idx_payment_provider_logs_contribution_id ON payment_provider_logs (contribution_id);
CREATE INDEX idx_payment_provider_logs_status ON payment_provider_logs (status, created_at DESC);

CREATE TABLE loans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE RESTRICT,
    member_id UUID NOT NULL REFERENCES chama_members(id) ON DELETE RESTRICT,
    principal_amount BIGINT NOT NULL CHECK (principal_amount > 0),
    interest_rate NUMERIC(5,2) NOT NULL CHECK (interest_rate >= 0),
    total_due BIGINT NOT NULL CHECK (total_due > 0),
    purpose TEXT,
    application_date DATE NOT NULL DEFAULT CURRENT_DATE,
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    due_date DATE,
    interest_cycle_days INTEGER CHECK (interest_cycle_days BETWEEN 1 AND 3650),
    next_interest_date DATE,
    status loan_status NOT NULL DEFAULT 'pending',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE RESTRICT
);
CREATE INDEX idx_loans_chama_id ON loans (chama_id);
CREATE INDEX idx_loans_member_id ON loans (member_id);
CREATE INDEX idx_loans_status ON loans (status);

-- Each Chama sets its own lending policy; a loan cannot be applied for until this exists.
CREATE TABLE loan_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL UNIQUE REFERENCES chamas(id) ON DELETE CASCADE,
    interest_rate NUMERIC(5,2) NOT NULL CHECK (interest_rate >= 0),
    max_borrowing_multiplier NUMERIC(5,2) NOT NULL CHECK (max_borrowing_multiplier > 0),
    min_guarantors INTEGER NOT NULL DEFAULT 5 CHECK (min_guarantors >= 1),
    max_term_days INTEGER CHECK (max_term_days IS NULL OR max_term_days > 0),
    interest_cycle_days INTEGER CHECK (interest_cycle_days BETWEEN 1 AND 3650),
    late_repayment_penalty_type TEXT NOT NULL DEFAULT 'flat' CHECK (late_repayment_penalty_type IN ('flat', 'percentage')),
    late_repayment_penalty_amount BIGINT NOT NULL DEFAULT 0 CHECK (late_repayment_penalty_amount >= 0),
    late_repayment_penalty_percentage NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (late_repayment_penalty_percentage BETWEEN 0 AND 100),
    default_surcharge_percentage NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (default_surcharge_percentage BETWEEN 0 AND 100),
    default_grace_period_days INTEGER NOT NULL DEFAULT 0 CHECK (default_grace_period_days >= 0),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE loan_repayments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_id UUID NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
    amount BIGINT NOT NULL CHECK (amount > 0),
    payment_method payment_method NOT NULL,
    provider_reference TEXT UNIQUE,
    receipt_number TEXT UNIQUE,
    status repayment_status NOT NULL DEFAULT 'pending',
    verified_by UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_loan_repayments_loan_id ON loan_repayments (loan_id);

CREATE TABLE loan_guarantors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_id UUID NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES chama_members(id) ON DELETE CASCADE,
    guaranteed_amount BIGINT NOT NULL CHECK (guaranteed_amount > 0),
    approved_at TIMESTAMPTZ,
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT uq_loan_guarantor UNIQUE (loan_id, member_id)
);
CREATE INDEX idx_loan_guarantors_member_id ON loan_guarantors (member_id);

CREATE TABLE loan_interest_accruals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_id UUID NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
    cycle_date DATE NOT NULL,
    amount BIGINT NOT NULL CHECK (amount >= 0),
    ledger_transaction_id UUID UNIQUE REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (loan_id, cycle_date)
);

CREATE TABLE loan_disbursements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_id UUID NOT NULL UNIQUE REFERENCES loans(id) ON DELETE RESTRICT,
    amount BIGINT NOT NULL CHECK (amount > 0),
    phone_number TEXT NOT NULL,
    status payment_status NOT NULL DEFAULT 'pending',
    provider_reference TEXT UNIQUE,
    failure_reason TEXT,
    dispatched_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_loan_disbursements_status ON loan_disbursements (status);

CREATE TABLE penalties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE RESTRICT,
    member_id UUID NOT NULL REFERENCES chama_members(id) ON DELETE RESTRICT,
    contribution_id UUID REFERENCES contributions(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL CHECK (amount > 0),
    reason TEXT NOT NULL,
    ledger_transaction_id UUID UNIQUE REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE RESTRICT
);
CREATE INDEX idx_penalties_chama_id ON penalties (chama_id);
CREATE INDEX idx_penalties_member_id ON penalties (member_id);

CREATE TABLE reminder_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('contribution', 'loan')),
    entity_id UUID NOT NULL,
    due_date DATE NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'cancelled', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    lease_token UUID,
    locked_until TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (kind, entity_id, due_date, channel)
);
CREATE INDEX idx_reminder_deliveries_pending ON reminder_deliveries (available_at, id) WHERE status = 'pending';
CREATE INDEX idx_reminder_deliveries_processing ON reminder_deliveries (locked_until, id) WHERE status = 'processing';


-- Persistent scheduler telemetry for BE-21 system health. Domain jobs are still
-- idempotent in their own tables; this table records execution health only.
CREATE TABLE background_job_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_name TEXT NOT NULL CHECK (job_name IN ('financial','reminders','reports','meetings')),
    status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    failure_reason TEXT,
    CONSTRAINT chk_background_job_run_terminal CHECK (
        (status = 'running' AND completed_at IS NULL)
        OR (status IN ('succeeded','failed') AND completed_at IS NOT NULL)
    )
);
CREATE INDEX idx_background_job_runs_job_started ON background_job_runs (job_name, started_at DESC);
CREATE INDEX idx_background_job_runs_failed ON background_job_runs (started_at DESC) WHERE status = 'failed';
CREATE INDEX idx_background_job_runs_running ON background_job_runs (started_at) WHERE status = 'running';

CREATE TABLE merry_go_round_cycles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE RESTRICT,
    cycle_no INTEGER NOT NULL CHECK (cycle_no >= 1),
    generation_mode mgr_generation_mode NOT NULL,
    payout_amount BIGINT NOT NULL CHECK (payout_amount > 0),
    start_date DATE NOT NULL,
    interval_days INTEGER NOT NULL CHECK (interval_days BETWEEN 1 AND 3650),
    current_position INTEGER NOT NULL DEFAULT 1 CHECK (current_position >= 1),
    status mgr_cycle_status NOT NULL DEFAULT 'active',
    policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (chama_id, cycle_no),
    UNIQUE (id, chama_id)
);
CREATE UNIQUE INDEX uq_mgr_active_cycle_per_chama
    ON merry_go_round_cycles (chama_id) WHERE status = 'active';
CREATE INDEX idx_mgr_cycles_chama_status
    ON merry_go_round_cycles (chama_id, status, cycle_no DESC);

CREATE TABLE merry_go_round_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id UUID NOT NULL,
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE RESTRICT,
    member_id UUID NOT NULL REFERENCES chama_members(id) ON DELETE RESTRICT,
    rotation_position INTEGER NOT NULL CHECK (rotation_position > 0),
    payout_amount BIGINT NOT NULL CHECK (payout_amount > 0),
    scheduled_date DATE NOT NULL,
    paid_at TIMESTAMPTZ,
    status mgr_payout_status NOT NULL DEFAULT 'scheduled',
    receipt_number TEXT UNIQUE,
    payout_ledger_transaction_id UUID UNIQUE REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_mgr_cycle_rotation UNIQUE (cycle_id, rotation_position),
    CONSTRAINT uq_mgr_cycle_member UNIQUE (cycle_id, member_id),
    FOREIGN KEY (cycle_id, chama_id) REFERENCES merry_go_round_cycles(id, chama_id) ON DELETE RESTRICT,
    FOREIGN KEY (member_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE RESTRICT
);
CREATE INDEX idx_mgr_payouts_chama_id ON merry_go_round_payouts (chama_id);
CREATE INDEX idx_mgr_payouts_member_id ON merry_go_round_payouts (member_id);
CREATE INDEX idx_mgr_payouts_cycle_position ON merry_go_round_payouts (cycle_id, rotation_position);

CREATE TABLE merry_go_round_swap_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id UUID NOT NULL REFERENCES merry_go_round_cycles(id) ON DELETE RESTRICT,
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE RESTRICT,
    requester_payout_id UUID NOT NULL REFERENCES merry_go_round_payouts(id) ON DELETE RESTRICT,
    target_payout_id UUID NOT NULL REFERENCES merry_go_round_payouts(id) ON DELETE RESTRICT,
    requester_member_id UUID NOT NULL REFERENCES chama_members(id) ON DELETE RESTRICT,
    target_member_id UUID NOT NULL REFERENCES chama_members(id) ON DELETE RESTRICT,
    status mgr_swap_status NOT NULL DEFAULT 'pending',
    requester_accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    target_accepted_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (requester_payout_id <> target_payout_id),
    CHECK (requester_member_id <> target_member_id),
    FOREIGN KEY (requester_member_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE RESTRICT,
    FOREIGN KEY (target_member_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_mgr_pending_swap_pair
    ON merry_go_round_swap_requests (
        cycle_id,
        LEAST(requester_payout_id, target_payout_id),
        GREATEST(requester_payout_id, target_payout_id)
    )
    WHERE status = 'pending';
CREATE INDEX idx_mgr_swap_cycle_status
    ON merry_go_round_swap_requests (cycle_id, status, created_at DESC);

CREATE TABLE merry_go_round_disbursement_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payout_id UUID NOT NULL REFERENCES merry_go_round_payouts(id) ON DELETE RESTRICT,
    attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
    amount BIGINT NOT NULL CHECK (amount > 0),
    phone_number TEXT NOT NULL CHECK (length(trim(phone_number)) > 0),
    status mgr_disbursement_status NOT NULL DEFAULT 'pending',
    provider TEXT NOT NULL DEFAULT 'mpesa',
    provider_reference TEXT UNIQUE,
    transaction_receipt TEXT UNIQUE,
    failure_reason TEXT,
    dispatched_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (payout_id, attempt_no)
);
CREATE INDEX idx_mgr_disbursement_payout
    ON merry_go_round_disbursement_attempts (payout_id, attempt_no DESC);
CREATE INDEX idx_mgr_disbursement_provider_reference
    ON merry_go_round_disbursement_attempts (provider, provider_reference)
    WHERE provider_reference IS NOT NULL;

CREATE TABLE chama_broadcasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_chama_broadcasts_chama_id ON chama_broadcasts (chama_id);

CREATE TABLE chama_meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(trim(title)) >= 3),
    starts_at TIMESTAMPTZ NOT NULL,
    location TEXT,
    meeting_url TEXT,
    agenda TEXT,
    resolutions TEXT,
    reminder_at TIMESTAMPTZ NOT NULL,
    reminder_dispatched_at TIMESTAMPTZ,
    reminder_failed_at TIMESTAMPTZ,
    reminder_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reminder_attempts >= 0),
    reminder_next_attempt_at TIMESTAMPTZ,
    reminder_claim_token UUID,
    reminder_claimed_until TIMESTAMPTZ,
    reminder_last_error TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_meeting_destination CHECK (
        (location IS NOT NULL AND length(trim(location)) > 0)
        OR (meeting_url IS NOT NULL AND length(trim(meeting_url)) > 0)
    ),
    CONSTRAINT chk_meeting_reminder_before_start CHECK (reminder_at < starts_at),
    CONSTRAINT chk_meeting_reminder_terminal CHECK (
        NOT (reminder_dispatched_at IS NOT NULL AND reminder_failed_at IS NOT NULL)
    ),
    CONSTRAINT uq_chama_meeting_identity UNIQUE (id, chama_id)
);
CREATE INDEX idx_chama_meetings_chama_start ON chama_meetings (chama_id, starts_at DESC);
CREATE INDEX idx_chama_meetings_reminder_scan
    ON chama_meetings (COALESCE(reminder_next_attempt_at, reminder_at), starts_at, id)
    WHERE reminder_dispatched_at IS NULL AND reminder_failed_at IS NULL;

CREATE TABLE meeting_rsvps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL,
    chama_id UUID NOT NULL,
    member_id UUID NOT NULL,
    status meeting_rsvp_status NOT NULL,
    responded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_meeting_rsvp_meeting
        FOREIGN KEY (meeting_id, chama_id) REFERENCES chama_meetings(id, chama_id) ON DELETE CASCADE,
    CONSTRAINT fk_meeting_rsvp_member
        FOREIGN KEY (member_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE CASCADE,
    CONSTRAINT uq_meeting_rsvp_member UNIQUE (meeting_id, member_id)
);
CREATE INDEX idx_meeting_rsvps_meeting ON meeting_rsvps (meeting_id, status);
CREATE INDEX idx_meeting_rsvps_member ON meeting_rsvps (member_id, responded_at DESC);

CREATE TABLE meeting_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL,
    chama_id UUID NOT NULL,
    member_id UUID NOT NULL,
    present BOOLEAN NOT NULL,
    notes TEXT,
    recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_meeting_attendance_meeting
        FOREIGN KEY (meeting_id, chama_id) REFERENCES chama_meetings(id, chama_id) ON DELETE CASCADE,
    CONSTRAINT fk_meeting_attendance_member
        FOREIGN KEY (member_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE CASCADE,
    CONSTRAINT uq_meeting_member UNIQUE (meeting_id, member_id)
);
CREATE INDEX idx_meeting_attendance_meeting ON meeting_attendance (meeting_id, present);
CREATE INDEX idx_meeting_attendance_member_recorded ON meeting_attendance (member_id, recorded_at DESC);

-- BE-10 canonical SaaS plan catalog. Commercial values deliberately remain nullable
-- until an approved product decision supplies production pricing/quotas. Runtime
-- code must never substitute prototype/demo figures for NULL policy values.
CREATE TABLE subscription_plans (
    code TEXT PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
    name TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('free', 'premium')),
    billing_frequency TEXT NOT NULL CHECK (billing_frequency IN ('monthly', 'annual')),
    price_amount BIGINT CHECK (price_amount IS NULL OR price_amount >= 0),
    currency TEXT NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
    max_members INTEGER CHECK (max_members IS NULL OR max_members > 0),
    max_active_loans INTEGER CHECK (max_active_loans IS NULL OR max_active_loans >= 0),
    sms_quota_monthly INTEGER CHECK (sms_quota_monthly IS NULL OR sms_quota_monthly >= 0),
    allows_detailed_pdf BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO subscription_plans
    (code, name, tier, billing_frequency, price_amount, max_members, max_active_loans, sms_quota_monthly, allows_detailed_pdf)
VALUES
    ('free', 'Free', 'free', 'monthly', 0, NULL, NULL, NULL, FALSE),
    ('premium_monthly', 'Premium Monthly', 'premium', 'monthly', NULL, NULL, NULL, NULL, TRUE),
    ('premium_annual', 'Premium Annual', 'premium', 'annual', NULL, NULL, NULL, NULL, TRUE);

CREATE TABLE platform_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL UNIQUE REFERENCES chamas(id) ON DELETE RESTRICT,
    plan_code TEXT NOT NULL DEFAULT 'free' REFERENCES subscription_plans(code) ON UPDATE CASCADE ON DELETE RESTRICT,
    plan_name TEXT NOT NULL DEFAULT 'Free',
    billing_frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_frequency IN ('monthly', 'annual')),
    amount BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0),
    status subscription_status NOT NULL DEFAULT 'active',
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    renewed_at TIMESTAMPTZ,
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    grace_ends_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_subscription_period CHECK (
        current_period_start IS NULL OR current_period_end IS NULL OR current_period_end > current_period_start
    ),
    CONSTRAINT chk_subscription_grace CHECK (
        grace_ends_at IS NULL OR current_period_end IS NULL OR grace_ends_at >= current_period_end
    )
);
CREATE INDEX idx_platform_subscriptions_access ON platform_subscriptions (status, current_period_end, grace_ends_at);

-- Monthly SMS quota reservation counter. A worker reserves before provider I/O,
-- which prevents multiple worker processes from racing past the configured limit.
CREATE TABLE subscription_sms_usage (
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE RESTRICT,
    period_month DATE NOT NULL,
    used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chama_id, period_month),
    CONSTRAINT chk_subscription_sms_month_start CHECK (period_month = date_trunc('month', period_month::timestamp)::date)
);

CREATE TABLE subscription_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES platform_subscriptions(id) ON DELETE RESTRICT,
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE RESTRICT,
    plan_code TEXT NOT NULL REFERENCES subscription_plans(code) ON UPDATE CASCADE ON DELETE RESTRICT,
    billing_frequency TEXT NOT NULL CHECK (billing_frequency IN ('monthly', 'annual')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
    initiated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    phone_number TEXT NOT NULL,
    merchant_request_id TEXT,
    checkout_request_id TEXT UNIQUE,
    provider TEXT NOT NULL DEFAULT 'safaricom_daraja',
    provider_reference TEXT UNIQUE,
    receipt_number TEXT UNIQUE,
    status billing_status NOT NULL DEFAULT 'pending',
    result_code INTEGER,
    result_desc TEXT,
    request_payload JSONB,
    raw_payload JSONB,
    callback_verified_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_subscription_payments_subscription_id ON subscription_payments (subscription_id);
CREATE INDEX idx_subscription_payments_chama_id ON subscription_payments (chama_id, created_at DESC);
CREATE INDEX idx_subscription_payments_status ON subscription_payments (status, created_at DESC);
CREATE UNIQUE INDEX uq_subscription_pending_payment_per_chama
    ON subscription_payments (chama_id) WHERE status = 'pending';

CREATE TABLE support_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_code TEXT NOT NULL UNIQUE DEFAULT ('MD-' || upper(encode(gen_random_bytes(3), 'hex'))),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    chama_id UUID REFERENCES chamas(id) ON DELETE SET NULL,
    category support_ticket_category NOT NULL DEFAULT 'account_issue',
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status support_ticket_status NOT NULL DEFAULT 'open',
    routing_target TEXT NOT NULL DEFAULT 'platform_admin'
        CHECK (routing_target IN ('platform_admin', 'chama_chair')),
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    related_entity_type TEXT,
    related_entity_id UUID,
    context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context_snapshot) = 'object'),
    resolution_notes TEXT,
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_support_ticket_code CHECK (ticket_code ~ '^MD-[0-9A-F]{6}$'),
    CONSTRAINT chk_support_ticket_resolution CHECK (
        status NOT IN ('resolved','closed')
        OR (resolution_notes IS NOT NULL AND length(trim(resolution_notes)) > 0 AND resolved_at IS NOT NULL)
    )
);
CREATE INDEX idx_support_tickets_user_id ON support_tickets (user_id);
CREATE INDEX idx_support_tickets_chama_id ON support_tickets (chama_id);
CREATE INDEX idx_support_tickets_status ON support_tickets (status);
CREATE INDEX idx_support_tickets_assigned_status ON support_tickets (assigned_to, status, created_at DESC);
CREATE INDEX idx_support_tickets_category_status ON support_tickets (category, status, created_at DESC);
CREATE INDEX idx_support_tickets_related_entity ON support_tickets (related_entity_type, related_entity_id);

CREATE OR REPLACE FUNCTION prevent_support_ticket_context_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.ticket_code IS DISTINCT FROM OLD.ticket_code
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.chama_id IS DISTINCT FROM OLD.chama_id
       OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.routing_target IS DISTINCT FROM OLD.routing_target
       OR NEW.related_entity_type IS DISTINCT FROM OLD.related_entity_type
       OR NEW.related_entity_id IS DISTINCT FROM OLD.related_entity_id
       OR NEW.context_snapshot IS DISTINCT FROM OLD.context_snapshot
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'support ticket identity and evidence context are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_support_ticket_context_immutable
BEFORE UPDATE ON support_tickets
FOR EACH ROW EXECUTE FUNCTION prevent_support_ticket_context_mutation();

CREATE TABLE media_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    purpose media_upload_purpose NOT NULL,
    chama_id UUID REFERENCES chamas(id) ON DELETE CASCADE,
    support_ticket_id UUID REFERENCES support_tickets(id) ON DELETE CASCADE,
    original_filename TEXT NOT NULL CHECK (length(trim(original_filename)) BETWEEN 1 AND 255),
    object_key TEXT NOT NULL UNIQUE,
    declared_mime_type TEXT NOT NULL,
    detected_mime_type TEXT,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
    object_size_bytes BIGINT CHECK (object_size_bytes IS NULL OR object_size_bytes > 0),
    object_etag TEXT,
    state media_upload_state NOT NULL DEFAULT 'initiated',
    upload_expires_at TIMESTAMPTZ NOT NULL,
    uploaded_at TIMESTAMPTZ,
    scan_requested_at TIMESTAMPTZ,
    scan_claim_token UUID,
    scan_claimed_until TIMESTAMPTZ,
    scan_attempts INTEGER NOT NULL DEFAULT 0 CHECK (scan_attempts >= 0),
    scanned_at TIMESTAMPTZ,
    scan_provider TEXT,
    scan_reference TEXT,
    content_sha256 TEXT CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
    scan_last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_media_upload_scope CHECK (
        (purpose = 'profile_avatar' AND chama_id IS NULL AND support_ticket_id IS NULL)
        OR (purpose = 'chama_logo' AND chama_id IS NOT NULL AND support_ticket_id IS NULL)
        OR (purpose = 'support_ticket_attachment' AND support_ticket_id IS NOT NULL)
    ),
    CONSTRAINT chk_media_upload_scan_state CHECK (
        (state = 'initiated' AND uploaded_at IS NULL AND scanned_at IS NULL)
        OR (state IN ('scan_pending','scan_failed') AND uploaded_at IS NOT NULL)
        OR (state IN ('clean','infected') AND uploaded_at IS NOT NULL AND scanned_at IS NOT NULL)
        OR state IN ('rejected','deleted')
    ),
    CONSTRAINT chk_media_upload_clean_metadata CHECK (
        state <> 'clean' OR (
            detected_mime_type IS NOT NULL
            AND object_size_bytes = size_bytes
            AND content_sha256 IS NOT NULL
        )
    )
);
CREATE INDEX idx_media_uploads_owner_created ON media_uploads (owner_user_id, created_at DESC);
CREATE INDEX idx_media_uploads_chama ON media_uploads (chama_id, created_at DESC) WHERE chama_id IS NOT NULL;
CREATE INDEX idx_media_uploads_ticket ON media_uploads (support_ticket_id, created_at DESC) WHERE support_ticket_id IS NOT NULL;
CREATE INDEX idx_media_uploads_scan_queue ON media_uploads (scan_requested_at, id)
    WHERE state = 'scan_pending';
CREATE INDEX idx_media_uploads_scan_lease ON media_uploads (scan_claimed_until)
    WHERE state = 'scan_pending' AND scan_claim_token IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_media_upload_identity_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
       OR NEW.purpose IS DISTINCT FROM OLD.purpose
       OR NEW.chama_id IS DISTINCT FROM OLD.chama_id
       OR NEW.support_ticket_id IS DISTINCT FROM OLD.support_ticket_id
       OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
       OR NEW.object_key IS DISTINCT FROM OLD.object_key
       OR NEW.declared_mime_type IS DISTINCT FROM OLD.declared_mime_type
       OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
       OR NEW.upload_expires_at IS DISTINCT FROM OLD.upload_expires_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'media upload identity and storage contract are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_media_upload_identity_immutable
BEFORE UPDATE ON media_uploads
FOR EACH ROW EXECUTE FUNCTION prevent_media_upload_identity_mutation();

CREATE TABLE support_ticket_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    is_internal BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_support_ticket_comments_ticket ON support_ticket_comments (ticket_id, created_at);

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chama_id UUID REFERENCES chamas(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    dedupe_key TEXT,
    channel notification_channel NOT NULL DEFAULT 'in_app',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status notification_status NOT NULL DEFAULT 'pending',
    provider_message_id TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_notifications_user_feed ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_dispatch ON notifications (status, available_at, id) WHERE status = 'pending';
CREATE UNIQUE INDEX uq_notifications_dedupe ON notifications (user_id, event_type, channel, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    in_app_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    sms_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE polls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
    chama_rule_id UUID,
    decision_type TEXT NOT NULL CHECK (decision_type IN ('general','rule_amendment','member_removal','dissolution','payout_order_dispute')),
    decision_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    action_option_code TEXT,
    title TEXT NOT NULL,
    description TEXT,
    quorum_threshold_pct NUMERIC(5,2) NOT NULL CHECK (quorum_threshold_pct BETWEEN 0 AND 100),
    majority_threshold_pct NUMERIC(5,2) NOT NULL CHECK (majority_threshold_pct > 0 AND majority_threshold_pct <= 100),
    status poll_status NOT NULL DEFAULT 'draft',
    opens_at TIMESTAMPTZ,
    closes_at TIMESTAMPTZ NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    closed_at TIMESTAMPTZ,
    close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN ('deadline','full_turnout')),
    acted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_poll_window CHECK (opens_at IS NULL OR closes_at > opens_at),
    UNIQUE (id, chama_id),
    FOREIGN KEY (chama_rule_id, chama_id) REFERENCES chama_rules(id, chama_id) ON DELETE RESTRICT
);
CREATE INDEX idx_polls_chama_status ON polls (chama_id, status, closes_at);

CREATE TABLE poll_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    code TEXT NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (poll_id, code),
    UNIQUE (poll_id, label),
    UNIQUE (poll_id, id)
);

CREATE TABLE poll_eligible_voters (
    poll_id UUID NOT NULL,
    chama_id UUID NOT NULL,
    member_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (poll_id, member_id),
    FOREIGN KEY (poll_id, chama_id) REFERENCES polls(id, chama_id) ON DELETE CASCADE,
    FOREIGN KEY (member_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE CASCADE
);

CREATE TABLE poll_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES chama_members(id) ON DELETE RESTRICT,
    option_id UUID NOT NULL,
    cast_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (poll_id, member_id),
    FOREIGN KEY (poll_id, member_id) REFERENCES poll_eligible_voters(poll_id, member_id) ON DELETE RESTRICT,
    FOREIGN KEY (poll_id, option_id) REFERENCES poll_options(poll_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_poll_votes_poll_option ON poll_votes (poll_id, option_id);

CREATE OR REPLACE FUNCTION prevent_poll_vote_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'poll votes are immutable once cast';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_poll_votes_immutable
BEFORE UPDATE OR DELETE ON poll_votes
FOR EACH ROW EXECUTE FUNCTION prevent_poll_vote_mutation();

ALTER TABLE chama_rules
    ADD CONSTRAINT fk_chama_rules_amendment_poll
    FOREIGN KEY (amendment_poll_id) REFERENCES polls(id) ON DELETE SET NULL;
CREATE INDEX idx_chama_rules_amendment_poll ON chama_rules (amendment_poll_id) WHERE amendment_poll_id IS NOT NULL;

-- Queue-backed report exports. Binary output is persisted with the job so API
-- instances and workers do not need shared local filesystem state.
CREATE TABLE report_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE RESTRICT,
    membership_id UUID REFERENCES chama_members(id) ON DELETE RESTRICT,
    report_type TEXT NOT NULL CHECK (report_type IN ('chama_financial_statement', 'member_statement')),
    format TEXT NOT NULL CHECK (format IN ('pdf', 'excel')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed', 'expired')),
    period_from DATE,
    period_to DATE,
    snapshot_at TIMESTAMPTZ,
    reconciliation JSONB NOT NULL DEFAULT '{}'::jsonb,
    content BYTEA,
    content_type TEXT,
    file_name TEXT,
    file_size BIGINT CHECK (file_size IS NULL OR file_size >= 0),
    content_sha256 TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_until TIMESTAMPTZ,
    lease_token UUID,
    failure_reason TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_report_period CHECK (period_from IS NULL OR period_to IS NULL OR period_to >= period_from),
    CONSTRAINT chk_report_membership_scope CHECK (
        (report_type = 'member_statement' AND membership_id IS NOT NULL)
        OR (report_type = 'chama_financial_statement' AND membership_id IS NULL)
    ),
    CONSTRAINT fk_report_job_membership_chama
        FOREIGN KEY (membership_id, chama_id) REFERENCES chama_members(id, chama_id) ON DELETE RESTRICT,
    CONSTRAINT chk_report_content_sha256
        CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_report_content_size
        CHECK (content IS NULL OR (file_size IS NOT NULL AND file_size = octet_length(content))),
    CONSTRAINT chk_report_ready_output CHECK (
        status <> 'ready' OR (
            content IS NOT NULL
            AND content_type IS NOT NULL
            AND file_name IS NOT NULL
            AND file_size IS NOT NULL
            AND content_sha256 IS NOT NULL
            AND snapshot_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND expires_at IS NOT NULL
        )
    )
);
CREATE INDEX idx_report_jobs_queue ON report_jobs (status, available_at, id)
    WHERE status IN ('queued', 'processing');
CREATE INDEX idx_report_jobs_requester ON report_jobs (requested_by, created_at DESC);
CREATE INDEX idx_report_jobs_chama_created ON report_jobs (chama_id, created_at DESC);
CREATE INDEX idx_report_jobs_expiry ON report_jobs (expires_at) WHERE expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_goal_categories_updated_at BEFORE UPDATE ON goal_categories FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_saving_goals_updated_at BEFORE UPDATE ON saving_goals FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_chamas_updated_at BEFORE UPDATE ON chamas FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_chama_members_updated_at BEFORE UPDATE ON chama_members FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_trust_score_formula_versions_updated_at BEFORE UPDATE ON trust_score_formula_versions FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_partner_merchants_updated_at BEFORE UPDATE ON partner_merchants FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_goal_merchant_partnerships_updated_at BEFORE UPDATE ON goal_merchant_partnerships FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_member_merchant_rewards_updated_at BEFORE UPDATE ON member_merchant_rewards FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_chama_invitations_updated_at BEFORE UPDATE ON chama_invitations FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_chama_applications_updated_at BEFORE UPDATE ON chama_applications FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_chama_rules_updated_at BEFORE UPDATE ON chama_rules FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_commitment_deposits_updated_at BEFORE UPDATE ON commitment_deposits FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_loans_updated_at BEFORE UPDATE ON loans FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_loan_rules_updated_at BEFORE UPDATE ON loan_rules FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_loan_disbursements_updated_at BEFORE UPDATE ON loan_disbursements FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_support_tickets_updated_at BEFORE UPDATE ON support_tickets FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_media_uploads_updated_at BEFORE UPDATE ON media_uploads FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_notification_preferences_updated_at BEFORE UPDATE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_polls_updated_at BEFORE UPDATE ON polls FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_report_jobs_updated_at BEFORE UPDATE ON report_jobs FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE INDEX idx_contributions_chama_due_date ON contributions (chama_id, due_date);
CREATE INDEX idx_contributions_penalty_scan
    ON contributions (due_date, id) WHERE penalty_checked_at IS NULL AND status <> 'waived';
CREATE INDEX idx_contributions_reminder_scan
    ON contributions (due_date, id) WHERE status IN ('pending', 'partially_paid', 'late');
CREATE INDEX idx_contribution_payments_confirmed_deadline
    ON contribution_payments (contribution_id, paid_at) INCLUDE (amount) WHERE status = 'confirmed';
CREATE INDEX idx_contribution_rules_effective
    ON contribution_rules (chama_id, effective_from DESC, id DESC);
CREATE INDEX idx_loans_chama_application_date ON loans (chama_id, application_date);
CREATE INDEX idx_loans_interest_scan
    ON loans (next_interest_date, id) WHERE status IN ('active', 'partially_repaid') AND interest_cycle_days IS NOT NULL;
CREATE INDEX idx_loans_reminder_scan
    ON loans (due_date, id) WHERE status IN ('active', 'partially_repaid');
CREATE INDEX idx_loan_repayments_loan_id_status ON loan_repayments (loan_id, status);
CREATE INDEX idx_ledger_entries_member
    ON ledger_entries (member_id, created_at) WHERE member_id IS NOT NULL;
CREATE INDEX idx_ledger_entries_chama_treasury_created_at
    ON ledger_entries (chama_id, created_at)
    WHERE account = 'chama_treasury';

-- High-value identity and membership lookups used by Phase 1 APIs.
CREATE INDEX idx_chama_members_user_status ON chama_members (user_id, membership_status, chama_id);
CREATE INDEX idx_chama_members_chama_role_status ON chama_members (chama_id, role, membership_status);
CREATE INDEX idx_chama_members_active_goal_metrics
    ON chama_members (chama_id, user_id)
    WHERE membership_status = 'active';

CREATE VIEW chama_summary AS
SELECT c.id, c.name, c.type, c.status, c.pooled_amount, c.target_amount,
       COUNT(cm.id) FILTER (WHERE cm.membership_status = 'active') AS active_member_count
FROM chamas c
LEFT JOIN chama_members cm ON cm.chama_id = c.id
GROUP BY c.id;
