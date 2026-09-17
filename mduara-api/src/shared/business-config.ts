import type { DatabaseChamaRole } from './chama-roles';

export interface BusinessObjectConfig {
	tableName: string;
	primaryKey: string;
	defaultSortField?: string;
	defaultSortOrder?: 'ASC' | 'DESC';
	validations?: {
		required?: string[];
		unique?: string[];
	};
	joins?: Array<{
		table: string;
		alias?: string;
		on: string;
		type: 'INNER' | 'LEFT' | 'RIGHT';
		columns?: { field: string; as?: string }[];
	}>;
	filterableFields?: string[];
	writableFields?: string[];
	authFieldBindings?: Record<string, 'id' | 'email' | 'phone'>;
	chamaPolicy?: {
		chamaIdField: string;
		allowedRoles?: DatabaseChamaRole[];
		allowPlatformAdmin?: boolean;
	};
}

export const businessObjectConfigs: Record<string, BusinessObjectConfig> = {
	// support_tickets and chama_meetings use dedicated domain services/routes.
	// They are intentionally absent here so dynamic CRUD cannot bypass their invariants.
	chama_broadcasts: {
		tableName: 'chama_broadcasts',
		primaryKey: 'id',
		defaultSortField: 'created_at',
		defaultSortOrder: 'DESC',
		validations: {
			required: ['chama_id', 'title', 'content'],
		},
		filterableFields: ['chama_id', 'author_id'],
		writableFields: ['chama_id', 'title', 'content'],
		authFieldBindings: {
			author_id: 'id',
		},
		chamaPolicy: {
			chamaIdField: 'chama_id',
			allowedRoles: ['member'],
			allowPlatformAdmin: true,
		},
		joins: [
			{
				table: 'users',
				alias: 'author',
				on: 't.author_id = author.id',
				type: 'LEFT',
				columns: [
					{ field: 'full_name', as: 'author_name' },
					{ field: 'email', as: 'author_email' },
				],
			},
		],
	},
	contribution_rules: {
		tableName: 'contribution_rules',
		primaryKey: 'id',
		defaultSortField: 'effective_from',
		defaultSortOrder: 'DESC',
		validations: {
			required: ['chama_id', 'amount', 'frequency', 'effective_from'],
		},
		filterableFields: ['chama_id', 'frequency', 'created_by'],
		writableFields: ['chama_id', 'amount', 'frequency', 'due_day', 'late_fee', 'late_fee_type', 'late_fee_percentage', 'grace_period_days', 'effective_from', 'effective_to'],
		authFieldBindings: {
			created_by: 'id',
		},
		chamaPolicy: {
			chamaIdField: 'chama_id',
			allowedRoles: ['treasurer', 'secretary', 'chairperson'],
			allowPlatformAdmin: true,
		},
	},

};
