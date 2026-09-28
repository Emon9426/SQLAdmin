/** Mock 驱动测试（无 Oracle 环境的模拟数据库行为） */
import * as assert from 'assert';
import { MockDriver, resetMockDatabase } from '../../src/driver/mockDriver';
import { newConnectionConfig } from '../../src/driver/types';

function driver(): MockDriver {
  resetMockDatabase();
  const d = new MockDriver(newConnectionConfig({ name: 't', type: 'mock', username: 'HR' }));
  return d;
}

async function connected(): Promise<MockDriver> {
  const d = driver();
  await d.connect('demo');
  return d;
}

describe('mockDriver · 查询（F2-02/F2-04）', () => {
  it('SELECT * 返回全部行并带 __ROWID__ 可编辑定位', async () => {
    const d = await connected();
    const r = await d.execute('SELECT * FROM DEPARTMENTS', {}, { maxRows: 500 });
    assert.strictEqual(r.kind, 'SELECT');
    assert.strictEqual(r.rows!.length, 6);
    assert.ok(r.editable);
    assert.strictEqual(r.editable!.table, 'DEPARTMENTS');
    assert.ok(String(r.rows![0][0]).startsWith('ROWID-DEPARTMENTS-'));
    // 回归（Review P1-2）：可编辑结果 columns 首列为 __ROWID__，列数与行数据一致
    assert.strictEqual(r.columns![0].name, '__ROWID__');
    assert.strictEqual(r.columns!.length, 5);
    assert.strictEqual(r.columns![1].name, 'DEPARTMENT_ID');
  });

  it('WHERE 等值过滤', async () => {
    const d = await connected();
    const r = await d.execute("SELECT * FROM EMPLOYEES WHERE LAST_NAME = 'King'", {}, {});
    assert.strictEqual(r.rows!.length, 1);
    assert.strictEqual(r.rows![0][3], 'King');
  });

  it('ORDER BY DESC 排序', async () => {
    const d = await connected();
    const r = await d.execute('SELECT * FROM EMPLOYEES ORDER BY SALARY DESC', {}, {});
    assert.strictEqual(r.rows![0][1], 100); // Steven King 24000
    assert.strictEqual(r.rows![r.rows!.length - 1][1], 143); // Randall Matos 2600
  });

  it('IS NULL 过滤', async () => {
    const d = await connected();
    const r = await d.execute('SELECT * FROM EMPLOYEES WHERE COMMISSION_PCT IS NULL', {}, {});
    assert.ok(r.rows!.length > 0);
  });

  it('maxRows 截断并标记 truncated', async () => {
    const d = await connected();
    const r = await d.execute('SELECT * FROM EMPLOYEES', {}, { maxRows: 5 });
    assert.strictEqual(r.rows!.length, 5);
    assert.strictEqual(r.rowCount, 14);
    assert.ok(r.truncated);
  });

  it('不存在的表返回 ORA-00942 错误', async () => {
    const d = await connected();
    const r = await d.execute('SELECT * FROM NO_SUCH_TABLE', {}, {});
    assert.ok(r.error!.includes('ORA-00942'));
  });

  it('executeStream 分批回传全量行', async () => {
    const d = await connected();
    let batches = 0; let total = 0;
    const n = await d.executeStream('SELECT * FROM EMPLOYEES', {}, 5, async (rows) => { batches++; total += rows.length; });
    assert.strictEqual(n, 14);
    assert.strictEqual(total, 14);
    assert.strictEqual(batches, 3);
  });
});

describe('mockDriver · DML 与事务（F3-05..09）', () => {
  it('UPDATE 影响行数并修改数据', async () => {
    const d = await connected();
    const r = await d.execute("UPDATE EMPLOYEES SET SALARY = 9999 WHERE EMPLOYEE_ID = 100", {}, {});
    assert.strictEqual(r.kind, 'DML');
    assert.strictEqual(r.affectedRows, 1);
    const q = await d.execute('SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID = 100', {}, {});
    assert.strictEqual(q.rows![0][7], 9999);
  });

  it('INSERT/DELETE 生效', async () => {
    const d = await connected();
    await d.execute("INSERT INTO DEPARTMENTS (DEPARTMENT_ID, DEPARTMENT_NAME) VALUES (99, 'TEMP')", {}, {});
    let q = await d.execute('SELECT * FROM DEPARTMENTS', {}, {});
    assert.strictEqual(q.rows!.length, 7);
    await d.execute('DELETE FROM DEPARTMENTS WHERE DEPARTMENT_ID = 99', {}, {});
    q = await d.execute('SELECT * FROM DEPARTMENTS', {}, {});
    assert.strictEqual(q.rows!.length, 6);
  });

  it('applyChangeset：UPDATE/INSERT/DELETE 直接生效', async () => {
    const d = await connected();
    const q = await d.execute('SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID = 206', {}, {});
    const rowId = String(q.rows![0][0]);
    const r = await d.applyChangeset([
      { kind: 'update', rowId, table: 'EMPLOYEES', changes: { LAST_NAME: { old: 'Gietz', new: 'Gietz-Wagner' } } },
      { kind: 'insert', table: 'EMPLOYEES', values: { EMPLOYEE_ID: 300, LAST_NAME: 'Zhao' } },
    ]);
    assert.strictEqual(r.applied, 2);
    assert.strictEqual(r.errors.length, 0);
    const q2 = await d.execute('SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID = 206', {}, {});
    assert.strictEqual(q2.rows![0][3], 'Gietz-Wagner');
    const q3 = await d.execute('SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID = 300', {}, {});
    assert.strictEqual(q3.rows!.length, 1);
  });

  it('无效 ROWID 报错且计入 errors', async () => {
    const d = await connected();
    const r = await d.applyChangeset([
      { kind: 'delete', rowId: 'ROWID-GONE', table: 'EMPLOYEES' },
    ]);
    assert.strictEqual(r.applied, 0);
    assert.ok(r.errors[0].includes('ORA-01410'));
  });

  it('COMMIT/ROLLBACK 语句分类执行', async () => {
    const d = await connected();
    const c = await d.execute('COMMIT', {}, {});
    const rb = await d.execute('ROLLBACK', {}, {});
    assert.strictEqual(c.kind, 'COMMIT');
    assert.strictEqual(rb.kind, 'ROLLBACK');
  });

  it('PL/SQL 块执行并回收 DBMS_OUTPUT（F2-06）', async () => {
    const d = await connected();
    const r = await d.execute("BEGIN DBMS_OUTPUT.PUT_LINE('工资总额: 692400'); END;", {}, {});
    assert.strictEqual(r.kind, 'PLSQL');
    assert.ok(r.dbmsOutput!.some((l) => l.includes('工资总额')));
    const again = await d.collectOutput();
    assert.strictEqual(again.length, 0); // 已回收清空
  });
});

describe('mockDriver · 元数据（F5）', () => {
  it('listSchemas 含 HR', async () => {
    const d = await connected();
    assert.ok((await d.listSchemas()).includes('HR'));
  });

  it('listObjects 按类型过滤', async () => {
    const d = await connected();
    const tables = await d.listObjects('HR', 'TABLE');
    const procs = await d.listObjects('HR', 'PROCEDURE');
    assert.deepStrictEqual(tables.map((t) => t.name).sort(), ['DEPARTMENTS', 'EMPLOYEES']);
    assert.ok(procs.some((p) => p.name === 'ADD_JOB_HISTORY'));
    assert.ok(procs.every((p) => p.type === 'PROCEDURE'));
  });

  it('describeTable 列元数据含主键/注释', async () => {
    const d = await connected();
    const { columns } = await d.describeTable('HR', 'EMPLOYEES');
    assert.strictEqual(columns.length, 9);
    const id = columns.find((c) => c.name === 'EMPLOYEE_ID')!;
    assert.strictEqual(id.isPrimaryKey, true);
    assert.strictEqual(id.nullable, false);
    assert.ok((columns.find((c) => c.name === 'SALARY')!.comment ?? '').includes('月薪'));
  });

  it('getDdl：表与代码对象', async () => {
    const d = await connected();
    const tableDdl = await d.getDdl({ schema: 'HR', type: 'TABLE', name: 'EMPLOYEES' });
    assert.ok(tableDdl.includes('CREATE TABLE "HR"."EMPLOYEES"'));
    assert.ok(tableDdl.includes('PRIMARY KEY'));
    const procDdl = await d.getDdl({ schema: 'HR', type: 'PROCEDURE', name: 'SECURE_DML' });
    assert.ok(procDdl.includes('CREATE OR REPLACE PROCEDURE HR.SECURE_DML'));
  });
});
