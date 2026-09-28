/** 变更集与 DML 生成测试（F3-05..09） */
import * as assert from 'assert';
import { Changeset, generateDml, generateChangesetPreview } from '../../src/core/changeset';

describe('changeset · 变更集', () => {
  it('UPDATE：合并同行多列为一条变更并生成绑定变量 SQL', () => {
    const cs = new Changeset();
    cs.addUpdate('HR', 'EMPLOYEES', 'AAAW1s', 'LAST_NAME', 'Gietz', 'Gietz-Wagner');
    cs.addUpdate('HR', 'EMPLOYEES', 'AAAW1s', 'SALARY', 8300, 9200);
    assert.strictEqual(cs.size, 1);
    const dml = generateDml(cs.all[0]);
    assert.strictEqual(
      dml.sql,
      'UPDATE "HR"."EMPLOYEES" SET "LAST_NAME" = :b1, "SALARY" = :b2 WHERE ROWID = :rowid',
    );
    assert.deepStrictEqual(dml.binds, { rowid: 'AAAW1s', b1: 'Gietz-Wagner', b2: 9200 });
  });

  it('INSERT/DELETE 生成', () => {
    const cs = new Changeset();
    cs.addInsertWithKey('HR', 'EMPLOYEES', 'NEW-1', { EMPLOYEE_ID: 300, LAST_NAME: 'Zhao' });
    cs.addDelete('HR', 'EMPLOYEES', 'AAAW9x');
    const [ins, del] = cs.all;
    assert.strictEqual(generateDml(ins).sql, 'INSERT INTO "HR"."EMPLOYEES" ("EMPLOYEE_ID", "LAST_NAME") VALUES (:i1, :i2)');
    assert.strictEqual(generateDml(del).sql, 'DELETE FROM "HR"."EMPLOYEES" WHERE ROWID = :rowid');
  });

  it('summary 统计', () => {
    const cs = new Changeset();
    cs.addUpdate('HR', 'T', 'r1', 'A', 1, 2);
    cs.addUpdate('HR', 'T', 'r2', 'A', 1, 3);
    cs.addInsert('HR', 'T', { A: 1 });
    cs.addDelete('HR', 'T', 'r3');
    assert.deepStrictEqual(cs.summary(), { updates: 2, inserts: 1, deletes: 1 });
  });

  it('删除待提交的新增行 ⇒ 撤销 INSERT 而非生成 DELETE', () => {
    const cs = new Changeset();
    cs.addInsertWithKey('HR', 'EMPLOYEES', 'NEW-1', { EMPLOYEE_ID: 1 });
    cs.addDelete('HR', 'EMPLOYEES', 'NEW-1');
    assert.strictEqual(cs.size, 0);
  });

  it('删除已有 UPDATE 的行 ⇒ 移除 UPDATE 并生成 DELETE', () => {
    const cs = new Changeset();
    cs.addUpdate('HR', 'EMPLOYEES', 'AAAW1s', 'SALARY', 1, 2);
    cs.addDelete('HR', 'EMPLOYEES', 'AAAW1s');
    assert.strictEqual(cs.size, 1);
    assert.strictEqual(cs.all[0].kind, 'delete');
  });

  it('undoCell 撤销单列；列清空后移除该行变更', () => {
    const cs = new Changeset();
    cs.addUpdate('HR', 'EMP', 'r1', 'A', 1, 2);
    cs.addUpdate('HR', 'EMP', 'r1', 'B', 1, 3);
    cs.undoCell('r1', 'A');
    assert.strictEqual(cs.size, 1);
    cs.undoCell('r1', 'B');
    assert.strictEqual(cs.size, 0);
  });

  it('预览包含计数头与前后值注释', () => {
    const cs = new Changeset();
    cs.addUpdate('HR', 'EMPLOYEES', 'AAAW1s', 'LAST_NAME', 'Gietz', 'Gietz-Wagner');
    const p = generateChangesetPreview([...cs.all]);
    assert.ok(p.includes('待提交更改：1 项'));
    assert.ok(p.includes("'Gietz' -> 'Gietz-Wagner'"));
    assert.strictEqual(generateChangesetPreview([]), '-- 无待提交更改');
  });

  it('clear 清空变更集（回滚语义）', () => {
    const cs = new Changeset();
    cs.addUpdate('HR', 'T', 'r', 'A', 1, 2);
    cs.clear();
    assert.ok(cs.isEmpty);
  });
});
