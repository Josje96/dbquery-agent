export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface ForeignKey {
  columns: string[];
  referencedTable: string;
  /** A null entry means the referenced table's primary key. */
  referencedColumns: (string | null)[];
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKey[];
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** True when more rows existed than maxRows allowed. */
  truncated: boolean;
}

export interface ColumnProfile {
  name: string;
  nullCount: number;
  distinctCount: number;
  /** Only filled in for columns allowed to be sampled. */
  min: number | null;
  max: number | null;
  /** Distinct short text values, only for columns allowed to be sampled. */
  textValues: string[];
}

export interface TableProfile {
  rowCount: number;
  columns: ColumnProfile[];
}

export interface ProfileOptions {
  canSample(table: string, column: string): boolean;
  maxValues: number;
  maxValueLength: number;
}

export interface DatabaseAdapter {
  readonly dialect: string;
  introspectSchema(): Promise<TableInfo[]>;
  profileTable(table: TableInfo, options: ProfileOptions): Promise<TableProfile>;
  /** Throws if the database can't compile the SQL. Doesn't run it. */
  validate(sql: string): Promise<void>;
  execute(sql: string, options: { maxRows: number; timeoutMs: number }): Promise<QueryResult>;
  close(): void;
}
