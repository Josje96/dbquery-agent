import type { ConnectionConfig } from "../config";
import { createSqliteAdapter } from "./sqlite";
import type { DatabaseAdapter } from "./types";

export function createAdapter(connection: ConnectionConfig): DatabaseAdapter {
  switch (connection.type) {
    case "sqlite":
      return createSqliteAdapter(connection.path);
  }
}
