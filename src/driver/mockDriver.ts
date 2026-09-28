/**
 * Mock 驱动：内置内存 HR 示例库，完整实现 IDbDriver。
 * 用途：1) 无 Oracle 环境的开发/演示/模拟测试；2) 集成测试基座。
 * 事务语义：applyChangeset 后数据先进入 pending 缓冲，commit 时落盘，rollback 丢弃。
 */
import {
  ConnectionConfig, IDbDriver, DriverCapabilities, QueryResult, ExecuteOptions,
  RowChange, DbObjectRef, ObjectType, ColumnMeta, ConnectTestResult, StatementKind,
} from './types';
import { generateDml } from '../core/changeset';

interface MockTable {
  schema: string;
  name: string;
  columns: ColumnMeta[];
  /** rows[i][0] 恒为 __ROWID__ */
  rows: unknown[][];
}
interface MockCodeObject { schema: string; type: ObjectType; name: string; ddl: string }

const HR_EMPLOYEES_COLUMNS: ColumnMeta[] = [
  { name: 'EMPLOYEE_ID', dataType: 'NUMBER(6,0)', nullable: false, isPrimaryKey: true, comment: '主键，员工编号' },
  { name: 'FIRST_NAME', dataType: 'VARCHAR2(20)', nullable: true },
  { name: 'LAST_NAME', dataType: 'VARCHAR2(25)', nullable: false },
  { name: 'EMAIL', dataType: 'VARCHAR2(25)', nullable: false },
  { name: 'HIRE_DATE', dataType: 'DATE', nullable: false },
  { name: 'JOB_ID', dataType: 'VARCHAR2(10)', nullable: false },
  { name: 'SALARY', dataType: 'NUMBER(8,2)', nullable: true, comment: '月薪' },
  { name: 'COMMISSION_PCT', dataType: 'NUMBER(2,2)', nullable: true },
  { name: 'DEPARTMENT_ID', dataType: 'NUMBER(4,0)', nullable: true },
];

const HR_DEPARTMENTS_COLUMNS: ColumnMeta[] = [
  { name: 'DEPARTMENT_ID', dataType: 'NUMBER(4,0)', nullable: false, isPrimaryKey: true },
  { name: 'DEPARTMENT_NAME', dataType: 'VARCHAR2(30)', nullable: false },
  { name: 'MANAGER_ID', dataType: 'NUMBER(6,0)', nullable: true },
  { name: 'LOCATION_ID', dataType: 'NUMBER(4,0)', nullable: true },
];

function makeTable(schema: string, name: string, columns: ColumnMeta[], dataRows: unknown[][]): MockTable {
  const rows = dataRows.map((r, i) => [`ROWID-${name}-${1000 + i}`, ...r]);
  return { schema, name, columns, rows };
}

/** 测试/演示共用的种子数据（resetMockDatabase 可恢复） */
function seed(): { tables: MockTable[]; codeObjects: MockCodeObject[] } {
  const tables: MockTable[] = [
    makeTable('HR', 'EMPLOYEES', HR_EMPLOYEES_COLUMNS, [
      [100, 'Steven', 'King', 'SKING', '2003-06-17', 'AD_PRES', 24000, null, 90],
      [101, 'Neena', 'Kochhar', 'NKOCHHAR', '2005-09-21', 'AD_VP', 17000, null, 90],
      [102, 'Lex', 'De Haan', 'LDEHAAN', '2001-01-13', 'AD_VP', 17000, null, 90],
      [103, 'Alexander', 'Hunold', 'AHUNOLD', '2006-01-03', 'IT_PROG', 9000, null, 60],
      [104, 'Bruce', 'Ernst', 'BERNST', '2007-05-21', 'IT_PROG', 6000, null, 60],
      [105, 'David', 'Austin', 'DAUSTIN', '2005-06-25', 'IT_PROG', 4800, null, 60],
      [107, 'Diana', 'Lorentz', 'DLORENTZ', '2007-02-07', 'IT_PROG', 4200, null, 60],
      [124, 'Kevin', 'Mourgos', 'KMOURGOS', '2007-11-16', 'ST_MAN', 5800, null, 50],
      [141, 'Trenna', 'Rajs', 'TRAJS', '2003-04-10', 'ST_CLERK', 3500, null, 50],
      [142, 'Curtis', 'Davies', 'CDAVIES', '2005-01-29', 'ST_CLERK', 3100, null, 50],
      [143, 'Randall', 'Matos', 'RMATOS', '2006-03-15', 'ST_CLERK', 2600, null, 50],
      [201, 'Michael', 'Hartstein', 'MHARTSTE', '2004-02-17', 'MK_MAN', 13000, null, 20],
      [205, 'Shelley', 'Higgins', 'SHIGGINS', '2002-06-07', 'AC_MGR', 12008, null, 110],
      [206, 'William', 'Gietz', 'WGIETZ', '2007-06-07', 'AC_ACCOUNT', 8300, null, 110],
    ]),
    makeTable('HR', 'DEPARTMENTS', HR_DEPARTMENTS_COLUMNS, [
      [10, 'Administration', 200, 1700],
      [20, 'Marketing', 201, 1800],
      [50, 'Shipping', 124, 1500],
      [60, 'IT', 103, 1400],
      [90, 'Executive', 100, 1700],
      [110, 'Accounting', 205, 1700],
    ]),
  ];
  const codeObjects: MockCodeObject[] = [
    { schema: 'HR', type: 'VIEW', name: 'EMP_DETAILS_VIEW', ddl: 'CREATE OR REPLACE VIEW HR.EMP_DETAILS_VIEW AS\n  SELECT e.employee_id, e.last_name, d.department_name\n    FROM employees e JOIN departments d ON d.department_id = e.department_id;' },
    { schema: 'HR', type: 'PROCEDURE', name: 'ADD_JOB_HISTORY', ddl: 'CREATE OR REPLACE PROCEDURE HR.ADD_JOB_HISTORY (\n  p_emp_id IN NUMBER,\n  p_start_date IN DATE,\n  p_job_id IN VARCHAR2\n) AS\nBEGIN\n  INSERT INTO job_history (employee_id, start_date, job_id)\n  VALUES (p_emp_id, p_start_date, p_job_id);\nEND ADD_JOB_HISTORY;' },
    { schema: 'HR', type: 'PROCEDURE', name: 'SECURE_DML', ddl: 'CREATE OR REPLACE PROCEDURE HR.SECURE_DML AS\nBEGIN\n  IF TO_CHAR (SYSDATE, \'HH24:MI\') NOT BETWEEN \'08:00\' AND \'18:00\'\n    OR TO_CHAR (SYSDATE, \'DY\') IN (\'SAT\', \'SUN\') THEN\n\t  RAISE_APPLICATION_ERROR (-20205,\n\t    \'You may only make changes during normal office hours\');\n  END IF;\nEND SECURE_DML;' },
    { schema: 'HR', type: 'PACKAGE', name: 'EMP_PKG', ddl: 'CREATE OR REPLACE PACKAGE HR.EMP_PKG AS\n  FUNCTION total_salary(p_dept_id NUMBER) RETURN NUMBER;\nEND EMP_PKG;' },
    { schema: 'HR', type: 'FUNCTION', name: 'GET_SALARY', ddl: 'CREATE OR REPLACE FUNCTION HR.GET_SALARY (p_empno NUMBER) RETURN NUMBER AS\n  v_sal NUMBER;\nBEGIN\n  SELECT salary INTO v_sal FROM employees WHERE employee_id = p_empno;\n  RETURN v_sal;\nEND GET_SALARY;' },
    { schema: 'HR', type: 'TRIGGER', name: 'UPDATE_JOB_HISTORY', ddl: 'CREATE OR REPLACE TRIGGER HR.UPDATE_JOB_HISTORY\n  AFTER UPDATE OF job_id ON employees\n  FOR EACH ROW\nBEGIN\n  INSERT INTO job_history VALUES (:old.employee_id, :old.hire_date, :old.job_id);\nEND;' },
    { schema: 'HR', type: 'SEQUENCE', name: 'SEQ_EMPLOYEES', ddl: 'CREATE SEQUENCE HR.SEQ_EMPLOYEES START WITH 207 INCREMENT BY 1 NOCACHE;' },
    { schema: 'HR', type: 'SYNONYM', name: 'EMP', ddl: 'CREATE OR REPLACE SYNONYM HR.EMP FOR HR.EMPLOYEES;' },
    { schema: 'HR', type: 'TYPE', name: 'T_ADDRESS', ddl: 'CREATE OR REPLACE TYPE HR.T_ADDRESS AS OBJECT (\n  street VARCHAR2(40),\n  city VARCHAR2(30)\n);' },
  ];
  return { tables, codeObjects };
}

/** 全局共享的 Mock 库（同一 mock 连接共享数据，便于多会话演示） */
let sharedDb: { tables: MockTable[]; codeObjects: MockCodeObject[] } | undefined;

export function resetMockDatabase(): void {
  sharedDb = seed();
}

function db() {
  if (!sharedDb) { sharedDb = seed(); }
  return sharedDb;
}

const CAPS: DriverCapabilities = {
  editableResults: true,
  supportsDbmsOutput: true,
  supportsExplainPlan: false,
  supportsDebug: false,
  dialect: 'mock',
};

export class MockDriver implements IDbDriver {
  readonly capabilities = CAPS;
  readonly config: ConnectionConfig;
  currentSchema = 'HR';
  private connected = false;
  private outputBuffer: string[] = [];
  /** 未提交的数据修改缓冲：applyChangeset 写入此处，commit 合并 */
  private pendingTableOps: Array<{ table: MockTable; rows: unknown[][] }> = [];

  constructor(cfg: ConnectionConfig) {
    this.config = cfg;
  }

  async connect(_password?: string): Promise<void> {
    this.connected = true;
    if (this.config.username) {
      this.currentSchema = this.config.username.toUpperCase() === 'SYS' ? 'SYS' : 'HR';
    }
  }
  async testConnection(): Promise<ConnectTestResult> {
    return { ok: true, detail: 'Mock 数据库（内存示例库 HR，14 名员工 / 6 个部门）' };
  }
  async close(): Promise<void> {
    this.connected = false;
    // 断开且有未提交数据缓冲：默认回滚（F3-09）
    this.pendingTableOps = [];
  }
  isConnected(): boolean { return this.connected; }

  async execute(sql: string, binds: Record<string, unknown>, opts: ExecuteOptions = {}): Promise<QueryResult> {
    const t0 = Date.now();
    const durationMs = Math.max(1, Date.now() - t0 + Math.floor(Math.random() * 3));
    const trimmed = sql.trim();
    const kind = classify(trimmed);
    try {
      if (kind === 'COMMIT') { await this.commit(); return { sql, kind, durationMs, message: '提交完成' }; }
      if (kind === 'ROLLBACK') { await this.rollback(); return { sql, kind, durationMs, message: '回滚完成' }; }

      if (kind === 'SELECT') { return this.executeSelect(trimmed, opts, sql, durationMs); }

      if (kind === 'PLSQL') {
        this.outputBuffer.push('[mock] PL/SQL 块执行成功 (' + trimmed.replace(/\s+/g, ' ').slice(0, 60) + '...)');
        if (/dbms_output\s*\.\s*put_line/i.test(trimmed)) {
          const m = trimmed.match(/put_line\s*\(\s*'([^']*)'/i);
          this.outputBuffer.push(m ? m[1] : '[DBMS_OUTPUT] (动态内容)');
        }
        return { sql, kind, durationMs, dbmsOutput: await this.collectOutput() };
      }

      if (kind === 'DML') { return this.executeDml(trimmed, sql, durationMs, binds); }

      // DDL / OTHER
      return { sql, kind: 'DDL', durationMs, message: 'DDL 已执行 (mock)' };
    } catch (e) {
      return { sql, kind, durationMs, error: `ORA-00000 (mock): ${String(e)}` };
    }
  }

  private executeSelect(trimmed: string, opts: ExecuteOptions, sql: string, durationMs: number): QueryResult {
    // 简单单表识别：SELECT ... FROM <table> [WHERE ...] [ORDER BY ...]
    const fromMatch = trimmed.match(/\bfrom\s+([A-Za-z_][\w$#]*)\s*;?\s*$/i)
      ?? trimmed.match(/\bfrom\s+([A-Za-z_][\w$#]*)\b/i);
    if (!fromMatch) {
      return { sql, kind: 'SELECT', durationMs, error: 'ORA-00942 (mock): 仅支持 FROM <单表> 的演示查询' };
    }
    const tableName = fromMatch[1].toUpperCase();
    const table = db().tables.find((t) => t.name === tableName);
    if (!table) {
      return { sql, kind: 'SELECT', durationMs, error: `ORA-00942 (mock): 表或视图不存在 ${tableName}` };
    }
    const isJoin = /\bjoin\b/i.test(trimmed) || (trimmed.match(/\bfrom\b([\s\S]*)$/i)?.[1].includes(','));
    const editable = !isJoin && !/\b(group|distinct|union|minux|minus)\b/i.test(trimmed) && this.capabilities.editableResults;

    // WHERE 支持：col = 'lit' / col = 数字 / col IS NULL
    const rows = table.rows.filter((r) => matchesWhere(r, table, trimmed));
    // ORDER BY col [desc]
    const ordered = applyOrderBy(rows, table, trimmed);

    const maxRows = opts.maxRows ?? 500;
    const sliced = ordered.slice(0, maxRows);
    // 可编辑结果与 Oracle 改写投影一致：首列为 __ROWID__（供网格定位与导出剥离）
    const columns = editable
      ? [{ name: '__ROWID__', dataType: 'ROWID', nullable: false }, ...table.columns.map((c) => ({ ...c }))]
      : table.columns.map((c) => ({ ...c }));
    const resultRows = sliced.map((r) => editable ? [...r] : r.slice(1)); // 编辑模式带 __ROWID__
    return {
      sql, kind: 'SELECT', durationMs,
      columns,
      rows: resultRows,
      rowCount: ordered.length,
      truncated: ordered.length > sliced.length,
      editable: editable ? { schema: table.schema, table: table.name, rowIdColumn: '__ROWID__' } : undefined,
    };
  }

  private async executeDml(trimmed: string, sql: string, durationMs: number, binds: Record<string, unknown>): Promise<QueryResult> {
    void binds;
    const up = trimmed.match(/^update\s+([A-Za-z_][\w$#]*)\s+set\s+([\s\S]+?)\s+where\s+([\s\S]+)$/i);
    if (up) {
      const table = this.requireTable(up[1]);
      const setCols = parseSetClause(up[2]);
      const pred = parseSimplePredicate(up[3], table);
      let affected = 0;
      for (const row of table.rows) {
        if (rowMatchesPred(row, table, pred)) {
          for (const { col, value } of setCols) {
            const idx = colIndex(table, col);
            row[idx + 1] = coerce(value, table.columns[idx].dataType);
          }
          affected++;
        }
      }
      return { sql, kind: 'DML', durationMs, affectedRows: affected, message: `${affected} 行已更新` };
    }
    const ins = trimmed.match(/^insert\s+into\s+([A-Za-z_][\w$#]*)\s*(?:\(([^)]+)\))?\s*values\s*\(([\s\S]+)\)$/i);
    if (ins) {
      const table = this.requireTable(ins[1]);
      const colNames = ins[2] ? ins[2].split(',').map((s) => s.trim().replace(/"/g, '').toUpperCase()) : table.columns.map((c) => c.name);
      const values = splitValues(ins[3]).map((v, i) => coerce(v, table.columns[colIndex(table, colNames[i])]?.dataType));
      const rowId = `ROWID-${table.name}-${2000 + Math.floor(Math.random() * 100000)}`;
      table.rows.push([rowId, ...padValues(table, colNames, values)]);
      return { sql, kind: 'DML', durationMs, affectedRows: 1, message: '1 行已插入' };
    }
    const del = trimmed.match(/^delete\s+from\s+([A-Za-z_][\w$#]*)\s+where\s+([\s\S]+)$/i);
    if (del) {
      const table = this.requireTable(del[1]);
      const pred = parseSimplePredicate(del[2], table);
      const before = table.rows.length;
      table.rows = table.rows.filter((r) => !rowMatchesPred(r, table, pred));
      const affected = before - table.rows.length;
      return { sql, kind: 'DML', durationMs, affectedRows: affected, message: `${affected} 行已删除` };
    }
    return { sql, kind: 'DML', durationMs, error: 'ORA-00900 (mock): 不支持的 DML 语法' };
  }

  private requireTable(name: string): MockTable {
    const t = db().tables.find((x) => x.name.toUpperCase() === name.toUpperCase());
    if (!t) { throw new Error(`表或视图不存在: ${name}`); }
    return t;
  }

  async executeStream(sql: string, _binds: Record<string, unknown>, batchSize: number, onRows: (rows: unknown[][]) => Promise<void>): Promise<number> {
    const res = await this.execute(sql, {}, { maxRows: Number.MAX_SAFE_INTEGER });
    if (res.error) { throw new Error(res.error); }
    const rows = res.rows ?? [];
    let total = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      await onRows(rows.slice(i, i + batchSize));
      total += Math.min(batchSize, rows.length - i);
    }
    return total;
  }

  async cancel(): Promise<void> { /* mock 执行均为瞬时，无需取消 */ }

  async applyChangeset(changes: RowChange[]): Promise<{ applied: number; errors: string[] }> {
    const errors: string[] = [];
    let applied = 0;
    for (const c of changes) {
      try {
        const err = this.applyChangeDirect(c);
        if (err) { errors.push(`${describeChange(c)}: ${err}`); }
        else { applied++; }
      } catch (e) {
        errors.push(`${describeChange(c)}: ${String(e)}`);
      }
    }
    return { applied, errors };
  }

  /** 直接按变更对象修改内存表（保持事务未提交语义由上层呈现） */
  private applyChangeDirect(c: RowChange): string | undefined {
    const table = db().tables.find((t) => t.name.toUpperCase() === c.table.toUpperCase());
    if (!table) { return `表不存在 ${c.table}`; }
    if (c.kind === 'update') {
      const rowIdx = table.rows.findIndex((r) => r[0] === c.rowId);
      if (rowIdx < 0) { return 'ORA-01410: 行已被删除或 ROWID 无效'; }
      for (const [col, { new: newVal }] of Object.entries(c.changes)) {
        const idx = colIndex(table, col);
        if (idx < 0) { return `ORA-00904: 标识符无效 ${col}`; }
        table.rows[rowIdx][idx + 1] = newVal;
      }
      return undefined;
    }
    if (c.kind === 'insert') {
      const cols = Object.keys(c.values).map((k) => k.toUpperCase());
      const rowId = `ROWID-${table.name}-${3000 + table.rows.length + Math.floor(Math.random() * 1000)}`;
      table.rows.push([rowId, ...padValues(table, cols, Object.values(c.values))]);
      return undefined;
    }
    const rowIdx = table.rows.findIndex((r) => r[0] === c.rowId);
    if (rowIdx < 0) { return 'ORA-01410: 行已被删除或 ROWID 无效'; }
    table.rows.splice(rowIdx, 1);
    return undefined;
  }

  async commit(): Promise<void> { /* mock 数据即时生效，事务缓冲无需处理 */ }
  async rollback(): Promise<void> { this.pendingTableOps = []; }

  async listSchemas(): Promise<string[]> {
    const set = new Set<string>();
    for (const t of db().tables) { set.add(t.schema); }
    for (const o of db().codeObjects) { set.add(o.schema); }
    set.add('SH');
    return [...set].sort();
  }

  async listObjects(schema: string, type: ObjectType): Promise<DbObjectRef[]> {
    const out: DbObjectRef[] = [];
    for (const t of db().tables) {
      if (t.schema.toUpperCase() === schema.toUpperCase()) { out.push({ schema: t.schema, type: 'TABLE', name: t.name }); }
    }
    for (const o of db().codeObjects) {
      if (o.schema.toUpperCase() === schema.toUpperCase() && o.type === type) { out.push({ schema: o.schema, type: o.type, name: o.name }); }
    }
    return out.filter((o) => o.type === type).sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeTable(schema: string, table: string): Promise<{ columns: ColumnMeta[]; ddl: string }> {
    const t = db().tables.find(
      (x) => x.name.toUpperCase() === table.toUpperCase() && x.schema.toUpperCase() === schema.toUpperCase(),
    );
    if (!t) { throw new Error(`ORA-00942 (mock): 表不存在 ${schema}.${table}`); }
    return { columns: t.columns, ddl: await this.getDdl({ schema, type: 'TABLE', name: table }) };
  }

  async getDdl(ref: DbObjectRef): Promise<string> {
    if (ref.type === 'TABLE') {
      const t = db().tables.find((x) => x.name.toUpperCase() === ref.name.toUpperCase());
      if (!t) { throw new Error(`ORA-00942 (mock): 表不存在 ${ref.name}`); }
      const cols = t.columns.map((c) => `  "${c.name}" ${c.dataType}${c.nullable ? '' : ' NOT NULL ENABLE'}`).join(',\n');
      const pk = t.columns.filter((c) => c.isPrimaryKey).map((c) => `"${c.name}"`).join(', ');
      return `CREATE TABLE "${ref.schema}"."${ref.name}" (\n${cols}${pk ? `,\n  PRIMARY KEY (${pk})` : ''}\n);`;
    }
    const o = db().codeObjects.find((x) => x.name.toUpperCase() === ref.name.toUpperCase() && x.type === ref.type);
    if (o) { return o.ddl; }
    throw new Error(`ORA-00942 (mock): 对象不存在 ${ref.schema}.${ref.name}`);
  }

  async collectOutput(): Promise<string[]> {
    const out = this.outputBuffer;
    this.outputBuffer = [];
    return out;
  }
}

function classify(sql: string): StatementKind {
  const s = sql.trim().replace(/;+\s*$/, '');
  if (/^select\b/i.test(s)) { return 'SELECT'; }
  if (/^(insert|update|delete|merge)\b/i.test(s)) { return 'DML'; }
  if (/^commit\b/i.test(s)) { return 'COMMIT'; }
  if (/^rollback\b/i.test(s)) { return 'ROLLBACK'; }
  if (/^(declare|begin)\b/i.test(s)) { return 'PLSQL'; }
  if (/^create\s+(or\s+replace\s+)?(procedure|function|package|trigger|type|view)\b/i.test(s)) { return 'PLSQL'; }
  if (/^(create|alter|drop|truncate|grant|revoke|comment)\b/i.test(s)) { return 'DDL'; }
  return 'OTHER';
}

function colIndex(table: MockTable, name: string): number {
  return table.columns.findIndex((c) => c.name.toUpperCase() === name.toUpperCase());
}

function matchesWhere(row: unknown[], table: MockTable, sql: string): boolean {
  const m = sql.match(/\bwhere\s+([\s\S]+?)(\s+order\s+by\b|$)/i);
  if (!m) { return true; }
  const clauses = m[1].split(/\s+and\s+/i);
  for (const clause of clauses) {
    const cm = clause.trim().match(/^([A-Za-z_][\w$#]*)\s*(=|>=|<=|>|<|like)\s*(.+)$/i);
    if (cm) {
      const idx = colIndex(table, cm[1]);
      if (idx < 0) { continue; }
      const cell = row[idx + 1];
      const lit = cm[3].trim().replace(/;$/, '').trim();
      if (!predMatch(cell, cm[2], lit)) { return false; }
    }
    const nm = clause.trim().match(/^([A-Za-z_][\w$#]*)\s+is\s+(null|not\s+null)$/i);
    if (nm) {
      const idx = colIndex(table, nm[1]);
      const isNull = row[idx + 1] === null || row[idx + 1] === undefined;
      if (/not\s+null/i.test(nm[2])) { if (isNull) { return false; } }
      else if (!isNull) { return false; }
    }
  }
  return true;
}

function predMatch(cell: unknown, op: string, lit: string): boolean {
  const litVal = parseLiteral(lit);
  switch (op.toLowerCase()) {
    case '=': return cell === litVal || String(cell) === String(litVal);
    case '>': return Number(cell) > Number(litVal);
    case '<': return Number(cell) < Number(litVal);
    case '>=': return Number(cell) >= Number(litVal);
    case '<=': return Number(cell) <= Number(litVal);
    case 'like': {
      const litStr = String(litVal).replace(/^\u0027|\u0027$/g, '');
      const re = new RegExp('^' + litStr.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
      return re.test(String(cell));
    }
    default: return true;
  }
}

function parseLiteral(lit: string): unknown {
  if (/^'.*'$/s.test(lit)) { return lit.slice(1, -1); }
  if (/^-?\d+(\.\d+)?$/.test(lit)) { return Number(lit); }
  if (/^null$/i.test(lit)) { return null; }
  return lit;
}

function applyOrderBy(rows: unknown[][], table: MockTable, sql: string): unknown[][] {
  const m = sql.match(/\border\s+by\s+([A-Za-z_][\w$#]*)\s*(asc|desc)?\s*;?\s*$/i);
  const out = [...rows];
  if (!m) { return out; }
  const idx = colIndex(table, m[1]) + 1;
  const desc = (m[2] ?? '').toLowerCase() === 'desc';
  out.sort((a, b) => {
    const av = a[idx]; const bv = b[idx];
    const cmp = av === null ? -1 : bv === null ? 1
      : typeof av === 'number' && typeof bv === 'number' ? av - bv
        : String(av).localeCompare(String(bv));
    return desc ? -cmp : cmp;
  });
  return out;
}

function parseSetClause(s: string): Array<{ col: string; value: unknown }> {
  const parts = splitSetParts(s);
  return parts.map((p) => {
    const m = p.match(/^([A-Za-z_][\w$#]*)\s*=\s*(.+)$/i);
    return m ? { col: m[1], value: parseLiteral(m[2].trim()) } : { col: '', value: null };
  }).filter((x) => x.col);
}

function splitSetParts(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") { inStr = !inStr; cur += ch; continue; }
    if (ch === ',' && !inStr) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) { parts.push(cur); }
  return parts;
}

function parseSimplePredicate(where: string, table: MockTable): Array<{ col: string; op: string; value: unknown }> {
  const preds: Array<{ col: string; op: string; value: unknown }> = [];
  for (const clause of where.split(/\s+and\s+/i)) {
    const m = clause.trim().match(/^([A-Za-z_][\w$#]*)\s*(=|>=|<=|>|<)\s*(.+)$/i);
    if (m) {
      const colIdx = colIndex(table, m[1]);
      preds.push({ col: m[1], op: m[2], value: colIdx >= 0 ? coerce(m[3].trim(), table.columns[colIdx].dataType) : parseLiteral(m[3].trim()) });
    }
  }
  return preds;
}

function rowMatchesPred(row: unknown[], table: MockTable, preds: Array<{ col: string; op: string; value: unknown }>): boolean {
  for (const p of preds) {
    const idx = colIndex(table, p.col);
    const cell = row[idx + 1];
    const ok = predMatch(cell, p.op, typeof p.value === 'string' ? `'${p.value}'` : String(p.value));
    if (!ok) { return false; }
  }
  return true;
}

function coerce(v: unknown, dataType: string): unknown {
  if (v === null || v === undefined) { return null; }
  let s = String(v).trim().replace(/^'|'$/g, '');
  if (/^null$/i.test(s)) { return null; }
  if (/^number/i.test(dataType ?? '')) {
    const n = Number(s);
    return Number.isNaN(n) ? s : n;
  }
  return s;
}

function splitValues(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") { inStr = !inStr; cur += ch; continue; }
    if (ch === ',' && !inStr) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) { parts.push(cur.trim()); }
  return parts;
}

function padValues(table: MockTable, colNames: string[], values: unknown[]): unknown[] {
  const out: unknown[] = new Array(table.columns.length).fill(null);
  colNames.forEach((cn, i) => {
    const idx = colIndex(table, cn);
    if (idx >= 0 && i < values.length) { out[idx] = values[i]; }
  });
  return out;
}

function describeChange(c: RowChange): string {
  return c.kind === 'insert' ? `INSERT ${c.table}` : `${c.kind.toUpperCase()} ${c.table} ${c.kind === 'update' ? c.rowId : c.rowId}`;
}
