// A second layer behind the read-only connection, not a replacement for it.
// It scans tokens rather than parsing, so it works across SQL dialects.

const FORBIDDEN = new Set([
  "ALTER", "ATTACH", "BACKUP", "BULK", "CREATE", "DELETE", "DENY", "DETACH", "DROP", "EXEC", "EXECUTE",
  "GRANT", "INSERT", "INTO", "MERGE", "OPENROWSET", "PRAGMA", "REINDEX", "RESTORE", "REVOKE", "SHUTDOWN",
  "TRUNCATE", "UPDATE", "VACUUM",
]);

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

const CLOSING_QUOTE: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };

export function checkSql(sql: string): GuardResult {
  const words: string[] = [];
  let statementEnd = -1;
  let i = 0;

  while (i < sql.length) {
    const char = sql[i]!;

    if (char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
    } else if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return { ok: false, reason: "Unterminated comment." };
      i = end + 2;
    } else if (char in CLOSING_QUOTE) {
      const close = CLOSING_QUOTE[char]!;
      i++;
      for (;;) {
        const end = sql.indexOf(close, i);
        if (end === -1) return { ok: false, reason: "Unterminated quoted text." };
        i = end + 1;
        // A doubled quote is an escaped quote, not the end.
        if (sql[i] !== close) break;
        i++;
      }
      if (statementEnd !== -1) return { ok: false, reason: "Only one statement is allowed." };
    } else if (char === ";") {
      if (statementEnd === -1) statementEnd = i;
      i++;
    } else if (/\s/.test(char)) {
      i++;
    } else {
      if (statementEnd !== -1) return { ok: false, reason: "Only one statement is allowed." };
      const word = /^[\p{L}\p{N}_$#@]+/u.exec(sql.slice(i))?.[0];
      if (word) {
        words.push(word.toUpperCase());
        i += word.length;
      } else {
        i++;
      }
    }
  }

  if (words[0] !== "SELECT" && words[0] !== "WITH") {
    return { ok: false, reason: "Only SELECT queries are allowed." };
  }
  const forbidden = words.find((word) => FORBIDDEN.has(word));
  if (forbidden) return { ok: false, reason: `${forbidden} is not allowed in a query.` };

  return { ok: true, sql: (statementEnd === -1 ? sql : sql.slice(0, statementEnd)).trim() };
}
