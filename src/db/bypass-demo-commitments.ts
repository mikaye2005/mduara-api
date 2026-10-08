import { env } from '../config/env';
import { pool, closeDatabase } from './client';
import { withDatabaseTransaction } from './transaction';

/** Activates only applicants whose sole remaining gate is the commitment payment. */
export async function bypassPendingDemoCommitments() {
  if (env.NODE_ENV === 'production' || !env.DEMO_BYPASS_COMMITMENT_FEE) {
    throw new Error('Demo commitment bypass must be explicitly enabled outside production');
  }

  return withDatabaseTransaction(async (client) => {
    const activated = await client.query<{
      membership_id: string; application_id: string; chama_id: string; user_id: string;
    }>(
      `WITH candidates AS (
         SELECT cm.id AS membership_id,ca.id AS application_id,cm.chama_id,cm.user_id
           FROM chama_members cm
           JOIN chama_applications ca
             ON ca.chama_id=cm.chama_id AND ca.user_id=cm.user_id
          WHERE cm.membership_status='pending' AND ca.status='commitment_pending'
          FOR UPDATE OF cm,ca
       ), memberships AS (
         UPDATE chama_members cm
            SET membership_status='active',approved_at=COALESCE(approved_at,CURRENT_TIMESTAMP)
           FROM candidates c WHERE cm.id=c.membership_id
         RETURNING cm.id
       ), applications AS (
         UPDATE chama_applications ca
            SET status='approved',updated_at=CURRENT_TIMESTAMP
           FROM candidates c WHERE ca.id=c.application_id
         RETURNING ca.id
       )
       SELECT c.* FROM candidates c
       JOIN memberships m ON m.id=c.membership_id
       JOIN applications a ON a.id=c.application_id`,
    );

    if (activated.rows.length) {
      await client.query(
        `INSERT INTO audit_logs(category,action,actor_role,chama_id,entity_type,entity_id,payload)
         SELECT 'moderation','demo_commitment_fee_bypassed','system',x.chama_id,
                'membership',x.membership_id,
                jsonb_build_object('applicationId',x.application_id,'userId',x.user_id,'reason','M-Pesa demo bypass')
           FROM jsonb_to_recordset($1::jsonb)
             AS x(membership_id uuid,application_id uuid,chama_id uuid,user_id uuid)`,
        [JSON.stringify(activated.rows)],
      );
    }
    return { activated: activated.rows.length };
  }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, pool);
}

if (require.main === module) {
  void bypassPendingDemoCommitments()
    .then((result) => console.log(JSON.stringify({ event: 'demo.commitment_bypass_complete', ...result })))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
