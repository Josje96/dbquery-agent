import { serveStatic } from "hono/bun";
import { createAdapter } from "./adapters";
import { createApp } from "./app";
import { env, loadConnections, profilePath } from "./config";
import { createModelProvider } from "./model";

// The API can run SQL and spend model credit, and has no login yet.
if (!["127.0.0.1", "localhost", "::1"].includes(env.HOST)) {
  console.error(`Refusing to listen on ${env.HOST}: there's no login yet, so HOST must be a loopback address.`);
  process.exit(1);
}

const configs = await loadConnections(env.CONNECTIONS_FILE);

const connections = await Promise.all(
  configs.map(async (config) => ({
    id: config.id,
    name: config.name,
    adapter: createAdapter(config),
    profilePath: profilePath(config.id),
    notes: config.notesFile ? await Bun.file(config.notesFile).text() : "",
    requiredFilters: config.requiredFilters,
  })),
);

const model =
  env.MODEL_BASE_URL && env.MODEL_API_KEY && env.MODEL_NAME
    ? createModelProvider({
        baseUrl: env.MODEL_BASE_URL,
        apiKey: env.MODEL_API_KEY,
        model: env.MODEL_NAME,
        requireZdr: env.MODEL_REQUIRE_ZDR,
        temperature: env.MODEL_TEMPERATURE,
      })
    : null;
if (!model) console.warn("No model configured: questions are disabled until MODEL_ values are set in .env.");

const app = createApp({ connections, model });
app.use("*", serveStatic({ root: "./dist/web" }));

// Model calls take far longer than Bun's default 10 second idle timeout.
const server = Bun.serve({ port: env.PORT, hostname: env.HOST, idleTimeout: 255, fetch: app.fetch });
console.log(`Listening on ${server.url}`);

// Profiling runs in its own process so it never blocks requests.
for (const { id } of configs) {
  Bun.spawn([process.execPath, new URL("./profiler/cli.ts", import.meta.url).pathname, id], {
    stdout: "inherit",
    stderr: "inherit",
  });
}
