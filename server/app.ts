import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import type { DatabaseAdapter } from "./adapters/types";
import { askQuestion } from "./ask";
import type { ModelProvider } from "./model";
import type { RequiredFilter } from "./required-filters";
import { checkSql } from "./sql-guard";

const MAX_ROWS = 1000;
const QUERY_TIMEOUT_MS = 10_000;

export interface RegisteredConnection {
  id: string;
  name: string;
  adapter: DatabaseAdapter;
  profilePath: string;
  notes: string;
  requiredFilters: RequiredFilter[];
}

export interface AppOptions {
  connections: RegisteredConnection[];
  model: ModelProvider | null;
}

const askSchema = z.object({ question: z.string().trim().min(1).max(2000) });
const runSchema = z.object({ sql: z.string().trim().min(1).max(20_000) });

// Requiring a JSON body also blocks plain cross-site form posts, because a JSON
// content type triggers a CORS preflight and this API allows no other origins.
function jsonBody<T extends z.ZodType>(schema: T) {
  return validator("json", (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);
    return parsed.data as z.infer<T>;
  });
}

export function createApp({ connections, model }: AppOptions) {
  const find = (id: string) => connections.find((connection) => connection.id === id);

  return new Hono()
    .get("/api/health", (c) => c.json({ ok: true }))
    .get("/api/connections", (c) =>
      c.json(
        connections.map(({ id, name, adapter, profilePath }) => ({
          id,
          name,
          dialect: adapter.dialect,
          profileReady: Bun.file(profilePath).size > 0,
        })),
      ),
    )
    .get("/api/connections/:id/schema", async (c) => {
      const connection = find(c.req.param("id"));
      if (!connection) return c.json({ error: "Connection not found" }, 404);
      return c.json({ tables: await connection.adapter.introspectSchema() });
    })
    .post("/api/connections/:id/ask", jsonBody(askSchema), async (c) => {
      const connection = find(c.req.param("id"));
      if (!connection) return c.json({ error: "Connection not found" }, 404);
      if (!model) return c.json({ error: "No model is configured. Set the MODEL_ values in .env." }, 503);
      if (!Bun.file(connection.profilePath).size) {
        return c.json({ error: "This database is still being profiled. Try again shortly." }, 503);
      }

      try {
        const result = await askQuestion({
          question: c.req.valid("json").question,
          adapter: connection.adapter,
          model,
          profilePath: connection.profilePath,
          notes: connection.notes,
          requiredFilters: connection.requiredFilters,
        });
        return c.json(result);
      } catch (error) {
        console.error("Model request failed:", error);
        return c.json({ error: "The model request failed. Check the server log for details." }, 502);
      }
    })
    .post("/api/connections/:id/run", jsonBody(runSchema), async (c) => {
      const connection = find(c.req.param("id"));
      if (!connection) return c.json({ error: "Connection not found" }, 404);

      const guard = checkSql(c.req.valid("json").sql);
      if (!guard.ok) return c.json({ error: guard.reason }, 400);

      try {
        const result = await connection.adapter.execute(guard.sql, {
          maxRows: MAX_ROWS,
          timeoutMs: QUERY_TIMEOUT_MS,
        });
        return c.json(result);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Query failed" }, 400);
      }
    });
}

export type AppType = ReturnType<typeof createApp>;
