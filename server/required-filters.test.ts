import { describe, expect, test } from "bun:test";
import type { TableInfo } from "./adapters/types";
import { missingFilters } from "./required-filters";

const table = (name: string, ...columns: string[]): TableInfo => ({
  name,
  columns: columns.map((column) => ({ name: column, type: "TEXT", nullable: true, primaryKey: false })),
  foreignKeys: [],
});

const schema = [
  table("pokemon", "id"),
  table("species_names", "species_id", "local_language_id", "name"),
  table("move_names", "move_id", "local_language_id", "name"),
];
const filter = { column: "local_language_id", hint: "Use 9." };
const isMissing = (sql: string) => missingFilters(sql, schema, [filter]).length > 0;

describe("missingFilters flags", () => {
  test.each([
    ["no filter", "SELECT name FROM species_names"],
    ["a join without one", "SELECT s.name FROM pokemon p JOIN species_names s ON s.species_id = p.id"],
    ["two tables with one filter", "SELECT s.name, m.name FROM species_names s JOIN move_names m ON 1 = 1 WHERE s.local_language_id = 9"],
    ["a column comparison", "SELECT s.name FROM species_names s JOIN move_names m ON s.local_language_id = m.local_language_id"],
    ["a quoted table name", 'SELECT name FROM "species_names"'],
  ])("%s", (_, sql) => {
    expect(isMissing(sql)).toBe(true);
  });
});

describe("missingFilters accepts", () => {
  test.each([
    ["a table without the column", "SELECT id FROM pokemon"],
    ["a WHERE filter", "SELECT name FROM species_names WHERE local_language_id = 9"],
    ["a join filter", "SELECT s.name FROM pokemon p JOIN species_names s ON s.species_id = p.id AND s.local_language_id = 9"],
    ["another language", "SELECT name FROM species_names WHERE local_language_id = 1"],
    ["several languages", "SELECT name FROM species_names WHERE local_language_id IN (1, 9)"],
    ["a subquery", "SELECT name FROM species_names WHERE local_language_id = (SELECT id FROM languages WHERE identifier = 'en')"],
    ["lowercase keywords", "select name from species_names where local_language_id=9"],
    ["a filter on each of two tables", "SELECT s.name, m.name FROM species_names s JOIN move_names m ON m.local_language_id = 9 WHERE s.local_language_id = 9"],
  ])("%s", (_, sql) => {
    expect(isMissing(sql)).toBe(false);
  });
});
