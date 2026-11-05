import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  CONNECTIONS_FILE: z.string().default("connections.json"),
  PROFILE_DIR: z.string().default("data/profiles"),
  MODEL_BASE_URL: z.url().optional(),
  MODEL_API_KEY: z.string().min(1).optional(),
  MODEL_NAME: z.string().min(1).optional(),
  // "none" leaves the setting out, for models that reject it.
  MODEL_TEMPERATURE: z
    .union([z.literal("none"), z.coerce.number().min(0).max(2)])
    .default(0)
    .transform((value) => (value === "none" ? undefined : value)),
  // Zero data retention stays on unless turned off, e.g. for a local model.
  MODEL_REQUIRE_ZDR: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

const connectionSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().regex(/^[\w-]+$/),
    name: z.string().min(1),
    type: z.literal("sqlite"),
    path: z.string().min(1),
    notesFile: z.string().min(1).optional(),
    // Columns whose values may be sampled, and so sent to the model provider:
    // "*" or "table.column" entries. Nothing is sampled by default.
    sampleColumns: z.union([z.literal("*"), z.array(z.string())]).default([]),
    requiredFilters: z.array(z.object({ column: z.string().min(1), hint: z.string().min(1) })).default([]),
  }),
]);

export type ConnectionConfig = z.infer<typeof connectionSchema>;

export const env = envSchema.parse(process.env);

export async function loadConnections(path: string): Promise<ConnectionConfig[]> {
  return z.array(connectionSchema).parse(await Bun.file(path).json());
}

export function samplePolicy({ sampleColumns }: ConnectionConfig) {
  return (table: string, column: string) =>
    sampleColumns === "*" || sampleColumns.includes(`${table}.${column}`);
}

export const profilePath = (connectionId: string) => `${env.PROFILE_DIR}/${connectionId}.sqlite`;
