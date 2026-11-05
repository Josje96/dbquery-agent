import { describe, expect, test } from "bun:test";
import { checkSql } from "./sql-guard";

describe("checkSql allows", () => {
  test.each([
    ["a SELECT", "SELECT * FROM pokemon", "SELECT * FROM pokemon"],
    ["a CTE", "WITH x AS (SELECT 1) SELECT * FROM x", "WITH x AS (SELECT 1) SELECT * FROM x"],
    ["a trailing semicolon", "SELECT 1;", "SELECT 1"],
    ["a comment after the semicolon", "SELECT 1; -- done", "SELECT 1"],
    ["a leading comment", "-- note\nSELECT 1", "-- note\nSELECT 1"],
    ["keywords inside strings", "SELECT 'DROP TABLE x; DELETE'", "SELECT 'DROP TABLE x; DELETE'"],
    ["keywords as quoted names", 'SELECT "update", [delete] FROM t', 'SELECT "update", [delete] FROM t'],
    ["an escaped quote", "SELECT 'it''s; fine'", "SELECT 'it''s; fine'"],
    ["the replace function", "SELECT replace(name, 'a', 'b') FROM t", "SELECT replace(name, 'a', 'b') FROM t"],
    ["names containing keywords", "SELECT updated_at, drop_rate FROM t", "SELECT updated_at, drop_rate FROM t"],
  ])("%s", (_, sql, expected) => {
    expect(checkSql(sql)).toEqual({ ok: true, sql: expected });
  });
});

describe("checkSql refuses", () => {
  test.each([
    ["a write", "DELETE FROM pokemon"],
    ["a write after a CTE", "WITH x AS (SELECT 1) DELETE FROM pokemon"],
    ["a second statement", "SELECT 1; DROP TABLE pokemon"],
    ["a second statement after a string", "SELECT 'a'; DROP TABLE pokemon"],
    ["a second statement that's only a string", "SELECT 1; 'a'"],
    ["SELECT INTO", "SELECT * INTO backup FROM pokemon"],
    ["REPLACE INTO after a CTE", "WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x"],
    ["a write hidden behind a comment", "/* SELECT */ DROP TABLE pokemon"],
    ["a pragma", "PRAGMA writable_schema = 1"],
    ["attach", "ATTACH DATABASE 'x' AS y"],
    ["exec in SQL Server", "SELECT 1 EXEC xp_cmdshell 'dir'"],
    ["an unterminated string", "SELECT 'oops"],
    ["an unterminated comment", "SELECT 1 /* oops"],
    ["an empty query", "  -- nothing"],
  ])("%s", (_, sql) => {
    expect(checkSql(sql).ok).toBe(false);
  });
});
