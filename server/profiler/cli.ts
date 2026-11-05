// Profiles a connection without any AI. Does nothing if the schema hasn't changed.
// Usage: bun server/profiler/cli.ts <connection-id> [--force]
import { createAdapter } from "../adapters";
import { env, loadConnections, profilePath, samplePolicy } from "../config";
import { buildProfile, schemaHash, storedSchemaHash } from "./store";

const [id, flag] = process.argv.slice(2);
const connection = (await loadConnections(env.CONNECTIONS_FILE)).find((candidate) => candidate.id === id);
if (!connection) {
  console.error(`Unknown connection: ${id}`);
  process.exit(1);
}

const adapter = createAdapter(connection);
const path = profilePath(connection.id);
const hash = schemaHash(await adapter.introspectSchema());

if (flag !== "--force" && storedSchemaHash(path) === hash) {
  console.log(`[${connection.id}] Profile is up to date`);
} else {
  const started = performance.now();
  await buildProfile(adapter, path, samplePolicy(connection), (message) =>
    console.log(`[${connection.id}] ${message}`),
  );
  console.log(`[${connection.id}] Profile finished in ${Math.round(performance.now() - started)} ms`);
}
adapter.close();
