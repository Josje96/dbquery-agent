import type { TableInfo } from "./adapters/types";

export interface RequiredFilter {
  /** Queries using a table with this column must filter on it. */
  column: string;
  /** Told to the model when the filter is missing. */
  hint: string;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Returns the filters a query is missing. Each use of an affected table needs its
 * own filter, so a query joining two translation tables can't pass with one.
 * It reads the SQL as text, so FROM a, b style joins aren't counted.
 */
export function missingFilters(sql: string, schema: TableInfo[], filters: RequiredFilter[]): RequiredFilter[] {
  return filters.filter(({ column }) => {
    const uses = schema
      .filter((table) => table.columns.some((candidate) => candidate.name === column))
      .reduce((count, table) => {
        const pattern = new RegExp(`\\b(?:FROM|JOIN)\\s+["\`\\[]?${escapeRegex(table.name)}\\b`, "gi");
        return count + (sql.match(pattern)?.length ?? 0);
      }, 0);

    // A comparison to a value or subquery. Comparing two columns doesn't choose a language.
    const filterPattern = new RegExp(`\\b${escapeRegex(column)}\\b["\`\\]]?\\s*(?:=\\s*[\\d'(]|IN\\s*\\()`, "gi");
    return (sql.match(filterPattern)?.length ?? 0) < uses;
  });
}
