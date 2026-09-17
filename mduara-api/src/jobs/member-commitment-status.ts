import type { Pool } from 'pg';

export type MemberCommitmentStatus = 'ON_TRACK' | 'MISSED_1' | 'MISSED_2' | 'DEFAULT_TRIGGERED';

/**
 * Materializes the privacy-safe BE-23 status from BE-08's authoritative assessed
 * contribution/default state. No amounts, balances, payment methods or provider
 * metadata participate in the public member-list projection.
 */
export async function refreshMemberCommitmentStatuses(db: Pool) {
  const result = await db.query<{ id: string; commitment_status: MemberCommitmentStatus }>(
    `WITH derived AS (
       SELECT cm.id,
              CASE
                WHEN cm.membership_status = 'defaulted'
                  OR commitment.state IN ('default_triggered','forfeited','partial_forfeit')
                  THEN 'DEFAULT_TRIGGERED'::member_commitment_status
                WHEN COALESCE(latest.consecutive_miss_count, 0) >= 2
                  THEN 'MISSED_2'::member_commitment_status
                WHEN COALESCE(latest.consecutive_miss_count, 0) = 1
                  THEN 'MISSED_1'::member_commitment_status
                ELSE 'ON_TRACK'::member_commitment_status
              END AS status
         FROM chama_members cm
         LEFT JOIN LATERAL (
           SELECT c.consecutive_miss_count
             FROM contributions c
            WHERE c.member_id = cm.id
              AND c.chama_id = cm.chama_id
              AND c.penalty_checked_at IS NOT NULL
            ORDER BY c.due_date DESC, c.created_at DESC, c.id DESC
            LIMIT 1
         ) latest ON TRUE
         LEFT JOIN LATERAL (
           SELECT cd.state::text AS state
             FROM commitment_deposits cd
            WHERE cd.membership_id = cm.id
              AND cd.chama_id = cm.chama_id
            ORDER BY cd.created_at DESC, cd.id DESC
            LIMIT 1
         ) commitment ON TRUE
     )
     UPDATE chama_members cm
        SET commitment_status = d.status,
            commitment_status_updated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
       FROM derived d
      WHERE cm.id = d.id
        AND cm.commitment_status IS DISTINCT FROM d.status
      RETURNING cm.id, cm.commitment_status::text AS commitment_status`,
  );
  return { updated: result.rowCount ?? 0 };
}
