import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteAdapter } from "./adapters/sqlite";
import type { DatabaseAdapter } from "./adapters/types";
import { askQuestion } from "./ask";
import { findTables, questionTokens, renderSchema } from "./finder";
import { parseGeneratedQuery, type ChatMessage, type GeneratedQuery, type ModelProvider } from "./model";
import { buildProfile, schemaHash, storedSchemaHash } from "./profiler/store";

let dir: string;
let adapter: DatabaseAdapter;
let profilePath: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dbquery-ask-"));
  const path = join(dir, "fixture.sqlite");
  const db = new Database(path);
  db.run(`
    CREATE TABLE languages (id INTEGER PRIMARY KEY, identifier TEXT);
    CREATE TABLE types (id INTEGER PRIMARY KEY, identifier TEXT);
    CREATE TABLE type_names (
      type_id INTEGER REFERENCES types (id),
      local_language_id INTEGER REFERENCES languages (id),
      name TEXT,
      PRIMARY KEY (type_id, local_language_id)
    );
    CREATE TABLE pokemon (id INTEGER PRIMARY KEY, height INTEGER);
    CREATE TABLE pokemon_types (
      pokemon_id INTEGER REFERENCES pokemon (id),
      type_id INTEGER REFERENCES types (id),
      PRIMARY KEY (pokemon_id, type_id)
    );
    CREATE TABLE berries (id INTEGER PRIMARY KEY, secret TEXT);
    INSERT INTO languages VALUES (9, 'en');
    INSERT INTO types VALUES (10, 'fire'), (11, 'water');
    INSERT INTO type_names VALUES (10, 9, 'Fire'), (11, 9, 'Water');
    INSERT INTO pokemon VALUES (4, 6), (7, 5);
    INSERT INTO pokemon_types VALUES (4, 10), (7, 11);
    INSERT INTO berries VALUES (1, 'hidden-value');
  `);
  db.close();

  adapter = createSqliteAdapter(path);
  profilePath = join(dir, "profile.sqlite");
  await buildProfile(adapter, profilePath, (table) => table !== "berries");
});

afterAll(() => {
  adapter.close();
  rmSync(dir, { recursive: true });
});

describe("profile", () => {
  test("records the schema hash", async () => {
    expect(storedSchemaHash(profilePath)).toBe(schemaHash(await adapter.introspectSchema()));
  });

  test("has no hash when no profile exists", () => {
    expect(storedSchemaHash(join(dir, "missing.sqlite"))).toBeNull();
  });

  test("never stores values from columns that can't be sampled", () => {
    const db = new Database(profilePath, { readonly: true });
    const hits = db.query("SELECT * FROM search WHERE search MATCH 'hidden'").all();
    db.close();
    expect(hits).toEqual([]);
  });
});

describe("findTables", () => {
  const names = (question: string) => findTables(profilePath, question).map((table) => table.name);

  test("ignores common words", () => {
    expect(questionTokens("Show me all of the Fire types!")).toEqual(["fire", "types"]);
  });

  test("ignores accents", () => {
    expect(questionTokens("Pokémon")).toEqual(["pokemon"]);
  });

  test("finds a table from a value and connects it by foreign keys", () => {
    const found = names("Which pokemon are Fire?");
    expect(found).toEqual(expect.arrayContaining(["pokemon", "pokemon_types", "types", "type_names"]));
    expect(found).not.toContain("berries");
  });

  test("returns nothing when no word matches", () => {
    expect(names("zzzqqq")).toEqual([]);
  });

  test("finds a table despite a misspelling", () => {
    expect(names("pokemn")).toContain("pokemon");
  });

  test("tells the model the correct spelling of a misspelled value", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "dbquery-typo-"));
    const path = join(dir2, "typo.sqlite");
    const db = new Database(path);
    db.run("CREATE TABLE customer_names (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO customer_names VALUES (1, 'Squirtle')");
    db.close();
    const typoAdapter = createSqliteAdapter(path);
    const typoProfile = join(dir2, "profile.sqlite");
    await buildProfile(typoAdapter, typoProfile, () => true);
    typoAdapter.close();

    const schema = renderSchema(findTables(typoProfile, "sqirtle"));
    rmSync(dir2, { recursive: true });

    expect(schema).toContain("TABLE customer_names");
    expect(schema).toContain("Squirtle");
  });

  test("leaves unrelated words alone", () => {
    expect(names("zzzqqq")).toEqual([]);
  });

  test("keeps a match that has no join path to the others", () => {
    expect(names("pokemon and berries")).toEqual(expect.arrayContaining(["pokemon", "berries"]));
  });

  test("a note pulls in its tables when it shares a word with the question", () => {
    const notes = "- Fruit is stored in `berries`.";
    expect(findTables(profilePath, "pokemon fruit", notes).map((table) => table.name)).toContain("berries");
    expect(findTables(profilePath, "pokemon height", notes).map((table) => table.name)).not.toContain("berries");
  });

  test("tells the model about matched values and keys", () => {
    const schema = renderSchema(findTables(profilePath, "Fire pokemon"));
    expect(schema).toContain("TABLE type_names");
    expect(schema).toContain("Fire");
    expect(schema).toContain("-> types.id");
  });
});

describe("parseGeneratedQuery", () => {
  test("reads a fenced reply", () => {
    expect(parseGeneratedQuery('```json\n{"sql":"SELECT 1","explanation":"One."}\n```')).toEqual({
      sql: "SELECT 1",
      explanation: "One.",
    });
  });

  test("rejects a reply without sql", () => {
    expect(() => parseGeneratedQuery('{"explanation":"x"}')).toThrow("missing");
  });
});

describe("askQuestion", () => {
  function scriptedModel(replies: (GeneratedQuery | Error)[]) {
    const calls: ChatMessage[][] = [];
    const model: ModelProvider = {
      async generateQuery(messages) {
        calls.push([...messages]);
        const reply = replies[calls.length - 1];
        if (!reply) throw new Error("Unexpected extra model call");
        if (reply instanceof Error) throw reply;
        return reply;
      },
    };
    return { model, calls };
  }
  const ask = (model: ModelProvider, question = "Which pokemon are Fire?") =>
    askQuestion({ question, adapter, model, profilePath, notes: "Language 9 is English." });

  test("returns valid SQL on the first try and sends notes and schema", async () => {
    const { model, calls } = scriptedModel([{ sql: "SELECT id FROM pokemon;", explanation: "Ids." }]);
    const result = await ask(model);

    expect(result).toMatchObject({ status: "ok", sql: "SELECT id FROM pokemon", attempts: 1 });
    expect(calls[0]?.[0]?.content).toContain("Language 9 is English.");
    expect(calls[0]?.[0]?.content).toContain("TABLE type_names");
  });

  test("retries with the database error", async () => {
    const { model, calls } = scriptedModel([
      { sql: "SELECT nope FROM pokemon", explanation: "Bad." },
      { sql: "SELECT id FROM pokemon", explanation: "Good." },
    ]);
    const result = await ask(model);

    expect(result).toMatchObject({ status: "ok", sql: "SELECT id FROM pokemon", attempts: 2 });
    expect(calls[1]?.at(-1)?.content).toContain("nope");
  });

  test("retries when the guard refuses a write", async () => {
    const { model, calls } = scriptedModel([
      { sql: "DELETE FROM pokemon", explanation: "Bad." },
      { sql: "SELECT id FROM pokemon", explanation: "Good." },
    ]);
    const result = await ask(model);

    expect(result).toMatchObject({ status: "ok", attempts: 2 });
    expect(calls[1]?.at(-1)?.content).toContain("Only SELECT");
  });

  test("retries on invalid JSON", async () => {
    const { model } = scriptedModel([new SyntaxError("bad json"), { sql: "SELECT 1", explanation: "One." }]);
    expect(await ask(model)).toMatchObject({ status: "ok", attempts: 2 });
  });

  test("gives up after three attempts and keeps the last SQL", async () => {
    const bad = { sql: "SELECT nope FROM pokemon", explanation: "Bad." };
    const { model, calls } = scriptedModel([bad, bad, bad]);
    const result = await ask(model);

    expect(result).toMatchObject({ status: "failed", lastSql: bad.sql, attempts: 3 });
    expect(calls).toHaveLength(3);
  });

  test("passes on the model's reason when it can't answer", async () => {
    const { model } = scriptedModel([{ sql: "", explanation: "No sales data here." }]);
    expect(await ask(model)).toMatchObject({ status: "unanswerable", explanation: "No sales data here." });
  });

  test("doesn't call the model when nothing matches", async () => {
    const { model, calls } = scriptedModel([]);
    expect(await ask(model, "zzzqqq")).toMatchObject({ status: "unanswerable", attempts: 0 });
    expect(calls).toHaveLength(0);
  });

  test("doesn't run the query while generating it", async () => {
    const { model } = scriptedModel([{ sql: "SELECT id FROM pokemon WHERE id = -1", explanation: "None." }]);
    expect(await ask(model)).toMatchObject({ status: "ok", attempts: 1 });
  });

  describe("required filters", () => {
    const requiredFilters = [{ column: "local_language_id", hint: "Use 9 for English." }];
    const unfiltered = { sql: "SELECT name FROM type_names", explanation: "All." };
    const filtered = { sql: "SELECT name FROM type_names WHERE local_language_id = 9", explanation: "English." };
    const askFiltered = (model: ModelProvider) =>
      askQuestion({ question: "Fire types", adapter, model, profilePath, notes: "", requiredFilters });

    test("sends a query back when the filter is missing", async () => {
      const { model, calls } = scriptedModel([unfiltered, filtered]);
      const result = await askFiltered(model);

      expect(result).toMatchObject({ status: "ok", sql: filtered.sql, attempts: 2 });
      expect(result).not.toHaveProperty("warning");
      expect(calls[1]?.at(-1)?.content).toContain("Use 9 for English.");
    });

    test("doesn't retry a query that already has it", async () => {
      const { model, calls } = scriptedModel([filtered]);
      await askFiltered(model);
      expect(calls).toHaveLength(1);
    });

    test("accepts it with a warning if the model insists", async () => {
      const { model, calls } = scriptedModel([unfiltered, unfiltered]);
      const result = await askFiltered(model);

      expect(result).toMatchObject({ status: "ok", sql: unfiltered.sql, attempts: 2 });
      expect(result).toHaveProperty("warning");
      expect(calls).toHaveLength(2);
    });
  });

  test("lets request failures surface instead of retrying", async () => {
    const { model, calls } = scriptedModel([new Error("Model request failed (401)")]);
    await expect(ask(model)).rejects.toThrow("401");
    expect(calls).toHaveLength(1);
  });
});
