<script setup lang="ts">
import { hc } from "hono/client";
import { computed, onMounted, ref } from "vue";
import type { AppType } from "../../server/app";

interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

const api = hc<AppType>(window.location.origin);
const endpoints = api.api.connections[":id"];

const connectionId = ref("");
const connectionName = ref("");
const profileReady = ref(false);
const startupError = ref("");

const question = ref("");
const sql = ref("");
const explanation = ref("");
const warning = ref("");
const tables = ref<string[]>([]);
const result = ref<QueryResult | null>(null);
const error = ref("");
const asking = ref(false);
const running = ref(false);

const canAsk = computed(() => Boolean(connectionId.value && question.value.trim() && !asking.value));
const canRun = computed(() => Boolean(sql.value.trim() && !running.value));

onMounted(async () => {
  try {
    const connections = await (await api.api.connections.$get()).json();
    const connection = connections[0];
    if (!connection) {
      startupError.value = "No connections configured.";
      return;
    }
    connectionId.value = connection.id;
    connectionName.value = connection.name;
    profileReady.value = connection.profileReady;
  } catch {
    startupError.value = "Could not reach the server.";
  }
});

async function ask() {
  if (!canAsk.value) return;
  asking.value = true;
  error.value = "";
  explanation.value = "";
  warning.value = "";
  sql.value = "";
  tables.value = [];
  result.value = null;
  try {
    const response = await endpoints.ask.$post({
      param: { id: connectionId.value },
      json: { question: question.value },
    });
    const body = await response.json();
    if ("error" in body) {
      error.value = body.error;
      return;
    }
    profileReady.value = true;
    tables.value = body.tables;
    explanation.value = body.explanation;
    if (body.status === "ok") {
      sql.value = body.sql;
      warning.value = body.warning ?? "";
    } else if (body.status === "failed") {
      sql.value = body.lastSql ?? "";
      error.value = `The model couldn't produce a working query: ${body.explanation}`;
      explanation.value = "";
    }
  } catch {
    error.value = "Could not reach the server.";
  } finally {
    asking.value = false;
  }
}

async function run() {
  if (!canRun.value) return;
  running.value = true;
  error.value = "";
  result.value = null;
  try {
    const response = await endpoints.run.$post({
      param: { id: connectionId.value },
      json: { sql: sql.value },
    });
    const body = await response.json();
    if ("error" in body) error.value = body.error;
    else result.value = body as QueryResult;
  } catch {
    error.value = "Could not reach the server.";
  } finally {
    running.value = false;
  }
}

function askFromKeyboard(event: KeyboardEvent) {
  if (!event.shiftKey) {
    event.preventDefault();
    ask();
  }
}
</script>

<template>
  <div class="layout">
    <aside class="panel">
      <h2>Saved queries</h2>
      <p class="muted">Saving arrives with login.</p>
    </aside>
    <main class="content">
      <header>
        <h1>DB Query Agent</h1>
        <p v-if="startupError" class="error" role="alert">{{ startupError }}</p>
        <p v-else-if="connectionName" class="muted">
          {{ connectionName }}<template v-if="!profileReady"> · profiling…</template>
        </p>
        <p v-else class="muted">Connecting…</p>
      </header>

      <form @submit.prevent="ask">
        <label for="question">Ask a question</label>
        <textarea
          id="question"
          v-model="question"
          rows="3"
          maxlength="2000"
          placeholder="Which Fire-type Pokémon has the highest base attack?"
          @keydown.enter="askFromKeyboard"
        ></textarea>
        <button type="submit" :disabled="!canAsk">{{ asking ? "Writing query…" : "Generate SQL" }}</button>
      </form>

      <p v-if="error" class="error message" role="alert">{{ error }}</p>
      <p v-if="explanation" class="message">{{ explanation }}</p>
      <p v-if="warning" class="error message" role="status">{{ warning }}</p>

      <section v-if="sql">
        <label for="sql">Generated SQL (review or edit before running)</label>
        <textarea id="sql" v-model="sql" class="code" rows="8" spellcheck="false"></textarea>
        <button type="button" :disabled="!canRun" @click="run">{{ running ? "Running…" : "Run query" }}</button>
      </section>

      <p v-if="tables.length" class="muted message">Tables considered: {{ tables.join(", ") }}</p>

      <section v-if="result">
        <h2>Results</h2>
        <p class="muted">
          {{ result.rows.length }} row{{ result.rows.length === 1 ? "" : "s" }}
          <template v-if="result.truncated"> shown. More rows exist, but results stop at this limit.</template>
        </p>
        <p v-if="result.rows.length === 0" class="message" role="status">
          Nothing matched. This can mean the query is wrong rather than that the data doesn't exist, so check the SQL
          above or try rewording your question.
        </p>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th v-for="(column, index) in result.columns" :key="index" scope="col">{{ column }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, rowIndex) in result.rows" :key="rowIndex">
                <td v-for="(value, columnIndex) in row" :key="columnIndex">{{ value ?? "NULL" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
</template>

<style>
:root {
  color-scheme: light dark;
  --bg: #f7f7f8;
  --surface: #ffffff;
  --text: #1c1d21;
  --muted: #5f6470;
  --border: #dcdee3;
  --error: #b3261e;
  --accent: #2456c9;
  --accent-text: #ffffff;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15161a;
    --surface: #1e2026;
    --text: #eceef2;
    --muted: #a0a5b1;
    --border: #33363e;
    --error: #ff8a80;
    --accent: #8fb0ff;
    --accent-text: #10131a;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, sans-serif;
}

.layout {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  min-height: 100vh;
}

.panel {
  padding: 16px;
  background: var(--surface);
  border-right: 1px solid var(--border);
}

.content {
  padding: 24px;
}

section {
  margin-top: 24px;
}

h1 {
  margin: 0 0 4px;
  font-size: 1.5rem;
}

h2 {
  margin: 0 0 8px;
  font-size: 1rem;
}

label {
  display: block;
  margin: 24px 0 8px;
  font-weight: 600;
}

section label {
  margin-top: 0;
}

textarea {
  display: block;
  width: 100%;
  padding: 12px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  font: inherit;
  resize: vertical;
}

.code {
  font-family: ui-monospace, monospace;
  font-size: 0.9rem;
}

button {
  margin-top: 8px;
  padding: 8px 16px;
  background: var(--accent);
  color: var(--accent-text);
  border: 0;
  border-radius: 6px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

p {
  margin: 0;
}

.message {
  margin-top: 16px;
}

.muted {
  color: var(--muted);
}

.error {
  color: var(--error);
}

.table-wrap {
  margin-top: 8px;
  max-height: 60vh;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

th,
td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  white-space: nowrap;
}

th {
  position: sticky;
  top: 0;
  background: var(--surface);
}

@media (max-width: 700px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .panel {
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }

  .content {
    padding: 16px;
  }
}
</style>
