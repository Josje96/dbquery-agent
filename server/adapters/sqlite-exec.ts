// Runs one query in its own process. bun:sqlite is synchronous and can't be
// interrupted, so this is what lets the parent enforce a timeout with SIGKILL.
import { Database } from "bun:sqlite";
import { capRows } from "./sqlite-cap";

const { path, sql, maxRows } = (await Bun.stdin.json()) as { path: string; sql: string; maxRows: number };

function jsonSafe(value: unknown): unknown {
  return value instanceof Uint8Array ? `<blob, ${value.byteLength} bytes>` : value;
}

try {
  const db = new Database(path, { readonly: true });
  const statement = db.prepare(capRows(sql, maxRows + 1));
  const rows = statement.values() as unknown[][];
  console.log(
    JSON.stringify({
      columns: statement.columnNames,
      rows: rows.slice(0, maxRows).map((row) => row.map(jsonSafe)),
      truncated: rows.length > maxRows,
    }),
  );
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
