import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { Database } from './types.js';

export interface DbInstance {
  db: Kysely<Database>;
  rawDb: BetterSqlite3.Database;
}

export function createDatabaseConnection(dbPath: string = ':memory:'): DbInstance {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const rawDb = new BetterSqlite3(dbPath);

  if (dbPath !== ':memory:') {
    rawDb.pragma('journal_mode = WAL');
  }
  rawDb.pragma('busy_timeout = 5000');
  rawDb.pragma('foreign_keys = ON');
  rawDb.pragma('synchronous = NORMAL');

  const dialect = new SqliteDialect({
    database: rawDb,
  });

  const db = new Kysely<Database>({
    dialect,
  });

  return { db, rawDb };
}
