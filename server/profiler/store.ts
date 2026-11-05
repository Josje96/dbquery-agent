import { Database } from "bun:sqlite";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseAdapter, TableInfo } from "../adapters/types";

const MAX_VALUES_PER_COLUMN = 20_000;
const MAX_VALUE_LENGTH = 60;
/** Columns with this many distinct values or fewer list them for the model. */
const LOW_CARDINALITY = 20;

/** Bump when the profile's own format changes, so existing profiles get rebuilt. */
const PROFILE_VERSION = 2;

export function schemaHash(tables: TableInfo[]): string {
  return new Bun.CryptoHasher("sha256").update(`${PROFILE_VERSION}:${JSON.stringify(tables)}`).digest("hex");
}

/** The schema hash a stored profile was built from, or null if there is none. */
export function storedSchemaHash(path: string): string | null {
  if (!Bun.file(path).size) return null;
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_hash'").get()?.value ?? null;
  } finally {
    db.close();
  }
}

export async function buildProfile(
  adapter: DatabaseAdapter,
  path: string,
  canSample: (table: string, column: string) => boolean,
  onProgress: (message: string) => void = () => {},
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  // Built beside the real file and renamed at the end, so readers never see a partial one.
  const tempPath = `${path}.tmp`;
  rmSync(tempPath, { force: true });

  const db = new Database(tempPath, { create: true });
  try {
    db.run(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tables (name TEXT PRIMARY KEY, row_count INTEGER NOT NULL, info TEXT NOT NULL);
      CREATE TABLE columns (
        table_name TEXT NOT NULL,
        name TEXT NOT NULL,
        null_count INTEGER NOT NULL,
        distinct_count INTEGER NOT NULL,
        min REAL,
        max REAL,
        common_values TEXT NOT NULL,
        PRIMARY KEY (table_name, name)
      );
      CREATE VIRTUAL TABLE search USING fts5(
        kind UNINDEXED,
        table_name UNINDEXED,
        column_name UNINDEXED,
        text,
        tokenize = 'porter unicode61'
      );
      CREATE VIRTUAL TABLE search_terms USING fts5vocab(search, row);
    `);

    const insertTable = db.prepare("INSERT INTO tables VALUES (?, ?, ?)");
    const insertColumn = db.prepare("INSERT INTO columns VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertSearch = db.prepare("INSERT INTO search VALUES (?, ?, ?, ?)");
    const tables = await adapter.introspectSchema();

    let done = 0;
    for (const table of tables) {
      // One table at a time, so the profiler never adds concurrent load.
      const profile = await adapter.profileTable(table, {
        canSample,
        maxValues: MAX_VALUES_PER_COLUMN,
        maxValueLength: MAX_VALUE_LENGTH,
      });

      db.transaction(() => {
        insertTable.run(table.name, profile.rowCount, JSON.stringify(table));
        insertSearch.run("table", table.name, null, table.name);
        for (const column of profile.columns) {
          const common = column.distinctCount <= LOW_CARDINALITY ? column.textValues : [];
          insertColumn.run(
            table.name,
            column.name,
            column.nullCount,
            column.distinctCount,
            column.min,
            column.max,
            JSON.stringify(common),
          );
          insertSearch.run("column", table.name, column.name, column.name);
          for (const value of column.textValues) {
            insertSearch.run("value", table.name, column.name, value);
          }
        }
      })();

      done++;
      if (done % 25 === 0 || done === tables.length) onProgress(`Profiled ${done} of ${tables.length} tables`);
    }

    db.prepare("INSERT INTO meta VALUES (?, ?)").run("schema_hash", schemaHash(tables));
    db.prepare("INSERT INTO meta VALUES (?, ?)").run("profiled_at", new Date().toISOString());
  } catch (error) {
    db.close();
    rmSync(tempPath, { force: true });
    throw error;
  }

  db.close();
  renameSync(tempPath, path);
}
