import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupData } from "./setup-data";

const CONTENT = "test database";
const sha256 = new Bun.CryptoHasher("sha256").update(CONTENT).digest("hex");

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let requests = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dbquery-setup-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      requests++;
      return new URL(request.url).pathname === "/file" ? new Response(CONTENT) : new Response("nope", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true });
});

const source = (path = "/file", hash = sha256) => ({ url: `${server.url}${path.slice(1)}`, sha256: hash });

describe("setupData", () => {
  test("downloads a verified read-only file, creating folders", async () => {
    const path = join(dir, "new/folder/db.sqlite");
    expect(await setupData(path, source())).toBe("downloaded");
    expect(await Bun.file(path).text()).toBe(CONTENT);
    expect(statSync(path).mode & 0o777).toBe(0o444);
  });

  test("doesn't download again when the file is already right", async () => {
    const path = join(dir, "again.sqlite");
    await setupData(path, source());
    const before = requests;
    expect(await setupData(path, source())).toBe("up to date");
    expect(requests).toBe(before);
  });

  test("never overwrites a different existing file", async () => {
    const path = join(dir, "mine.sqlite");
    writeFileSync(path, "someone's own data");
    await expect(setupData(path, source())).rejects.toThrow("doesn't match");
    expect(await Bun.file(path).text()).toBe("someone's own data");
  });

  test("rejects a download that fails its checksum and leaves nothing behind", async () => {
    const folder = mkdtempSync(join(dir, "bad-"));
    const path = join(folder, "db.sqlite");
    await expect(setupData(path, source("/file", "0".repeat(64)))).rejects.toThrow("checksum");
    expect(readdirSync(folder)).toEqual([]);
  });

  test("reports a failed download and leaves nothing behind", async () => {
    const folder = mkdtempSync(join(dir, "missing-"));
    const path = join(folder, "db.sqlite");
    await expect(setupData(path, source("/gone"))).rejects.toThrow("404");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(folder)).toEqual([]);
  });
});
