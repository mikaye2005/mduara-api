import { Router } from 'express';
import type { Request } from 'express';
import { pool } from '../db/client';
import { sendSuccess } from '../utils/response.util';
import { asyncHandler } from '../utils/async-handler';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors';
import { businessObjectConfigs, type BusinessObjectConfig } from './business-config';
import { databaseChamaRoleMatchesAny, isDatabaseChamaRole } from './chama-roles';
import { assertSubscriptionWriteAccess } from '../services/subscription.service';

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

function quoteIdentifier(identifier: string): string {
	if (!IDENTIFIER_PATTERN.test(identifier)) {
		throw new Error(`Unsafe SQL identifier: ${identifier}`);
	}

	return `"${identifier}"`;
}

function buildSelectClause(config: BusinessObjectConfig): string {
	const selected = ['t.*'];

	for (const join of config.joins ?? []) {
		for (const column of join.columns ?? []) {
			const source = `${join.alias ?? join.table}.${quoteIdentifier(column.field)}`;
			const alias = quoteIdentifier(column.as ?? column.field);
			selected.push(`${source} AS ${alias}`);
		}
	}

	return selected.join(', ');
}

function buildJoinClause(config: BusinessObjectConfig): string {
	return (config.joins ?? [])
		.map((join) => `${join.type} JOIN ${quoteIdentifier(join.table)} ${join.alias ?? join.table} ON ${join.on}`)
		.join(' ');
}

function normalizePayload(config: BusinessObjectConfig, req: Request): Record<string, unknown> {
	const allowed = new Set(config.writableFields ?? []);
	const payload = Object.fromEntries(
		Object.entries((req.body ?? {}) as Record<string, unknown>).filter(([key]) => allowed.has(key)),
	);

	for (const [field, source] of Object.entries(config.authFieldBindings ?? {})) {
		payload[field] = req.user?.[source] ?? null;
	}

	const missing = (config.validations?.required ?? []).filter((field) => {
		const value = payload[field];
		return value === undefined || value === null || value === '';
	});

	if (missing.length > 0) {
		throw new BadRequestError(`Missing required fields: ${missing.join(', ')}`);
	}

	return payload;
}

function mapDatabaseError(error: unknown): never {
	const pgError = error as { code?: string; detail?: string };
	if (pgError.code === '23505') {
		throw new ConflictError(pgError.detail ?? 'A record with the same unique values already exists');
	}

	throw error;
}

async function enforceChamaPolicy(config: BusinessObjectConfig, req: Request): Promise<void> {
	const policy = config.chamaPolicy;
	if (!policy) return;
	if (!req.user?.id) throw new UnauthorizedError('Authentication is required');

	const chamaId = await resolveChamaId(config, req, policy.chamaIdField);
	if (!chamaId) {
		throw new BadRequestError(`A ${policy.chamaIdField} value is required`);
	}

	// Platform administration is an identity capability, never a chama_members role.
	if (policy.allowPlatformAdmin && req.user.isPlatformAdmin) return;

	const membership = await pool.query<{ role: string }>(
		`SELECT role
		 FROM chama_members
		 WHERE chama_id = $1
		   AND user_id = $2
		   AND membership_status = 'active'
		 LIMIT 1`,
		[chamaId, req.user.id],
	);

	const row = membership.rows[0];
	if (!row) {
		throw new ForbiddenError('You are not an active member of this Chama');
	}

	if (!isDatabaseChamaRole(row.role)) {
		throw new ForbiddenError('Invalid Chama membership role');
	}

	if (policy.allowedRoles && !databaseChamaRoleMatchesAny(row.role, policy.allowedRoles)) {
		throw new ForbiddenError('Your Chama role is not permitted to perform this action');
	}

	if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) {
		await assertSubscriptionWriteAccess(pool, chamaId);
	}
}

async function resolveChamaId(config: BusinessObjectConfig, req: Request, field: string): Promise<string | null> {
	const bodyValue = (req.body as Record<string, unknown> | undefined)?.[field];
	if (typeof bodyValue === 'string' && bodyValue.trim()) return bodyValue;

	const queryValue = req.query[field];
	if (typeof queryValue === 'string' && queryValue.trim()) return queryValue;

	if (req.params.id) {
		const result = await pool.query<{ chama_id: string | null }>(
			`SELECT ${quoteIdentifier(field)} AS chama_id FROM ${quoteIdentifier(config.tableName)} WHERE ${quoteIdentifier(config.primaryKey)} = $1`,
			[req.params.id],
		);
		return result.rows[0]?.chama_id ?? null;
	}

	return null;
}

class ConfigDrivenBusinessApi {
	constructor(private readonly config: BusinessObjectConfig) {}

	async list(req: Request) {
		const page = Math.max(Number(req.query.page ?? 1), 1);
		const perPage = Math.min(Math.max(Number(req.query.per_page ?? 25), 1), 200);
		const offset = (page - 1) * perPage;
		const sortField = this.resolveSortField(String(req.query.sort ?? this.config.defaultSortField ?? this.config.primaryKey));
		const sortOrder = String(req.query.order ?? this.config.defaultSortOrder ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

		const values: unknown[] = [];
		const where = this.buildWhere(req, values);
		const joinClause = buildJoinClause(this.config);
		const baseSql = `FROM ${quoteIdentifier(this.config.tableName)} t ${joinClause} ${where}`.trim();

		const totalResult = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count ${baseSql}`, values);
		values.push(perPage, offset);

		const rows = await pool.query(
			`SELECT ${buildSelectClause(this.config)} ${baseSql} ORDER BY t.${quoteIdentifier(sortField)} ${sortOrder} LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		);

		return {
			items: rows.rows,
			meta: {
				total: Number(totalResult.rows[0]?.count ?? 0),
				page,
				per_page: perPage,
			},
		};
	}

	async getById(id: string) {
		const joinClause = buildJoinClause(this.config);
		const result = await pool.query(
			`SELECT ${buildSelectClause(this.config)} FROM ${quoteIdentifier(this.config.tableName)} t ${joinClause} WHERE t.${quoteIdentifier(this.config.primaryKey)} = $1`,
			[id],
		);

		const row = result.rows[0];
		if (!row) throw new NotFoundError('Record not found');
		return row;
	}

	async create(req: Request) {
		const payload = normalizePayload(this.config, req);
		const fields = Object.keys(payload);
		if (fields.length === 0) throw new BadRequestError('No writable fields provided');

		const values = Object.values(payload);
		const columns = fields.map(quoteIdentifier).join(', ');
		const placeholders = fields.map((_field, index) => `$${index + 1}`).join(', ');

		try {
			const result = await pool.query<{ id: string }>(
				`INSERT INTO ${quoteIdentifier(this.config.tableName)} (${columns}) VALUES (${placeholders}) RETURNING ${quoteIdentifier(this.config.primaryKey)} AS id`,
				values,
			);

			return this.getById(result.rows[0].id);
		} catch (error) {
			mapDatabaseError(error);
		}
	}

	async update(id: string, req: Request) {
		const payload = normalizePayload({ ...this.config, validations: {} }, req);
		const fields = Object.keys(payload);
		if (fields.length === 0) throw new BadRequestError('No writable fields provided');

		const values = Object.values(payload);
		const setClause = fields.map((field, index) => `${quoteIdentifier(field)} = $${index + 1}`).join(', ');
		values.push(id);

		try {
			const result = await pool.query(
				`UPDATE ${quoteIdentifier(this.config.tableName)} SET ${setClause} WHERE ${quoteIdentifier(this.config.primaryKey)} = $${values.length}`,
				values,
			);

			if (result.rowCount === 0) throw new NotFoundError('Record not found');
			return this.getById(id);
		} catch (error) {
			mapDatabaseError(error);
		}
	}

	async remove(id: string) {
		const result = await pool.query(
			`DELETE FROM ${quoteIdentifier(this.config.tableName)} WHERE ${quoteIdentifier(this.config.primaryKey)} = $1`,
			[id],
		);

		if (result.rowCount === 0) throw new NotFoundError('Record not found');
		return { id };
	}

	private buildWhere(req: Request, values: unknown[]): string {
		const clauses: string[] = [];

		for (const field of this.config.filterableFields ?? []) {
			const value = req.query[field];
			if (value === undefined || value === '') continue;
			values.push(String(value));
			clauses.push(`t.${quoteIdentifier(field)} = $${values.length}`);
		}

		return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
	}

	private resolveSortField(candidate: string): string {
		const allowed = new Set([
			this.config.primaryKey,
			this.config.defaultSortField ?? this.config.primaryKey,
			...(this.config.filterableFields ?? []),
		]);

		if (!allowed.has(candidate)) {
			return this.config.defaultSortField ?? this.config.primaryKey;
		}

		return candidate;
	}
}

export const dynamicRouteGenerator = {
	generateRoutes(configKey: keyof typeof businessObjectConfigs) {
		const config = businessObjectConfigs[configKey];
		if (!config) {
			throw new Error(`Unknown business object config: ${configKey}`);
		}

		const api = new ConfigDrivenBusinessApi(config);
		const router = Router();

		router.use(asyncHandler(async (req, _res, next) => {
			await enforceChamaPolicy(config, req);
			next();
		}));

		router.get('/', asyncHandler(async (req, res) => {
			const result = await api.list(req);
			sendSuccess(res, result);
		}));

		router.get('/:id', asyncHandler(async (req, res) => {
			const result = await api.getById(req.params.id);
			sendSuccess(res, result);
		}));

		router.post('/', asyncHandler(async (req, res) => {
			const result = await api.create(req);
			sendSuccess(res, result, 201);
		}));

		router.patch('/:id', asyncHandler(async (req, res) => {
			const result = await api.update(req.params.id, req);
			sendSuccess(res, result);
		}));

		router.delete('/:id', asyncHandler(async (req, res) => {
			const result = await api.remove(req.params.id);
			sendSuccess(res, result);
		}));

		return router;
	},
};