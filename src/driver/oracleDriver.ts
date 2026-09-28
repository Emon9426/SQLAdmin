/**
 * Oracle 驱动（node-oracledb）：thin 模式默认免客户端（12.1+），thick 可选（11.2+）。
 * 依赖为运行时懒加载（oracledb 仅在实际连接 Oracle 时 require）。
 */
import {
  ConnectionConfig, IDbDriver, DriverCapabilities, QueryResult, ExecuteOptions,
  RowChange, DbObjectRef, ObjectType, ColumnMeta, ConnectTestResult, StatementKind,
} from './types';
import { generateDml } from '../core/changeset';
import { splitSql } from '../core/splitter';

/* eslint-disable @typescript-eslint/no-explicit-any */
type OracleDB = any;
type OracleConnection = any;

let oracledbModule: OracleDB | undefined;
let thickInited = false;

/** 由扩展激活时根据设置调用（sqladmin.oracle.mode / clientLibDir） */
export function configureOracleMode(mode: 'thin' | 'thick', libDir?: string): void {
  configuredMode = mode;
  configuredLibDir = libDir;
}
let configuredMode: 'thin' | 'thick' = 'thin';
let configuredLibDir: string | undefined;

function loadOracledb(): OracleDB {
  if (!oracledbModule) {
    oracledbModule = require('oracledb');
  }
  if (configuredMode === 'thick' && !thickInited) {
    oracledbModule.initOracleClient(configuredLibDir ? { libDir: configuredLibDir } : undefined);
    thickInited = true;
  }
  return oracledbModule;
}

const CAPS: DriverCapabilities = {
  editableResults: true,
  supportsDbmsOutput: true,
  supportsExplainPlan: true,
  supportsDebug: false, // M4 交付（需求 F6）
  dialect: 'oracle',
};

function buildConnectString(cfg: ConnectionConfig): string {
  if (cfg.mode === 'connstring') { return cfg.connectString; }
  if (cfg.mode === 'tns') { return cfg.tnsAlias; }
  return `${cfg.host}:${cfg.port}/${cfg.serviceName}`;
}

/** 判断 SELECT 是否为「简单单表查询」→ 可编辑（F3-10） */
export function isSimpleTableSelect(sql: string): { schema?: string; table: string } | undefined {
  const body = sql.replace(/\s+/g, ' ').trim().replace(/;+\s*$/, '');
  const lower = body.toLowerCase();
  // 多表/聚合/集合运算/层次查询/聚合函数不可编辑
  if (/\bjoin\b|\bunion\b|\bminus\b|\bintersect\b|\bgroup\s+by\b|\bdistinct\b|\bconnect\s+by\b|\bstart\s+with\b/.test(lower)) {
    return undefined;
  }
  if (/\b(count|sum|avg|min|max|listagg|median|stddev|variance|row_number|rank|dense_rank|lag|lead)\s*\(/.test(lower)) {
    return undefined;
  }
  // 别名位置使用负向前瞻，避免把 WHERE/ORDER 等关键字误当表别名
  const m = body.match(/^select\s+([\s\S]+?)\s+from\s+([A-Za-z"][\w$#."]*)\s*(?:((?!where\b|order\b|group\b|for\b|union\b|minus\b|intersect\b|join\b|connect\b|start\b)[A-Za-z_][\w$#]*)\s*)?([\s\S]*)$/i);
  if (!m) { return undefined; }
  const target = m[2];
  const parts = target.split('.');
  if (parts.length > 2) { return undefined; }
  const bare = parts[parts.length - 1].replace(/"/g, '');
  if (!/^[A-Za-z_][\w$#]*$/.test(bare)) { return undefined; }
  const schema = parts.length === 2 ? parts[0].replace(/"/g, '') : undefined;
  return { schema, table: bare.toUpperCase() };
}

/**
 * 把简单单表 SELECT 改写为带 ROWID 投影的可编辑查询：
 *   SELECT <alias>.ROWID AS "__ROWID__", <原列清单> FROM <target> <alias> <rest>
 * 别名沿用原语句的表别名；无别名时注入 sqladmin_t。
 * 列清单为 * / t.* 时改写为 <alias>.*。
 */
export function rewriteEditableSelect(sql: string, defaultSchema: string): { sql: string; editable: { schema: string; table: string; rowIdColumn: string } } | undefined {
  const simple = isSimpleTableSelect(sql);
  if (!simple) { return undefined; }
  const body = sql.trim().replace(/;+\s*$/, '');
  const m = body.match(/^select\s+([\s\S]+?)\s+from\s+([A-Za-z"][\w$#."]*)\s*(?:((?!where\b|order\b|group\b|for\b|union\b|minus\b|intersect\b|join\b|connect\b|start\b)[A-Za-z_][\w$#]*)\s*)?([\s\S]*)$/i);
  if (!m) { return undefined; }
  const [, collist, target, aliasRaw, rest] = m;
  const alias = aliasRaw;
  const al = alias ?? 'sqladmin_t';
  // 列清单若为裸 * 或 原别名.*，改写为 <al>.*
  const newCollist = collist.replace(/^\*$/i, `${al}.*`)
    .replace(new RegExp(`^${alias ?? '\\u0000'}\\.\\*$`, 'i'), `${al}.*`);
  const rewritten = `SELECT ${al}.ROWID AS "__ROWID__", ${newCollist} FROM ${target} ${alias ?? al}${rest ? ' ' + rest.trim() : ''}`.replace(/\s+/g, ' ');
  return {
    sql: rewritten,
    editable: { schema: simple.schema ?? defaultSchema, table: simple.table, rowIdColumn: '__ROWID__' },
  };
}

export class OracleDriver implements IDbDriver {
  readonly capabilities = CAPS;
  readonly config: ConnectionConfig;
  currentSchema = '';
  private conn: OracleConnection | undefined;

  constructor(cfg: ConnectionConfig) {
    this.config = cfg;
  }

  private async ensureConnected(): Promise<OracleConnection> {
    if (this.conn) { return this.conn; }
    throw new Error('ORA-03114: 未连接到 Oracle');
  }

  async connect(password?: string): Promise<void> {
    const oracledb = loadOracledb();
    const pwd = password ?? this.config.password;
    if (!pwd) { throw new Error('未提供密码（请编辑连接并填写密码）'); }
    const opts: Record<string, unknown> = {
      user: this.config.username,
      password: pwd,
      connectString: buildConnectString(this.config),
    };
    if (this.config.role === 'sysdba') { opts.privilege = oracledb.SYSDBA; }
    else if (this.config.role === 'sysoper') { opts.privilege = oracledb.SYSOPER; }
    this.conn = await oracledb.getConnection(opts);
    const schemaRes = await this.conn.execute('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') FROM DUAL', [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
    this.currentSchema = String(schemaRes.rows[0][0]).toUpperCase();
    await this.conn.execute('BEGIN DBMS_OUTPUT.ENABLE(NULL); END;', [], {});
  }

  async testConnection(password?: string): Promise<ConnectTestResult> {
    try {
      const oracledb = loadOracledb();
      const pwd = password ?? this.config.password;
      if (!pwd) { return { ok: false, detail: '未提供密码' }; }
      const conn = await oracledb.getConnection({
        user: this.config.username,
        password: pwd,
        connectString: buildConnectString(this.config),
      });
      const v = await conn.execute('SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1', [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
      await conn.close();
      return { ok: true, detail: String(v.rows[0]?.[0] ?? '连接成功') };
    } catch (e: any) {
      return { ok: false, detail: `${e.message ?? String(e)}` };
    }
  }

  async close(): Promise<void> {
    if (this.conn) {
      // 带未提交事务的断开：服务端自动回滚（F3-09 默认回滚策略）
      try { await this.conn.close({ dropSession: false }); } catch { /* 会话级错误忽略 */ }
      this.conn = undefined;
    }
  }

  isConnected(): boolean { return !!this.conn; }

  async execute(sql: string, binds: Record<string, unknown>, opts: ExecuteOptions = {}): Promise<QueryResult> {
    const t0 = Date.now();
    const oracledb = loadOracledb();
    const conn = this.conn;
    if (!conn) { return { sql, kind: 'OTHER', durationMs: 0, error: 'ORA-03114: 未连接' }; }
    const kind = this.classify(sql);
    try {
      let execSql = sql;
      let editable: QueryResult['editable'];
      if (kind === 'SELECT' && opts.preferEditable !== false && this.capabilities.editableResults) {
        const rewritten = rewriteEditableSelect(sql, this.currentSchema);
        if (rewritten) {
          execSql = rewritten.sql;
          editable = rewritten.editable;
        }
      }
      const maxRows = kind === 'SELECT' ? (opts.maxRows ?? 500) : undefined;
      const res = await conn.execute(execSql, binds ?? {}, {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        autoCommit: false,
        ...(maxRows !== undefined ? { maxRows } : {}),
      });
      const durationMs = Date.now() - t0;
      const out = await this.collectOutput();
      if (kind === 'SELECT') {
        const columns: ColumnMeta[] = (res.metaData ?? []).map((m: any) => ({
          name: m.name,
          dataType: m.dbTypeCanonical ?? String(m.dbTypeName ?? ''),
          nullable: m.nullable ?? true,
        }));
        const rows: unknown[][] = res.rows ?? [];
        // 注：truncated 为近似值（恰好等于 maxRows 且无更多行时会误报），
        // UI 提示“导出全部行可获取全量”在两种情况下都是正确建议
        return {
          sql, kind, durationMs, columns, rows,
          rowCount: rows.length,
          truncated: rows.length >= (opts.maxRows ?? 500),
          editable, dbmsOutput: out,
        };
      }
      return {
        sql, kind, durationMs, affectedRows: res.rowsAffected, dbmsOutput: out,
        message: `${res.rowsAffected ?? 0} 行受影响`,
      };
    } catch (e: any) {
      return { sql, kind, durationMs: Date.now() - t0, error: `${e.message ?? String(e)}` };
    }
  }

  async executeStream(sql: string, binds: Record<string, unknown>, batchSize: number, onRows: (rows: unknown[][]) => Promise<void>): Promise<number> {
    const oracledb = loadOracledb();
    const conn = this.conn;
    if (!conn) { throw new Error('ORA-03114: 未连接'); }
    // 流式导出不做 ROWID 注入
    const res = await conn.execute(sql, binds ?? {}, {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      resultSet: true,
      autoCommit: false,
    });
    const rs = res.resultSet;
    let total = 0;
    try {
      for (;;) {
        const rows = await rs.getRows(batchSize);
        if (!rows || rows.length === 0) { break; }
        await onRows(rows);
        total += rows.length;
        if (rows.length < batchSize) { break; }
      }
    } finally {
      await rs.close();
    }
    return total;
  }

  async cancel(): Promise<void> {
    if (this.conn) { await this.conn.break(); }
  }

  async applyChangeset(changes: RowChange[]): Promise<{ applied: number; errors: string[] }> {
    const conn = this.conn;
    if (!conn) { throw new Error('ORA-03114: 未连接'); }
    const errors: string[] = [];
    let applied = 0;
    for (const c of changes) {
      const { sql, binds } = generateDml(c);
      try {
        await conn.execute(sql, binds, { autoCommit: false });
        applied++;
      } catch (e: any) {
        errors.push(`${c.kind.toUpperCase()} ${c.table}: ${e.message ?? String(e)}`);
      }
    }
    return { applied, errors };
  }

  async commit(): Promise<void> { if (this.conn) { await this.conn.commit(); } }
  async rollback(): Promise<void> { if (this.conn) { await this.conn.rollback(); } }

  async listSchemas(): Promise<string[]> {
    const r = await this.execute(
      `SELECT username FROM all_users ORDER BY username`, {}, { maxRows: 5000 },
    );
    return (r.rows ?? []).map((row) => String(row[0]));
  }

  async listObjects(schema: string, type: ObjectType): Promise<DbObjectRef[]> {
    const oracleType = type === 'MATERIALIZED VIEW' ? 'MATERIALIZED VIEW' : type;
    const r = await this.execute(
      `SELECT object_name FROM all_objects
        WHERE owner = :owner AND object_type = :otype AND generated = 'N' AND status != 'INVALID'
        ORDER BY object_name`,
      { owner: schema.toUpperCase(), otype: oracleType },
      { maxRows: 50000, preferEditable: false },
    );
    return (r.rows ?? []).map((row) => ({ schema: schema.toUpperCase(), type, name: String(row[0]) }));
  }

  async describeTable(schema: string, table: string): Promise<{ columns: ColumnMeta[]; ddl: string }> {
    const r = await this.execute(
      `SELECT c.column_name, c.data_type, c.data_length, c.data_precision, c.data_scale,
              c.nullable, c.data_default, cc.comments,
              CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END AS is_pk
         FROM all_tab_columns c
         LEFT JOIN all_col_comments cc
           ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
         LEFT JOIN (
              SELECT acc.owner, acc.table_name, acc.column_name
                FROM all_constraints ac
                JOIN all_cons_columns acc ON acc.constraint_name = ac.constraint_name AND acc.owner = ac.owner
               WHERE ac.constraint_type = 'P' AND ac.owner = :owner AND ac.table_name = :tname
         ) pk ON pk.owner = c.owner AND pk.table_name = c.table_name AND pk.column_name = c.column_name
        WHERE c.owner = :owner AND c.table_name = :tname
        ORDER BY c.column_id`,
      { owner: schema.toUpperCase(), tname: table.toUpperCase() },
      { maxRows: 2000, preferEditable: false },
    );
    if (r.error) { throw new Error(r.error); }
    const columns: ColumnMeta[] = (r.rows ?? []).map((row) => ({
      name: String(row[0]),
      dataType: formatType(String(row[1]), row[2] as number, row[3] as number, row[4] as number),
      nullable: row[5] === 'Y',
      defaultValue: row[6] ? String(row[6]).trim() : undefined,
      comment: row[7] ? String(row[7]) : undefined,
      isPrimaryKey: Number(row[8]) === 1,
    }));
    const ddl = await this.getDdl({ schema, type: 'TABLE', name: table });
    return { columns, ddl };
  }

  async getDdl(ref: DbObjectRef): Promise<string> {
    const typeMap: Record<string, string> = {
      TABLE: 'TABLE', VIEW: 'TABLE', 'MATERIALIZED VIEW': 'MATERIALIZED_VIEW', SEQUENCE: 'SEQUENCE',
      PROCEDURE: 'PROCEDURE', FUNCTION: 'FUNCTION', PACKAGE: 'PACKAGE', TRIGGER: 'TRIGGER',
      SYNONYM: 'SYNONYM', TYPE: 'TYPE', JOB: 'PROCOBJ', 'DB LINK': 'DB_LINK',
    };
    const r = await this.execute(
      `SELECT DBMS_METADATA.GET_DDL(:otype, :oname, :owner) FROM DUAL`,
      { otype: typeMap[ref.type] ?? 'TABLE', oname: ref.name.toUpperCase(), owner: ref.schema.toUpperCase() },
      { maxRows: 10, preferEditable: false },
    );
    if (r.error) { throw new Error(r.error); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lob: any = (r.rows ?? [])[0]?.[0];
    if (lob && typeof lob === 'object' && typeof lob.getData === 'function') {
      return (await lob.getData()).toString('utf8');
    }
    return String(lob ?? '');
  }

  async collectOutput(): Promise<string[]> {
    const conn = this.conn;
    if (!conn) { return []; }
    const lines: string[] = [];
    try {
      for (;;) {
        const r = await conn.execute('BEGIN DBMS_OUTPUT.GET_LINES(:lines, :nump); END;', {
          lines: { dir: oracledbModule!.BIND_OUT, type: oracledbModule!.STRING, maxSize: 32767 },
          nump: { val: 50, dir: oracledbModule!.BIND_INOUT, type: oracledbModule!.NUMBER },
        }, {});
        const out = r.outBinds.lines as string[];
        const n = Number(r.outBinds.nump);
        for (let i = 0; i < n; i++) { if (out[i] !== undefined && out[i] !== null) { lines.push(out[i]); } }
        if (n < 50) { break; }
      }
    } catch {
      /* DBMS_OUTPUT 不可用时静默 */
    }
    return lines;
  }

  private classify(sql: string): StatementKind {
    const first = splitSql(sql)[0]?.text ?? sql;
    const s = first.trim().replace(/;+\s*$/, '');
    if (/^select\b/i.test(s)) { return 'SELECT'; }
    if (/^(insert|update|delete|merge)\b/i.test(s)) { return 'DML'; }
    if (/^commit\b/i.test(s)) { return 'COMMIT'; }
    if (/^rollback\b/i.test(s)) { return 'ROLLBACK'; }
    if (/^(declare|begin)\b/i.test(s)) { return 'PLSQL'; }
    if (/^create\s+(or\s+replace\s+)?(procedure|function|package|trigger|type|view)\b/i.test(s)) { return 'PLSQL'; }
    if (/^(create|alter|drop|truncate|grant|revoke|comment)\b/i.test(s)) { return 'DDL'; }
    return 'OTHER';
  }
}

function formatType(t: string, length?: number, precision?: number, scale?: number): string {
  if (/^(VARCHAR2|NVARCHAR2|CHAR|NCHAR|RAW)$/.test(t)) { return `${t}(${length ?? 0})`; }
  if (/^NUMBER$/.test(t)) {
    if (precision === null && scale === null) { return 'NUMBER'; }
    if (scale === 0 && precision !== null) { return `NUMBER(${precision},0)`; }
    if (precision !== null) { return `NUMBER(${precision ?? 38},${scale ?? 0})`; }
    return 'NUMBER';
  }
  return t;
}
