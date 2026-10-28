import { createDatabaseConnection, type DbInstance } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrations.js';

export interface TestDb extends DbInstance {
  cleanup: () => void;
}

export function createTestDatabase(): TestDb {
  const instance = createDatabaseConnection(':memory:');
  runMigrations(instance.rawDb);

  return {
    ...instance,
    cleanup: () => {
      instance.rawDb.close();
    },
  };
}
