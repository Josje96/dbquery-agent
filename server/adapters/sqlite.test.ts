import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app";
import { createSqliteAdapter } from "./sqlite";
import type { DatabaseAdapter } from "./types";

let dir: string;
let path: string;
let adapter: DatabaseAdapter;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dbquery-test-"));
  path = join(dir, "fixture.sqlite");
  const db = new Database(path);
  db.run(`
    CREATE TABLE types (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE pokemon (
      id INTEGER PRIMARY KEY,
      name TEXT,
      type_id INTEGER NOT NULL REFERENCES types (id)
    );
    INSERT INTO types VALUES (1, 'Fire'), (2, 'Water');
    INSERT INTO pokemon VALUES (1, 'Charmander', 1), (2, 'Vulpix', 1), (3, 'Squirtle', 2);
  `);
  db.close();
  adapter = createSqliteAdapter(path);
});

afterAll(() => {
  adapter.close();
  rmSync(dir, { recursive: true });
});

const limits = (maxRows: number) => ({ maxRows, timeoutMs: 5000 });
const countPokemon = async () => (await adapter.execute("SELECT * FROM pokemon", limits(100))).rows.length;

describe("execute", () => {
  test("returns columns and rows", async () => {
    const result = await adapter.execute("SELECT id, name FROM pokemon WHERE id = 1", limits(10));
    expect(result).toEqual({ columns: ["id", "name"], rows: [[1, "Charmander"]], truncated: false });
  });

  test("caps rows and reports truncation", async () => {
    const result = await adapter.execute("SELECT * FROM pokemon", limits(2));
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  test("does not report truncation when rows exactly fit", async () => {
    const result = await adapter.execute("SELECT * FROM pokemon", limits(3));
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  test("keeps both values when joined columns share a name", async () => {
    const result = await adapter.execute(
      "SELECT p.name, t.name FROM pokemon p JOIN types t ON t.id = p.type_id WHERE p.id = 1",
      limits(10),
    );
    expect(result.rows).toEqual([["Charmander", "Fire"]]);
  });

  test("accepts trailing semicolons and line comments", async () => {
    const semicolon = await adapter.execute("SELECT 1 AS n;", limits(1));
    const comment = await adapter.execute("SELECT 1 AS n -- note", limits(1));
    expect(semicolon.rows).toEqual([[1]]);
    expect(comment.rows).toEqual([[1]]);
  });

  test("rejects writes", async () => {
    await expect(adapter.execute("DELETE FROM pokemon", limits(1))).rejects.toThrow();
    expect(await countPokemon()).toBe(3);
  });

  test("a statement breaking out of the wrapper cannot write", async () => {
    await adapter.execute("SELECT 1); DELETE FROM pokemon; --", limits(1)).catch(() => {});
    expect(await countPokemon()).toBe(3);
  });

  test("rejects an invalid row cap", async () => {
    await expect(adapter.execute("SELECT 1", limits(0))).rejects.toThrow("maxRows");
  });

  test("kills a query that runs past the timeout", async () => {
    const endless = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c";
    const started = performance.now();
    await expect(adapter.execute(endless, { maxRows: 1, timeoutMs: 200 })).rejects.toThrow("timed out");
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("validate", () => {
  test("accepts a valid query without running it", async () => {
    await expect(adapter.validate("SELECT name FROM pokemon")).resolves.toBeUndefined();
  });

  test("rejects an unknown column", async () => {
    await expect(adapter.validate("SELECT nope FROM pokemon")).rejects.toThrow("nope");
  });
});

describe("profileTable", () => {
  const options = { maxValues: 100, maxValueLength: 60 };

  test("samples only allowed columns", async () => {
    const [pokemon] = (await adapter.introspectSchema()).filter((table) => table.name === "pokemon");
    const profile = await adapter.profileTable(pokemon!, {
      ...options,
      canSample: (_, column) => column === "name",
    });
    const byName = Object.fromEntries(profile.columns.map((column) => [column.name, column]));

    expect(profile.rowCount).toBe(3);
    expect(byName.name?.textValues.sort()).toEqual(["Charmander", "Squirtle", "Vulpix"]);
    expect(byName.type_id).toEqual({
      name: "type_id",
      nullCount: 0,
      distinctCount: 2,
      min: null,
      max: null,
      textValues: [],
    });
  });
});

describe("introspectSchema", () => {
  test("returns tables, columns and foreign keys", async () => {
    const tables = await adapter.introspectSchema();
    expect(tables.map((table) => table.name)).toEqual(["pokemon", "types"]);
    expect(tables[0]?.columns[0]).toEqual({ name: "id", type: "INTEGER", nullable: false, primaryKey: true });
    expect(tables[0]?.foreignKeys).toEqual([
      { columns: ["type_id"], referencedTable: "types", referencedColumns: ["id"] },
    ]);
  });
});

describe("api", () => {
  const app = () =>
    createApp({
      connections: [
        { id: "test", name: "Test", adapter, profilePath: join(dir, "missing.sqlite"), notes: "", requiredFilters: [] },
      ],
      model: null,
    });
  const post = (path: string, body: unknown) =>
    app().request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("lists connections without exposing config", async () => {
    const response = await app().request("/api/connections");
    expect(await response.json()).toEqual([{ id: "test", name: "Test", dialect: "sqlite", profileReady: false }]);
  });

  test("returns 404 for an unknown connection", async () => {
    const response = await app().request("/api/connections/nope/schema");
    expect(response.status).toBe(404);
  });

  test("runs a SELECT", async () => {
    const response = await post("/api/connections/test/run", { sql: "SELECT 1 AS n" });
    expect(await response.json()).toEqual({ columns: ["n"], rows: [[1]], truncated: false });
  });

  test("refuses a write before it reaches the database", async () => {
    const response = await post("/api/connections/test/run", { sql: "DELETE FROM pokemon" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Only SELECT queries are allowed." });
  });

  test("refuses a body that isn't JSON", async () => {
    const response = await app().request("/api/connections/test/run", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    expect(response.status).toBe(400);
  });

  test("asking without a model explains what's missing", async () => {
    const response = await post("/api/connections/test/ask", { question: "fire types" });
    expect(response.status).toBe(503);
  });
});
