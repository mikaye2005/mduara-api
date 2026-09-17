import type { Pool } from 'pg';
import { pool } from '../db/client';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors';
import type { UpdateMyProfileInput } from '../validation/user.validation';

interface ProfileRow {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  national_id: string | null;
  date_of_birth: string | null;
  avatar_url: string | null;
  status: string;
  is_email_verified: boolean;
  created_at: string;
  updated_at: string;
}

export class UserProfileService {
  constructor(private readonly db: Pool = pool) {}

  async updateOwnProfile(userId: string, input: UpdateMyProfileInput) {
    const entries: Array<[string, unknown]> = [];
    if (input.fullName !== undefined) entries.push(['full_name', input.fullName]);
    if (input.nationalId !== undefined) entries.push(['national_id', input.nationalId]);
    if (input.dateOfBirth !== undefined) entries.push(['date_of_birth', input.dateOfBirth]);

    if (entries.length === 0) {
      throw new BadRequestError('At least one profile field must be provided', undefined, 'PROFILE_UPDATE_EMPTY');
    }

    const values: unknown[] = entries.map(([, value]) => value);
    values.push(userId);
    const assignments = entries.map(([column], index) => `${column} = $${index + 1}`);

    try {
      const result = await this.db.query<ProfileRow>(
        `UPDATE users
            SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
          WHERE id = $${values.length} AND status <> 'deleted'
          RETURNING id, full_name, phone, email, national_id, date_of_birth::text,
                    avatar_url, status::text AS status, is_email_verified, created_at, updated_at`,
        values,
      );

      const profile = result.rows[0];
      if (!profile) throw new NotFoundError('User profile not found', 'USER_PROFILE_NOT_FOUND');
      return this.mapProfile(profile);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictError('National ID is already associated with another account', 'NATIONAL_ID_CONFLICT');
      }
      throw error;
    }
  }

  private mapProfile(row: ProfileRow) {
    return {
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      email: row.email,
      nationalId: row.national_id,
      dateOfBirth: row.date_of_birth,
      avatarUrl: row.avatar_url,
      status: row.status,
      isEmailVerified: row.is_email_verified,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const userProfileService = new UserProfileService();
