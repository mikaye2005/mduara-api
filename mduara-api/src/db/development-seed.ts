import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { Pool, PoolClient } from 'pg';

export const DEVELOPMENT_SEED_FLAG = 'MDUARA_ENABLE_DEV_SEED';
export const DEVELOPMENT_REMOTE_SEED_FLAG = 'MDUARA_ALLOW_REMOTE_DEV_SEED';

export const DEV_FIXTURE_IDS = {
  users: {
    mumbi: '31000000-0000-4000-8000-000000000001',
    david: '31000000-0000-4000-8000-000000000002',
    aisha: '31000000-0000-4000-8000-000000000003',
    peter: '31000000-0000-4000-8000-000000000004',
    johnAdmin: '31000000-0000-4000-8000-000000000005',
    james: '31000000-0000-4000-8000-000000000006',
    lucy: '31000000-0000-4000-8000-000000000007',
    samuel: '31000000-0000-4000-8000-000000000008',
    wanjiku: '31000000-0000-4000-8000-000000000009',
    brian: '31000000-0000-4000-8000-000000000010',
    esther: '31000000-0000-4000-8000-000000000011',
  },
  chamas: {
    summertides: '41000000-0000-4000-8000-000000000001',
    futureHome: '41000000-0000-4000-8000-000000000002',
    washingMachine: '41000000-0000-4000-8000-000000000003',
    nextStepFounders: '41000000-0000-4000-8000-000000000004',
  },
  rules: {
    summertides: '61000000-0000-4000-8000-000000000001',
    futureHome: '61000000-0000-4000-8000-000000000002',
    washingMachine: '61000000-0000-4000-8000-000000000003',
    nextStepFounders: '61000000-0000-4000-8000-000000000004',
  },
  memberships: {
    aishaSummertides: '51000000-0000-4000-8000-000000000001',
    aishaFutureHome: '51000000-0000-4000-8000-000000000002',
    aishaWashingMachine: '51000000-0000-4000-8000-000000000003',
    mumbiSummertides: '51000000-0000-4000-8000-000000000004',
    mumbiWashingMachine: '51000000-0000-4000-8000-000000000005',
    davidSummertides: '51000000-0000-4000-8000-000000000006',
    davidFutureHome: '51000000-0000-4000-8000-000000000007',
    peterSummertides: '51000000-0000-4000-8000-000000000008',
    jamesFutureHome: '51000000-0000-4000-8000-000000000009',
    lucyFutureHome: '51000000-0000-4000-8000-000000000010',
    samuelFutureHome: '51000000-0000-4000-8000-000000000011',
    jamesWashingMachine: '51000000-0000-4000-8000-000000000012',
    lucyWashingMachine: '51000000-0000-4000-8000-000000000013',
    samuelWashingMachine: '51000000-0000-4000-8000-000000000014',
    wanjikuNextStep: '51000000-0000-4000-8000-000000000015',
    brianNextStep: '51000000-0000-4000-8000-000000000016',
    estherNextStep: '51000000-0000-4000-8000-000000000017',
  },
} as const;

interface SeedIdentity {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  pin: string;
  isPlatformAdmin?: boolean;
}

interface SeedChama {
  id: string;
  name: string;
  description: string;
  status: 'recruiting' | 'active';
  visibility: 'public' | 'application' | 'private';
  goalCode: string | null;
  location: string;
  targetMembers: number;
  contributionAmount: number;
  contributionFrequency: string;
  targetAmount: number;
  savingStartDate: string;
  savingEndDate: string;
  createdBy: string;
}

interface SeedMembership {
  id: string;
  chamaId: string;
  userId: string;
  role: 'member' | 'chairperson' | 'secretary' | 'treasurer';
  joinedAt: string;
}

const identities: SeedIdentity[] = [
  { id: DEV_FIXTURE_IDS.users.mumbi, fullName: 'Mumbi Wanjiru', phone: '+254712345678', email: 'mumbi.wanjiru.dev@mduara.test', pin: '1234' },
  { id: DEV_FIXTURE_IDS.users.david, fullName: 'David Mwangi', phone: '+254720100200', email: 'david.mwangi.dev@mduara.test', pin: '2468' },
  { id: DEV_FIXTURE_IDS.users.aisha, fullName: 'Aisha Kamau', phone: '+254730200300', email: 'aisha.kamau.dev@mduara.test', pin: '3579' },
  { id: DEV_FIXTURE_IDS.users.peter, fullName: 'Peter Ouma', phone: '+254740300400', email: 'peter.ouma.dev@mduara.test', pin: '4680' },
  { id: DEV_FIXTURE_IDS.users.johnAdmin, fullName: 'John Kamau', phone: '+254750400500', email: 'john.kamau.dev@mduara.test', pin: '5791', isPlatformAdmin: true },
  { id: DEV_FIXTURE_IDS.users.james, fullName: 'James Kariuki', phone: '+254799000006', email: 'james.kariuki.fixture@mduara.test', pin: '9999' },
  { id: DEV_FIXTURE_IDS.users.lucy, fullName: 'Lucy Wambui', phone: '+254799000007', email: 'lucy.wambui.fixture@mduara.test', pin: '9999' },
  { id: DEV_FIXTURE_IDS.users.samuel, fullName: 'Samuel Maina', phone: '+254799000008', email: 'samuel.maina.fixture@mduara.test', pin: '9999' },
  { id: DEV_FIXTURE_IDS.users.wanjiku, fullName: 'Wanjiku Kariuki', phone: '+254799000009', email: 'wanjiku.kariuki.fixture@mduara.test', pin: '9999' },
  { id: DEV_FIXTURE_IDS.users.brian, fullName: 'Brian Njoroge', phone: '+254799000010', email: 'brian.njoroge.fixture@mduara.test', pin: '9999' },
  { id: DEV_FIXTURE_IDS.users.esther, fullName: 'Esther Ouma', phone: '+254799000011', email: 'esther.ouma.fixture@mduara.test', pin: '9999' },
];

const chamas: SeedChama[] = [
  {
    id: DEV_FIXTURE_IDS.chamas.summertides,
    name: "Summertides '27",
    description: 'Development fixture mirroring the completed-recruitment travel Chama used throughout the approved prototype.',
    status: 'active',
    visibility: 'private',
    goalCode: 'diani',
    location: 'Nairobi',
    targetMembers: 30,
    contributionAmount: 1500,
    contributionFrequency: 'every_14_days',
    targetAmount: 270000,
    savingStartDate: '2026-10-01',
    savingEndDate: '2026-12-10',
    createdBy: DEV_FIXTURE_IDS.users.david,
  },
  {
    id: DEV_FIXTURE_IDS.chamas.futureHome,
    name: 'Future Home',
    description: 'Development fixture for the approved House / Land Chama. The canonical Phase 1 goal catalog does not yet contain House / Land, so goal_code intentionally remains null.',
    status: 'recruiting',
    visibility: 'application',
    goalCode: null,
    location: 'Nairobi & Kiambu',
    targetMembers: 50,
    contributionAmount: 10000,
    contributionFrequency: 'monthly',
    targetAmount: 9000000,
    savingStartDate: '2026-10-01',
    savingEndDate: '2028-03-31',
    createdBy: DEV_FIXTURE_IDS.users.james,
  },
  {
    id: DEV_FIXTURE_IDS.chamas.washingMachine,
    name: 'Washing Machine Mbogi',
    description: 'Development fixture for canonical Washing Machine goal matching, marketplace metrics and multi-Chama switching.',
    status: 'recruiting',
    visibility: 'public',
    goalCode: 'washing_machine',
    location: 'Nairobi',
    targetMembers: 30,
    contributionAmount: 3000,
    contributionFrequency: 'monthly',
    targetAmount: 1440000,
    savingStartDate: '2026-10-01',
    savingEndDate: '2028-01-31',
    createdBy: DEV_FIXTURE_IDS.users.james,
  },
  {
    id: DEV_FIXTURE_IDS.chamas.nextStepFounders,
    name: 'Next Step Founders',
    description: 'Development fixture mirroring the public founder-focused savings circle in the approved prototype.',
    status: 'recruiting',
    visibility: 'public',
    goalCode: null,
    location: 'Nairobi',
    targetMembers: 25,
    contributionAmount: 7500,
    contributionFrequency: 'monthly',
    targetAmount: 1875000,
    savingStartDate: '2026-10-01',
    savingEndDate: '2027-07-31',
    createdBy: DEV_FIXTURE_IDS.users.wanjiku,
  },
];

const memberships: SeedMembership[] = [
  { id: DEV_FIXTURE_IDS.memberships.aishaFutureHome, chamaId: DEV_FIXTURE_IDS.chamas.futureHome, userId: DEV_FIXTURE_IDS.users.aisha, role: 'member', joinedAt: '2026-09-08T09:00:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.aishaWashingMachine, chamaId: DEV_FIXTURE_IDS.chamas.washingMachine, userId: DEV_FIXTURE_IDS.users.aisha, role: 'member', joinedAt: '2026-09-09T09:00:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.aishaSummertides, chamaId: DEV_FIXTURE_IDS.chamas.summertides, userId: DEV_FIXTURE_IDS.users.aisha, role: 'secretary', joinedAt: '2026-09-10T09:00:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.mumbiSummertides, chamaId: DEV_FIXTURE_IDS.chamas.summertides, userId: DEV_FIXTURE_IDS.users.mumbi, role: 'member', joinedAt: '2026-09-10T08:30:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.mumbiWashingMachine, chamaId: DEV_FIXTURE_IDS.chamas.washingMachine, userId: DEV_FIXTURE_IDS.users.mumbi, role: 'member', joinedAt: '2026-09-09T08:30:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.davidSummertides, chamaId: DEV_FIXTURE_IDS.chamas.summertides, userId: DEV_FIXTURE_IDS.users.david, role: 'chairperson', joinedAt: '2026-09-10T08:00:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.davidFutureHome, chamaId: DEV_FIXTURE_IDS.chamas.futureHome, userId: DEV_FIXTURE_IDS.users.david, role: 'member', joinedAt: '2026-09-08T08:00:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.peterSummertides, chamaId: DEV_FIXTURE_IDS.chamas.summertides, userId: DEV_FIXTURE_IDS.users.peter, role: 'treasurer', joinedAt: '2026-09-10T08:15:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.jamesFutureHome, chamaId: DEV_FIXTURE_IDS.chamas.futureHome, userId: DEV_FIXTURE_IDS.users.james, role: 'chairperson', joinedAt: '2026-09-08T07:00:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.lucyFutureHome, chamaId: DEV_FIXTURE_IDS.chamas.futureHome, userId: DEV_FIXTURE_IDS.users.lucy, role: 'secretary', joinedAt: '2026-09-08T07:10:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.samuelFutureHome, chamaId: DEV_FIXTURE_IDS.chamas.futureHome, userId: DEV_FIXTURE_IDS.users.samuel, role: 'treasurer', joinedAt: '2026-09-08T07:20:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.jamesWashingMachine, chamaId: DEV_FIXTURE_IDS.chamas.washingMachine, userId: DEV_FIXTURE_IDS.users.james, role: 'chairperson', joinedAt: '2026-09-09T07:00:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.lucyWashingMachine, chamaId: DEV_FIXTURE_IDS.chamas.washingMachine, userId: DEV_FIXTURE_IDS.users.lucy, role: 'secretary', joinedAt: '2026-09-09T07:10:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.samuelWashingMachine, chamaId: DEV_FIXTURE_IDS.chamas.washingMachine, userId: DEV_FIXTURE_IDS.users.samuel, role: 'treasurer', joinedAt: '2026-09-09T07:20:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.wanjikuNextStep, chamaId: DEV_FIXTURE_IDS.chamas.nextStepFounders, userId: DEV_FIXTURE_IDS.users.wanjiku, role: 'chairperson', joinedAt: '2026-09-07T07:00:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.brianNextStep, chamaId: DEV_FIXTURE_IDS.chamas.nextStepFounders, userId: DEV_FIXTURE_IDS.users.brian, role: 'secretary', joinedAt: '2026-09-07T07:10:00Z' },
  { id: DEV_FIXTURE_IDS.memberships.estherNextStep, chamaId: DEV_FIXTURE_IDS.chamas.nextStepFounders, userId: DEV_FIXTURE_IDS.users.esther, role: 'treasurer', joinedAt: '2026-09-07T07:20:00Z' },
];

const rules = [
  { id: DEV_FIXTURE_IDS.rules.summertides, chamaId: DEV_FIXTURE_IDS.chamas.summertides, purpose: 'Diani travel', contributionAmount: 1500, frequency: 'every_14_days', createdBy: DEV_FIXTURE_IDS.users.david },
  { id: DEV_FIXTURE_IDS.rules.futureHome, chamaId: DEV_FIXTURE_IDS.chamas.futureHome, purpose: 'House / Land', contributionAmount: 10000, frequency: 'monthly', createdBy: DEV_FIXTURE_IDS.users.james },
  { id: DEV_FIXTURE_IDS.rules.washingMachine, chamaId: DEV_FIXTURE_IDS.chamas.washingMachine, purpose: 'Washing Machine', contributionAmount: 3000, frequency: 'monthly', createdBy: DEV_FIXTURE_IDS.users.james },
  { id: DEV_FIXTURE_IDS.rules.nextStepFounders, chamaId: DEV_FIXTURE_IDS.chamas.nextStepFounders, purpose: 'Business capital', contributionAmount: 7500, frequency: 'monthly', createdBy: DEV_FIXTURE_IDS.users.wanjiku },
] as const;

export function assertDevelopmentSeedAllowed(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV === 'production') {
    throw new Error('Development seed is disabled when NODE_ENV=production');
  }
  if (environment[DEVELOPMENT_SEED_FLAG] !== 'true') {
    throw new Error(`Development seed requires ${DEVELOPMENT_SEED_FLAG}=true`);
  }

  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('Development seed requires DATABASE_URL');

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Development seed requires a valid PostgreSQL DATABASE_URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Development seed only supports PostgreSQL DATABASE_URL values');
  }

  const host = parsed.hostname.toLowerCase();
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!localHosts.has(host) && environment[DEVELOPMENT_REMOTE_SEED_FLAG] !== 'true') {
    throw new Error(`Remote development seed requires ${DEVELOPMENT_REMOTE_SEED_FLAG}=true`);
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!databaseName) throw new Error('Development seed requires a named database');
  if (databaseName.toLowerCase() === 'postgres' && environment.MDUARA_ALLOW_SYSTEM_DATABASE_SEED !== 'true') {
    throw new Error('Refusing to seed the default postgres database');
  }
}

export interface DevelopmentSeedSummary {
  fixture: 'BE-36';
  users: number;
  chamas: number;
  memberships: number;
  aishaMemberships: number;
  aishaOfficialMemberships: number;
  washingMachinePartnerMerchants: number;
}

export async function seedDevelopmentDatabase(database: Pool): Promise<DevelopmentSeedSummary> {
  // Deliberately enforce the guard inside the reusable function too; callers cannot
  // bypass production protection merely by importing this module instead of using the CLI.
  assertDevelopmentSeedAllowed(process.env);

  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('mduara:be36-development-seed', 0))`);

    await assertCanonicalDependencies(client);
    await assertFixtureIdentitySpace(client);
    await upsertUsers(client);
    await upsertChamas(client);
    await upsertRules(client);
    await upsertMemberships(client);
    await upsertConstitutionAcceptances(client);

    const summary = await readSummary(client);
    if (summary.aishaMemberships !== 3 || summary.aishaOfficialMemberships !== 1) {
      throw new Error('BE-36 invariant failed: Aisha must have exactly 3 memberships and 1 official membership');
    }
    if (summary.washingMachinePartnerMerchants !== 3) {
      throw new Error('BE-36 requires the three active BE-33 Washing Machine demo merchants');
    }

    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assertCanonicalDependencies(client: PoolClient) {
  const goals = await client.query<{ code: string }>(
    `SELECT code FROM saving_goals WHERE is_active = TRUE AND code = ANY($1::text[])`,
    [['washing_machine', 'diani']],
  );
  const present = new Set(goals.rows.map((row) => row.code));
  for (const required of ['washing_machine', 'diani']) {
    if (!present.has(required)) throw new Error(`Canonical goal ${required} is missing; run migrations before BE-36 seed`);
  }

  const merchantCount = Number((await client.query(
    `SELECT COUNT(DISTINCT pm.id)::int AS count
       FROM partner_merchants pm
       JOIN goal_merchant_partnerships gmp ON gmp.merchant_id = pm.id
       JOIN saving_goals sg ON sg.id = gmp.goal_id
      WHERE sg.code = 'washing_machine'
        AND pm.status = 'active'
        AND gmp.status = 'active'
        AND (gmp.valid_from IS NULL OR gmp.valid_from <= CURRENT_TIMESTAMP)
        AND (gmp.valid_until IS NULL OR gmp.valid_until > CURRENT_TIMESTAMP)`,
  )).rows[0]?.count ?? 0);
  if (merchantCount !== 3) throw new Error('BE-33 canonical Washing Machine merchant fixtures are missing or inactive');
}

async function assertFixtureIdentitySpace(client: PoolClient) {
  const phones = identities.map((identity) => identity.phone);
  const emails = identities.map((identity) => identity.email.toLowerCase());
  const existingUsers = await client.query<{ id: string; phone: string; email: string }>(
    `SELECT id, phone, email FROM users WHERE phone = ANY($1::text[]) OR lower(email) = ANY($2::text[])`,
    [phones, emails],
  );
  const expectedByPhone = new Map(identities.map((identity) => [identity.phone, identity.id]));
  const expectedByEmail = new Map(identities.map((identity) => [identity.email.toLowerCase(), identity.id]));
  for (const row of existingUsers.rows) {
    if (expectedByPhone.get(row.phone) !== row.id || expectedByEmail.get(row.email.toLowerCase()) !== row.id) {
      throw new Error(`Development seed identity collision for ${row.phone}/${row.email}`);
    }
  }

  const existingChamas = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM chamas WHERE name = ANY($1::text[])`,
    [chamas.map((chama) => chama.name)],
  );
  const expectedChamaId = new Map(chamas.map((chama) => [chama.name, chama.id]));
  for (const row of existingChamas.rows) {
    if (expectedChamaId.get(row.name) !== row.id) {
      throw new Error(`Development seed Chama name collision for ${row.name}`);
    }
  }
}

async function upsertUsers(client: PoolClient) {
  const rounds = Math.min(12, Math.max(4, Number(process.env.BCRYPT_SALT_ROUNDS ?? 8) || 8));
  const hashByPin = new Map<string, string>();
  for (const pin of new Set(identities.map((identity) => identity.pin))) {
    hashByPin.set(pin, await bcrypt.hash(pin, rounds));
  }

  for (const identity of identities) {
    await client.query(
      `INSERT INTO users
         (id, email, pin_hash, full_name, phone, status, is_email_verified, is_platform_admin, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', TRUE, $6, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         pin_hash = EXCLUDED.pin_hash,
         full_name = EXCLUDED.full_name,
         phone = EXCLUDED.phone,
         status = 'active',
         status_reason = NULL,
         is_email_verified = TRUE,
         is_platform_admin = EXCLUDED.is_platform_admin,
         updated_at = EXCLUDED.updated_at`,
      [identity.id, identity.email, hashByPin.get(identity.pin), identity.fullName, identity.phone, identity.isPlatformAdmin ?? false],
    );
  }
}

async function upsertChamas(client: PoolClient) {
  for (const chama of chamas) {
    await client.query(
      `INSERT INTO chamas
         (id, name, description, type, status, visibility, goal_code, location, target_members,
          recruitment_deadline, saving_start_date, saving_end_date, contribution_amount,
          contribution_frequency, target_amount, pooled_amount, currency, created_by, created_at, updated_at)
       VALUES
         ($1, $2, $3, 'goal_based', $4::chama_status, $5::chama_visibility, $6, $7, $8,
          '2026-12-31', $9::date, $10::date, $11, $12, $13, 0, 'KES', $14,
          '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         type = EXCLUDED.type,
         status = EXCLUDED.status,
         visibility = EXCLUDED.visibility,
         goal_code = EXCLUDED.goal_code,
         location = EXCLUDED.location,
         target_members = EXCLUDED.target_members,
         recruitment_deadline = EXCLUDED.recruitment_deadline,
         saving_start_date = EXCLUDED.saving_start_date,
         saving_end_date = EXCLUDED.saving_end_date,
         contribution_amount = EXCLUDED.contribution_amount,
         contribution_frequency = EXCLUDED.contribution_frequency,
         target_amount = EXCLUDED.target_amount,
         currency = 'KES',
         created_by = EXCLUDED.created_by,
         updated_at = EXCLUDED.updated_at`,
      [
        chama.id, chama.name, chama.description, chama.status, chama.visibility, chama.goalCode,
        chama.location, chama.targetMembers, chama.savingStartDate, chama.savingEndDate,
        chama.contributionAmount, chama.contributionFrequency, chama.targetAmount, chama.createdBy,
      ],
    );
  }
}

async function upsertRules(client: PoolClient) {
  for (const rule of rules) {
    const otherActive = await client.query<{ id: string }>(
      `SELECT id FROM chama_rules WHERE chama_id = $1 AND status = 'active' AND id <> $2`,
      [rule.chamaId, rule.id],
    );
    if (otherActive.rowCount) throw new Error(`Development fixture Chama ${rule.chamaId} already has another active Constitution`);

    await client.query(
      `INSERT INTO chama_rules
         (id, chama_id, version, status, purpose_goal, contribution_amount, contribution_frequency,
          commitment_amount, default_grace_period_days, default_after_consecutive_misses,
          quorum_threshold_pct, majority_threshold_pct, exit_withdrawal_policy, payout_policy,
          conduct_dispute_policy, dissolution_policy, metadata, effective_from, created_by, created_at)
       VALUES
         ($1, $2, 1, 'active', $3, $4, $5, 500, 5, 3, 50, 50,
          '{"mode":"constitution_governed"}'::jsonb,
          '{"completion":"provider_confirmed"}'::jsonb,
          '{"privacy":"member_financials_private"}'::jsonb,
          '{"refundCommitmentOnCleanDissolution":true}'::jsonb,
          '{"fixture":"BE-36","developmentOnly":true,"source":"approved-prototype"}'::jsonb,
          '2026-09-01T00:00:00Z', $6, '2026-09-01T00:00:00Z')
       ON CONFLICT (id) DO UPDATE SET
         purpose_goal = EXCLUDED.purpose_goal,
         contribution_amount = EXCLUDED.contribution_amount,
         contribution_frequency = EXCLUDED.contribution_frequency,
         commitment_amount = 500,
         default_grace_period_days = 5,
         default_after_consecutive_misses = 3,
         metadata = EXCLUDED.metadata,
         created_by = EXCLUDED.created_by`,
      [rule.id, rule.chamaId, rule.purpose, rule.contributionAmount, rule.frequency, rule.createdBy],
    );
  }
}

async function upsertMemberships(client: PoolClient) {
  for (const membership of memberships) {
    const conflicting = await client.query<{ id: string }>(
      `SELECT id FROM chama_members WHERE chama_id = $1 AND user_id = $2 AND id <> $3`,
      [membership.chamaId, membership.userId, membership.id],
    );
    if (conflicting.rowCount) throw new Error(`Development fixture membership collision for ${membership.chamaId}/${membership.userId}`);

    await client.query(
      `INSERT INTO chama_members
         (id, chama_id, user_id, role, membership_status, joined_at, approved_at, updated_at)
       VALUES ($1, $2, $3, $4::member_role, 'active', $5::timestamptz, $5::timestamptz, $5::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         role = EXCLUDED.role,
         membership_status = 'active',
         joined_at = EXCLUDED.joined_at,
         approved_at = EXCLUDED.approved_at,
         exit_date = NULL,
         updated_at = EXCLUDED.updated_at`,
      [membership.id, membership.chamaId, membership.userId, membership.role, membership.joinedAt],
    );
  }
}

async function upsertConstitutionAcceptances(client: PoolClient) {
  const ruleByChama = new Map(rules.map((rule) => [rule.chamaId, rule.id]));
  let sequence = 1;
  for (const membership of memberships) {
    const ruleId = ruleByChama.get(membership.chamaId);
    if (!ruleId) throw new Error(`Missing fixture Constitution for Chama ${membership.chamaId}`);
    const acceptanceId = `71000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
    sequence += 1;
    await client.query(
      `INSERT INTO membership_constitution_acceptances
         (id, chama_id, membership_id, chama_rule_id, accepted_at, user_agent)
       VALUES ($1, $2, $3, $4, $5::timestamptz, 'BE-36 development seed')
       ON CONFLICT (membership_id, chama_rule_id) DO UPDATE SET
         accepted_at = EXCLUDED.accepted_at,
         user_agent = EXCLUDED.user_agent`,
      [acceptanceId, membership.chamaId, membership.id, ruleId, membership.joinedAt],
    );
  }
}

async function readSummary(client: PoolClient): Promise<DevelopmentSeedSummary> {
  const userCount = Number((await client.query(`SELECT COUNT(*)::int AS count FROM users WHERE id = ANY($1::uuid[])`, [Object.values(DEV_FIXTURE_IDS.users)])).rows[0].count);
  const chamaCount = Number((await client.query(`SELECT COUNT(*)::int AS count FROM chamas WHERE id = ANY($1::uuid[])`, [Object.values(DEV_FIXTURE_IDS.chamas)])).rows[0].count);
  const membershipCount = Number((await client.query(`SELECT COUNT(*)::int AS count FROM chama_members WHERE id = ANY($1::uuid[])`, [Object.values(DEV_FIXTURE_IDS.memberships)])).rows[0].count);
  const aisha = (await client.query<{ memberships: number; official_memberships: number }>(
    `SELECT COUNT(*)::int AS memberships,
            COUNT(*) FILTER (WHERE role <> 'member')::int AS official_memberships
       FROM chama_members
      WHERE user_id = $1 AND membership_status = 'active'`,
    [DEV_FIXTURE_IDS.users.aisha],
  )).rows[0];
  const merchantCount = Number((await client.query(
    `SELECT COUNT(DISTINCT pm.id)::int AS count
       FROM partner_merchants pm
       JOIN goal_merchant_partnerships gmp ON gmp.merchant_id = pm.id
       JOIN saving_goals sg ON sg.id = gmp.goal_id
      WHERE sg.code = 'washing_machine'
        AND pm.status = 'active'
        AND gmp.status = 'active'
        AND (gmp.valid_from IS NULL OR gmp.valid_from <= CURRENT_TIMESTAMP)
        AND (gmp.valid_until IS NULL OR gmp.valid_until > CURRENT_TIMESTAMP)`,
  )).rows[0].count);

  return {
    fixture: 'BE-36',
    users: userCount,
    chamas: chamaCount,
    memberships: membershipCount,
    aishaMemberships: Number(aisha.memberships),
    aishaOfficialMemberships: Number(aisha.official_memberships),
    washingMachinePartnerMerchants: merchantCount,
  };
}

async function main() {
  assertDevelopmentSeedAllowed(process.env);
  const database = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const summary = await seedDevelopmentDatabase(database);
    console.log(JSON.stringify({ event: 'mduara.development_seed_complete', ...summary }, null, 2));
  } finally {
    await database.end();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error('[BE-36 development seed failed]', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
