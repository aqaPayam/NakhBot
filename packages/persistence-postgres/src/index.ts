export {
  createDatabase,
  PostgresUnitOfWork,
  type DatabaseConfig,
  type DatabaseSchema,
  type NakhDatabase,
} from './database.js';
export {
  PostgresFoundationStore,
  PostgresInboxStore,
  PostgresOutboxStore,
  SystemIdGenerator,
  type ClaimedOutboxEvent,
  type InboxProcessingHooks,
} from './foundation-store.js';
export { PostgresIdentityStore, PostgresLocalizationStore } from './identity-store.js';
export { PostgresSignupStore } from './signup-store.js';
export { PostgresProfileStore } from './profile-store.js';
export {
  migrationStatus,
  runMigrations,
  verifyMigrations,
  type MigrationResult,
} from './migrations.js';
