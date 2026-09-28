/**
 * SQLAdmin 驱动抽象层（需求 F7-01）。
 * 所有功能仅依赖本接口；Oracle/Mock/PostgreSQL 驱动各自实现，
 * UI 与核心层通过 registry 获取驱动实例。
 */

export type ConnectionType = 'oracle' | 'mock' | 'postgres';

/** 连接寻址模式（F1-01/F1-05） */
export type AddressMode = 'basic' | 'tns' | 'connstring';

export interface ConnectionConfig {
  id: string;
  name: string;
  type: ConnectionType;
  mode: AddressMode;
  host: string;
  port: number;
  serviceName: string;
  /** TNS 模式：tnsnames.ora 中的网络别名 */
  tnsAlias: string;
  /** tnsnames.ora 路径（空=自动定位） */
  tnsFile: string;
  /** 连接串模式：完整 Easy Connect / 连接描述符 */
  connectString: string;
  username: string;
  /** 仅运行时填充，持久层永不明文保存（F1-03） */
  password?: string;
  savePassword: boolean;
  role: 'default' | 'sysdba' | 'sysoper';
  readOnly: boolean;
  colorLabel?: string;
}

export function newConnectionConfig(partial: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: partial.id ?? `conn-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: partial.name ?? 'New Connection',
    type: partial.type ?? 'oracle',
    mode: partial.mode ?? 'basic',
    host: partial.host ?? 'localhost',
    port: partial.port ?? 1521,
    serviceName: partial.serviceName ?? '',
    tnsAlias: partial.tnsAlias ?? '',
    tnsFile: partial.tnsFile ?? '',
    connectString: partial.connectString ?? '',
    username: partial.username ?? '',
    password: partial.password,
    savePassword: partial.savePassword ?? false,
    role: partial.role ?? 'default',
    readOnly: partial.readOnly ?? false,
    colorLabel: partial.colorLabel,
  };
}

export type ObjectType =
  | 'TABLE' | 'VIEW' | 'MATERIALIZED VIEW' | 'SEQUENCE' | 'PROCEDURE'
  | 'FUNCTION' | 'PACKAGE' | 'TRIGGER' | 'SYNONYM' | 'TYPE' | 'JOB' | 'DB LINK';

export const OBJECT_TYPES: readonly ObjectType[] = [
  'TABLE', 'VIEW', 'MATERIALIZED VIEW', 'SEQUENCE', 'PROCEDURE',
  'FUNCTION', 'PACKAGE', 'TRIGGER', 'SYNONYM', 'TYPE',
] as const;

export interface DbObjectRef {
  schema: string;
  type: ObjectType;
  name: string;
}

export interface ColumnMeta {
  name: string;
  dataType: string;
  nullable: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  isPrimaryKey?: boolean;
  defaultValue?: string;
  comment?: string;
}

export type StatementKind = 'SELECT' | 'DML' | 'DDL' | 'PLSQL' | 'COMMIT' | 'ROLLBACK' | 'OTHER';

/** 单条语句执行结果 */
export interface QueryResult {
  sql: string;
  kind: StatementKind;
  columns?: ColumnMeta[];
  /** SELECT：数据行（可能截断至 maxRows）；编辑型网格附带隐藏 __ROWID__ 列 */
  rows?: unknown[][];
  rowCount?: number;
  /** DML 影响行数 */
  affectedRows?: number;
  dbmsOutput?: string[];
  durationMs: number;
  /** 可编辑定位信息（F3-10）：仅单表可定位结果可编辑 */
  editable?: { schema?: string; table: string; rowIdColumn?: string };
  truncated?: boolean;
  message?: string;
  error?: string;
}

export interface ExecuteOptions {
  maxRows?: number;
  /** 需要可编辑结果时，驱动按需注入 ROWID（仅简单单表查询） */
  preferEditable?: boolean;
}

/** 行级变更（F3-05..08） */
export type RowChange =
  | { kind: 'update'; rowId: string; table: string; schema?: string; changes: Record<string, { old: unknown; new: unknown }> }
  | { kind: 'insert'; table: string; schema?: string; values: Record<string, unknown> }
  | { kind: 'delete'; rowId: string; table: string; schema?: string };

export interface ChangesetSummary { updates: number; inserts: number; deletes: number }

export interface DriverCapabilities {
  editableResults: boolean;
  supportsDbmsOutput: boolean;
  supportsExplainPlan: boolean;
  supportsDebug: boolean;
  dialect: 'oracle' | 'postgres' | 'mock';
}

export interface ConnectTestResult { ok: boolean; detail: string }

/** 驱动接口：一个实例绑定一个数据库会话（含事务上下文） */
export interface IDbDriver {
  readonly capabilities: DriverCapabilities;
  /** 连接配置（连接成功后可读取到实际 schema 等补充信息） */
  readonly config: ConnectionConfig;
  readonly currentSchema: string;

  connect(password?: string): Promise<void>;
  testConnection(password?: string): Promise<ConnectTestResult>;
  close(): Promise<void>;
  isConnected(): boolean;

  /** 执行单条语句（SELECT/DML/DDL/PLSQL/COMMIT/ROLLBACK） */
  execute(sql: string, binds: Record<string, unknown>, opts?: ExecuteOptions): Promise<QueryResult>;
  /** 流式拉取（导出全量时使用，F4-02） */
  executeStream(sql: string, binds: Record<string, unknown>, batchSize: number, onRows: (rows: unknown[][]) => Promise<void>): Promise<number>;
  cancel(): Promise<void>;

  /** 应用变更集并保持事务打开（由 commit/rollback 统一收口） */
  applyChangeset(changes: RowChange[]): Promise<{ applied: number; errors: string[] }>;
  commit(): Promise<void>;
  rollback(): Promise<void>;

  listSchemas(): Promise<string[]>;
  listObjects(schema: string, type: ObjectType): Promise<DbObjectRef[]>;
  describeTable(schema: string, table: string): Promise<{ columns: ColumnMeta[]; ddl: string }>;
  getDdl(ref: DbObjectRef): Promise<string>;
  /** DBMS_OUTPUT（或等价物）缓冲读取并清空 */
  collectOutput(): Promise<string[]>;
}

export function emptyResult(sql: string, kind: StatementKind, durationMs: number): QueryResult {
  return { sql, kind, durationMs };
}

export function summarizeChanges(changes: readonly RowChange[]): ChangesetSummary {
  let updates = 0, inserts = 0, deletes = 0;
  for (const c of changes) {
    if (c.kind === 'update') { updates++; }
    else if (c.kind === 'insert') { inserts++; }
    else { deletes++; }
  }
  return { updates, inserts, deletes };
}
