// Scores a model on questions with known answers, using real model calls.
// A question passes when the query returns the reference rows. Row order and
// extra columns (an id beside a name, say) don't count against it.
// Usage: bun evals/run.ts [connection-id] [model-name]
import { createAdapter } from "../server/adapters";
import type { QueryResult } from "../server/adapters/types";
import { askQuestion } from "../server/ask";
import { env, loadConnections, profilePath } from "../server/config";
import { createModelProvider } from "../server/model";
import { checkSql } from "../server/sql-guard";

interface EvalCase {
  question: string;
  reference?: string;
  unanswerable?: boolean;
  /** Not looked at while tuning the finder or notes, so it's the fairer score. */
  holdout?: boolean;
  /** Worded the way people type, without saying "English" or "default forms". */
  plain?: boolean;
}

const [connectionId = "sqldex", modelName = env.MODEL_NAME] = process.argv.slice(2);
const config = (await loadConnections(env.CONNECTIONS_FILE)).find(({ id }) => id === connectionId);
if (!config) throw new Error(`Unknown connection: ${connectionId}`);
if (!env.MODEL_BASE_URL || !env.MODEL_API_KEY || !modelName) throw new Error("Set the MODEL_ values in .env");

const adapter = createAdapter(config);
const model = createModelProvider({
  baseUrl: env.MODEL_BASE_URL,
  apiKey: env.MODEL_API_KEY,
  model: modelName,
  requireZdr: env.MODEL_REQUIRE_ZDR,
  temperature: env.MODEL_TEMPERATURE,
});
const notes = config.notesFile ? await Bun.file(config.notesFile).text() : "";
const cases = (await Bun.file(`evals/${connectionId}.json`).json()) as EvalCase[];
const limits = { maxRows: 5000, timeoutMs: 15_000 };

const normalize = (value: unknown) => (typeof value === "number" ? value.toFixed(2) : String(value));
const columnValues = ({ rows }: QueryResult, index: number) => rows.map((row) => normalize(row[index])).sort();

function sameAnswer(expected: QueryResult, actual: QueryResult): boolean {
  if (expected.rows.length !== actual.rows.length) return false;
  return expected.columns.every((_, expectedIndex) => {
    const wanted = JSON.stringify(columnValues(expected, expectedIndex));
    return actual.columns.some((_, actualIndex) => JSON.stringify(columnValues(actual, actualIndex)) === wanted);
  });
}

async function score(test: EvalCase): Promise<{ pass: boolean; detail: string; attempts: number }> {
  const result = await askQuestion({
    question: test.question,
    adapter,
    model,
    profilePath: profilePath(connectionId),
    notes,
    requiredFilters: config!.requiredFilters,
  });
  if (test.unanswerable) {
    return {
      pass: result.status === "unanswerable",
      detail: result.status === "ok" ? result.sql : result.explanation,
      attempts: result.attempts,
    };
  }
  if (result.status !== "ok") {
    return { pass: false, detail: `${result.status}: ${result.explanation}`, attempts: result.attempts };
  }

  const guard = checkSql(result.sql);
  if (!guard.ok) return { pass: false, detail: guard.reason, attempts: result.attempts };
  try {
    const expected = await adapter.execute(test.reference!, limits);
    const actual = await adapter.execute(guard.sql, limits);
    const pass = sameAnswer(expected, actual);
    return {
      pass,
      detail: pass
        ? `${actual.rows.length} rows`
        : `expected ${JSON.stringify(expected.rows.slice(0, 3))}, got ${JSON.stringify(actual.rows.slice(0, 3))}\n     SQL: ${result.sql}\n     Tables: ${result.tables.join(", ")}`,
      attempts: result.attempts,
    };
  } catch (error) {
    return { pass: false, detail: `run failed: ${error}\n     SQL: ${result.sql}`, attempts: result.attempts };
  }
}

console.log(`Model: ${modelName}\n`);
const passed = { tuning: 0, holdout: 0, plain: 0 };
const group = (test: EvalCase) => (test.plain ? "plain" : test.holdout ? "holdout" : "tuning");
let retried = 0;
const started = performance.now();
for (const test of cases) {
  try {
    const { pass, detail, attempts } = await score(test);
    if (pass) passed[group(test)]++;
    if (attempts > 1) retried++;
    console.log(`${pass ? "PASS" : "FAIL"} ${test.question}\n     ${detail} (attempts: ${attempts})`);
  } catch (error) {
    console.log(`FAIL ${test.question}\n     ${error}`);
  }
}
const total = (name: string) => cases.filter((test) => group(test) === name).length;
console.log(
  `\nTuning: ${passed.tuning}/${total("tuning")}  Holdout: ${passed.holdout}/${total("holdout")}  ` +
    `Plain: ${passed.plain}/${total("plain")}  ` +
    `${retried} needed a retry, ${Math.round((performance.now() - started) / 1000)}s total`,
);
adapter.close();
