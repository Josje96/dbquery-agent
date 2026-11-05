// Downloads the SQL-Dex test database. It isn't committed because the MIT license
// on this repo doesn't cover the data. See "Test data" in the README.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const COMMIT = "7fd174295082ae423b6df3eaa6e40dde66fd6468";

export const SOURCE = {
  url: `https://raw.githubusercontent.com/teamdandelion/PokemonSQLTutorial/${COMMIT}/pokedex.sqlite`,
  sha256: "7acc4873c05da26b8e01af30eca48cb0ad3c44d81e4f20f479ecae4aee0c9f12",
};

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

async function hashFile(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
}

export async function setupData(
  path: string,
  source: { url: string; sha256: string } = SOURCE,
): Promise<"downloaded" | "up to date"> {
  if (existsSync(path)) {
    const actual = await hashFile(path);
    if (actual === source.sha256) return "up to date";
    // It may hold someone's own data, so it's theirs to remove.
    throw new Error(`${path} exists but its checksum doesn't match. Move it away and run this again.`);
  }

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.download`;
  try {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Download failed with status ${response.status}`);
    await Bun.write(tempPath, response);

    const actual = await hashFile(tempPath);
    if (actual !== source.sha256) {
      throw new Error(`Downloaded file failed its checksum: expected ${source.sha256}, got ${actual}`);
    }
    chmodSync(tempPath, 0o444);
    renameSync(tempPath, path);
    return "downloaded";
  } finally {
    rmSync(tempPath, { force: true });
  }
}

if (import.meta.main) {
  const path = "data/pokedex.sqlite";
  try {
    console.log(`${path}: ${await setupData(path)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
