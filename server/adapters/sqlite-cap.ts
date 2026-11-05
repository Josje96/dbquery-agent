/**
 * Wraps a query so the row cap applies inside SQLite and capped rows are never
 * loaded. The newlines stop a trailing line comment swallowing the wrapper.
 */
export function capRows(sql: string, limit: number): string {
  const inner = sql.trim().replace(/;\s*$/, "");
  return `SELECT * FROM (\n${inner}\n) LIMIT ${limit}`;
}
