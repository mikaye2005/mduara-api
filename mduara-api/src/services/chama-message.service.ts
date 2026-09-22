import type { Pool, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';

interface MessageRow extends QueryResultRow {
  id: string;
  chama_id: string;
  author_id: string | null;
  author_name: string | null;
  parent_message_id: string | null;
  kind: 'message' | 'announcement' | 'system';
  body: string;
  created_at: string;
  updated_at: string;
}

export class ChamaMessageService {
  constructor(private readonly db: Pool = pool) {}

  async list(chamaId: string, userId: string, page: number, perPage: number) {
    await this.requireActiveMembership(chamaId, userId);
    const offset = (page - 1) * perPage;
    const [messages, count] = await Promise.all([
      this.db.query<MessageRow>(
        `${messageSelect()}
          WHERE m.chama_id = $1
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $2 OFFSET $3`,
        [chamaId, perPage, offset],
      ),
      this.db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM chama_messages WHERE chama_id = $1`, [chamaId]),
    ]);
    const total = Number(count.rows[0]?.count ?? 0);
    return { messages: messages.rows.map(serializeMessage), meta: { total, page, perPage, totalPages: total ? Math.ceil(total / perPage) : 0 } };
  }

  async create(input: { chamaId: string; userId: string; body: string; parentMessageId?: string; kind: 'message' | 'announcement' }) {
    const membership = await this.requireActiveMembership(input.chamaId, input.userId);
    if (input.kind === 'announcement' && !['chairperson', 'secretary'].includes(membership.role)) {
      throw new ForbiddenError('Only Chama officials can send announcements', 'CHAMA_ANNOUNCEMENT_FORBIDDEN');
    }
    if (input.parentMessageId) {
      const parent = await this.db.query<{ id: string }>(
        `SELECT id FROM chama_messages WHERE id = $1 AND chama_id = $2`,
        [input.parentMessageId, input.chamaId],
      );
      if (!parent.rows[0]) throw new NotFoundError('Parent message not found', 'CHAMA_MESSAGE_PARENT_NOT_FOUND');
    }
    const message = (await this.db.query<MessageRow>(
      `INSERT INTO chama_messages (chama_id, author_id, parent_message_id, kind, body)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, chama_id, author_id, NULL::text AS author_name, parent_message_id,
                 kind, body, created_at::text, updated_at::text`,
      [input.chamaId, input.userId, input.parentMessageId ?? null, input.kind, input.body],
    )).rows[0];
    const author = await this.db.query<{ full_name: string }>(`SELECT full_name FROM users WHERE id = $1`, [input.userId]);
    message.author_name = author.rows[0]?.full_name ?? null;
    return serializeMessage(message);
  }

  private async requireActiveMembership(chamaId: string, userId: string) {
    const membership = (await this.db.query<{ role: string }>(
      `SELECT role::text AS role FROM chama_members
        WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'`,
      [chamaId, userId],
    )).rows[0];
    if (!membership) throw new ForbiddenError('You are not an active member of this Chama', 'CHAMA_MEMBERSHIP_INACTIVE');
    return membership;
  }
}

function messageSelect() {
  return `SELECT m.id, m.chama_id, m.author_id, u.full_name AS author_name, m.parent_message_id,
                 m.kind, m.body, m.created_at::text, m.updated_at::text
            FROM chama_messages m
            LEFT JOIN users u ON u.id = m.author_id`;
}

function serializeMessage(row: MessageRow) {
  return {
    id: row.id,
    chamaId: row.chama_id,
    author: row.author_id ? { id: row.author_id, fullName: row.author_name } : null,
    parentMessageId: row.parent_message_id,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const chamaMessageService = new ChamaMessageService();