import { Database } from "bun:sqlite";
import { capRows } from "./sqlite-cap";
import type { ColumnProfile, DatabaseAdapter, ForeignKey, QueryResult, TableInfo } from "./types";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface ForeignKeyRow {
  id: number;
  table: string;
  from: string;
  to: string | null;
}

const EXEC_SCRIPT = new URL("./sqlite-exec.ts", import.meta.url).pathname;

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const numberOrNull = (value: unknown) => (typeof value === "number" ? value : null);

export function createSqliteAdapter(path: string): DatabaseAdapter {
  const db = new Database(path, { readonly: true });

  return {
    dialect: "sqlite",

    async introspectSchema(): Promise<TableInfo[]> {
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();

      return tables.map(({ name }) => {
        const columns = db.query<ColumnRow, []>(`PRAGMA table_info(${quote(name)})`).all();
        const keyRows = db.query<ForeignKeyRow, []>(`PRAGMA foreign_key_list(${quote(name)})`).all();

        // Composite foreign keys come back as one row per column, sharing an id.
        const foreignKeys = new Map<number, ForeignKey>();
        for (const row of keyRows) {
          const key = foreignKeys.get(row.id) ?? {
            columns: [],
            referencedTable: row.table,
            referencedColumns: [],
          };
          key.columns.push(row.from);
          key.referencedColumns.push(row.to);
          foreignKeys.set(row.id, key);
        }

        return {
          name,
          columns: columns.map((column) => ({
            name: column.name,
            type: column.type,
            nullable: column.notnull === 0 && column.pk === 0,
            primaryKey: column.pk > 0,
          })),
          foreignKeys: [...foreignKeys.values()],
        };
      });
    },

    async profileTable(table, { canSample, maxValues, maxValueLength }) {
      const from = quote(table.name);
      const { n: rowCount } = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${from}`).get()!;

      const columns = table.columns.map((column): ColumnProfile => {
        const col = quote(column.name);
        const counts = db
          .query<{ nulls: number; distinct_values: number }, []>(
            `SELECT COUNT(*) - COUNT(${col}) AS nulls, COUNT(DISTINCT ${col}) AS distinct_values FROM ${from}`,
          )
          .get()!;
        const profile: ColumnProfile = {
          name: column.name,
          nullCount: counts.nulls,
          distinctCount: counts.distinct_values,
          min: null,
          max: null,
          textValues: [],
        };
        if (!canSample(table.name, column.name)) return profile;

        const range = db
          .query<{ low: unknown; high: unknown }, []>(
            `SELECT MIN(${col}) AS low, MAX(${col}) AS high FROM ${from} WHERE typeof(${col}) IN ('integer', 'real')`,
          )
          .get()!;
        profile.min = numberOrNull(range.low);
        profile.max = numberOrNull(range.high);
        profile.textValues = db
          .query<{ value: string }, [number, number]>(
            `SELECT DISTINCT ${col} AS value FROM ${from} WHERE typeof(${col}) = 'text' AND length(${col}) <= ? LIMIT ?`,
          )
          .all(maxValueLength, maxValues)
          .map(({ value }) => value);
        return profile;
      });

      return { rowCount, columns };
    },

    async validate(sql) {
      db.prepare(capRows(sql, 1)).finalize();
    },

    async execute(sql, { maxRows, timeoutMs }): Promise<QueryResult> {
      if (!Number.isInteger(maxRows) || maxRows < 1) {
        throw new Error("maxRows must be a positive integer");
      }

      const child = Bun.spawn([process.execPath, "--no-env-file", EXEC_SCRIPT], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: {},
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      try {
        child.stdin.write(JSON.stringify({ path, sql, maxRows }));
        await child.stdin.end();
        const output = await new Response(child.stdout).text();
        await child.exited;
        if (timedOut) throw new Error(`Query timed out after ${timeoutMs} ms`);

        const result = JSON.parse(output) as QueryResult | { error: string };
        if ("error" in result) throw new Error(result.error);
        return result;
      } finally {
        clearTimeout(timer);
      }
    },

    close() {
      db.close();
    },
  };
}
