// Picks the tables relevant to a question from the local profile, with no AI:
// search names and values, then follow foreign keys to connect the matches.
import { Database } from "bun:sqlite";
import type { TableInfo } from "./adapters/types";

const MAX_SEEDS = 6;
const MAX_TABLES = 14;
const MAX_PATH_COST = 3.5;
/** Outranks ordinary matches: a table named by the question or by a matching note. */
const STRONG_MATCH = 10;
/** Tables referenced this often (languages, say) connect everything, so paths avoid them. */
const HUB_REFERENCES = 30;
const MATCHED_VALUES_PER_COLUMN = 3;

const STOP_WORDS = new Set(
  (
    "a about all an and any are as at be by can could do does each every find for from get give has have how i in is " +
    "it its list many me much my of on or our please show than that the their them there these they this to top use " +
    "using want was we were what when where which who whose why will with would you"
  ).split(" "),
);

export interface FoundColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  references: string | null;
  distinctCount: number;
  min: number | null;
  max: number | null;
  commonValues: string[];
  matchedValues: string[];
}

export interface FoundTable {
  name: string;
  rowCount: number;
  columns: FoundColumn[];
}

export function questionTokens(question: string): string[] {
  // Drops accents, so "Pokémon" matches a table called pokemon.
  const plain = question.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const words = plain.match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].filter((word) => !STOP_WORDS.has(word));
}

interface SearchRow {
  kind: "table" | "column" | "value";
  table_name: string;
  column_name: string | null;
  text: string;
}

const singular = (word: string) => word.replace(/s$/, "");

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The closest indexed term to a misspelled word, or null. Short words get less
 * leeway, because one letter can turn them into a different real word.
 */
function closestTerm(db: Database, token: string): string | null {
  if (token.length < 5) return null;
  const allowed = token.length < 7 ? 1 : 2;

  let best: { term: string; distance: number; documents: number } | null = null;
  const terms = db.query<{ term: string; doc: number }, []>("SELECT term, doc FROM search_terms");
  for (const { term, doc: documents } of terms.iterate()) {
    if (Math.abs(term.length - token.length) > allowed) continue;
    const distance = editDistance(token, term);
    if (distance > allowed) continue;
    if (!best || distance < best.distance || (distance === best.distance && documents > best.documents)) {
      best = { term, distance, documents };
    }
  }
  return best?.term ?? null;
}

/** Tables named in backticks on note lines that share a word with the question. */
function tablesFromNotes(notes: string, tokens: string[], tables: Map<string, TableInfo>): Set<string> {
  const wanted = new Set(tokens.map(singular));
  const found = new Set<string>();
  for (const line of notes.split("\n")) {
    if (!questionTokens(line).some((word) => wanted.has(singular(word)))) continue;
    for (const [, name] of line.matchAll(/`(\w+)(?:\.\w+)?`/g)) {
      if (name && tables.has(name)) found.add(name);
    }
  }
  return found;
}

export function findTables(profilePath: string, question: string, notes = ""): FoundTable[] {
  const db = new Database(profilePath, { readonly: true });
  try {
    const tables = new Map(
      db
        .query<{ name: string; info: string }, []>("SELECT name, info FROM tables")
        .all()
        .map(({ name, info }) => [name, JSON.parse(info) as TableInfo]),
    );

    const search = db.query<SearchRow, [string]>(
      `SELECT kind, table_name, column_name, text FROM search WHERE search MATCH ? ORDER BY length(text)`,
    );

    const scores = new Map<string, number>();
    const matchedValues = new Map<string, Set<string>>();

    const tokens = questionTokens(question);
    for (const token of tokens) {
      let rows = search.all(`"${token}"`);
      const respelled = rows.length === 0 ? closestTerm(db, token) : null;
      if (respelled) rows = search.all(`"${respelled}"`);
      const bestWeight = new Map<string, number>();

      for (const row of rows) {
        const lower = row.text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
        // A respelled word stands for one specific thing, so it counts as exact.
        const exact = Boolean(respelled) || lower === token || lower === `${token}s` || `${lower}s` === token;
        let weight: number;
        if (row.kind === "table") weight = exact ? 6 : 3;
        else if (row.kind === "column") weight = 2;
        // A word inside a longer value is weak evidence: it's often just descriptive text.
        else weight = exact ? 3 : 0.25;
        bestWeight.set(row.table_name, Math.max(bestWeight.get(row.table_name) ?? 0, weight));

        if (row.kind === "value" && row.column_name) {
          const key = `${row.table_name}.${row.column_name}`;
          const values = matchedValues.get(key) ?? new Set<string>();
          if (values.size < MATCHED_VALUES_PER_COLUMN) values.add(row.text);
          matchedValues.set(key, values);
        }
      }

      // A word found in fewer tables says more about which table is meant.
      const rarity = Math.log(1 + tables.size / Math.max(bestWeight.size, 1));
      for (const [table, weight] of bestWeight) {
        scores.set(table, (scores.get(table) ?? 0) + weight * rarity);
      }
    }

    if (scores.size === 0) return [];

    // A table whose whole name appears in the question, like pokemon_types for
    // "pokemon types", is very likely the one meant.
    const wanted = new Set(tokens.map(singular));
    for (const name of tables.keys()) {
      if (name.split("_").every((word) => wanted.has(singular(word)))) {
        scores.set(name, (scores.get(name) ?? 0) + STRONG_MATCH);
      }
    }
    for (const name of tablesFromNotes(notes, tokens, tables)) {
      scores.set(name, (scores.get(name) ?? 0) + STRONG_MATCH);
    }

    const seeds = [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_SEEDS)
      .map(([name]) => name);

    const selected = selectTables(tables, seeds, new Set(scores.keys()));
    return selected.map((name) => describeTable(db, tables.get(name)!, matchedValues));
  } finally {
    db.close();
  }
}

function selectTables(tables: Map<string, TableInfo>, seeds: string[], matched: Set<string>): string[] {
  const neighbours = new Map<string, Set<string>>([...tables.keys()].map((name) => [name, new Set<string>()]));
  const references = new Map<string, number>();
  for (const table of tables.values()) {
    for (const key of table.foreignKeys) {
      if (!tables.has(key.referencedTable)) continue;
      neighbours.get(table.name)!.add(key.referencedTable);
      neighbours.get(key.referencedTable)!.add(table.name);
      references.set(key.referencedTable, (references.get(key.referencedTable) ?? 0) + 1);
    }
  }
  const isHub = (name: string) => (references.get(name) ?? 0) >= HUB_REFERENCES;

  // Every seed stays, even if no join path to the others turns up.
  const selected = new Set<string>(seeds);
  const connected = new Set<string>(seeds.slice(0, 1));

  for (const seed of seeds.slice(1)) {
    const path = cheapestPath(seed, connected, neighbours, isHub, matched);
    for (const name of path ?? [seed]) {
      connected.add(name);
      if (selected.size < MAX_TABLES) selected.add(name);
    }
  }

  // Add what names rows: closely related parents (pokemon -> pokemon_species),
  // then translation tables like type_names. Other parents are mostly lookups
  // like growth_rates, which would crowd out tables that matter.
  const firstWord = (name: string) => name.split("_")[0];
  for (const name of [...selected]) {
    for (const key of tables.get(name)!.foreignKeys) {
      const related = firstWord(key.referencedTable) === firstWord(name);
      if (selected.size < MAX_TABLES && related && tables.has(key.referencedTable) && !isHub(key.referencedTable)) {
        selected.add(key.referencedTable);
      }
    }
  }
  for (const name of [...selected]) {
    for (const child of neighbours.get(name)!) {
      const isLabelTable =
        child.endsWith("_names") && tables.get(child)!.foreignKeys.some((key) => key.referencedTable === name);
      if (selected.size < MAX_TABLES && isLabelTable) selected.add(child);
    }
  }

  return [...selected];
}

/**
 * The cheapest foreign key path from a table to any target. Tables that matched
 * the question cost less to pass through, so a path prefers pokemon_types over an
 * unrelated lookup like generations, even when both are the same length.
 */
function cheapestPath(
  from: string,
  targets: Set<string>,
  neighbours: Map<string, Set<string>>,
  isHub: (name: string) => boolean,
  matched: Set<string>,
): string[] | null {
  const cost = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, string>();
  const done = new Set<string>();

  for (;;) {
    let name: string | null = null;
    for (const [candidate, candidateCost] of cost) {
      if (!done.has(candidate) && (name === null || candidateCost < cost.get(name)!)) name = candidate;
    }
    if (name === null || cost.get(name)! > MAX_PATH_COST) return null;

    if (targets.has(name)) {
      const path = [name];
      for (let step = previous.get(name); step; step = previous.get(step)) path.push(step);
      return path;
    }
    done.add(name);
    if (name !== from && isHub(name)) continue;

    for (const neighbour of neighbours.get(name)!) {
      const next = cost.get(name)! + (targets.has(neighbour) || matched.has(neighbour) ? 0.5 : 1);
      if (next < (cost.get(neighbour) ?? Infinity)) {
        cost.set(neighbour, next);
        previous.set(neighbour, name);
      }
    }
  }
}

function describeTable(db: Database, table: TableInfo, matchedValues: Map<string, Set<string>>): FoundTable {
  const { row_count: rowCount } = db
    .query<{ row_count: number }, [string]>("SELECT row_count FROM tables WHERE name = ?")
    .get(table.name)!;
  const stats = db
    .query<
      { name: string; distinct_count: number; min: number | null; max: number | null; common_values: string },
      [string]
    >("SELECT name, distinct_count, min, max, common_values FROM columns WHERE table_name = ?")
    .all(table.name);

  return {
    name: table.name,
    rowCount,
    columns: table.columns.map((column) => {
      const stat = stats.find(({ name }) => name === column.name)!;
      const key = table.foreignKeys.find((candidate) => candidate.columns.includes(column.name));
      const referencedColumn = key?.referencedColumns[key.columns.indexOf(column.name)];
      return {
        name: column.name,
        type: column.type,
        primaryKey: column.primaryKey,
        references: key ? `${key.referencedTable}.${referencedColumn ?? "(primary key)"}` : null,
        distinctCount: stat.distinct_count,
        min: stat.min,
        max: stat.max,
        commonValues: JSON.parse(stat.common_values) as string[],
        matchedValues: [...(matchedValues.get(`${table.name}.${column.name}`) ?? [])],
      };
    }),
  };
}

/** Renders found tables as compact schema text for the model. */
export function renderSchema(tables: FoundTable[]): string {
  return tables
    .map((table) => {
      const lines = table.columns.map((column) => {
        const parts = [`  ${column.name} ${column.type}`];
        if (column.primaryKey) parts.push("PK");
        if (column.references) parts.push(`-> ${column.references}`);
        if (column.min !== null && column.max !== null) parts.push(`range ${column.min}..${column.max}`);
        if (column.commonValues.length) parts.push(`values: ${JSON.stringify(column.commonValues)}`);
        else if (column.matchedValues.length) parts.push(`includes: ${JSON.stringify(column.matchedValues)}`);
        return parts.join(" ");
      });
      return `TABLE ${table.name} (${table.rowCount} rows)\n${lines.join("\n")}`;
    })
    .join("\n\n");
}
