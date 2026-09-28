/** 语句切分器测试（F2-02/F2-03，R4） */
import * as assert from 'assert';
import { splitSql, statementAt, extractBinds } from '../../src/core/splitter';

describe('splitter · 语句切分', () => {
  it('基本：分号分隔多条语句', () => {
    const stmts = splitSql('SELECT 1 FROM DUAL;\nSELECT 2 FROM DUAL;');
    assert.strictEqual(stmts.length, 2);
    assert.strictEqual(stmts[0].text, 'SELECT 1 FROM DUAL');
    assert.strictEqual(stmts[1].text, 'SELECT 2 FROM DUAL');
  });

  it('字符串内的分号不切分', () => {
    const stmts = splitSql(`SELECT 'a;b;c' AS x FROM DUAL; SELECT 2 FROM DUAL;`);
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].text.includes("'a;b;c'"));
  });

  it("转义单引号（''）字符串", () => {
    const stmts = splitSql(`UPDATE t SET name = 'O''Brien;X' WHERE id = 1; SELECT 1 FROM DUAL;`);
    assert.strictEqual(stmts.length, 2);
  });

  it("q'' 替代引用内的分号不切分", () => {
    const stmts = splitSql(`SELECT q'[a;b]' AS x FROM DUAL; SELECT 2 FROM DUAL;`);
    assert.strictEqual(stmts.length, 2);
  });

  it('行注释与块注释中的分号不切分', () => {
    const stmts = splitSql('SELECT 1 /* x ; y */ FROM DUAL; -- comment ; here\nSELECT 2 FROM DUAL;');
    assert.strictEqual(stmts.length, 2);
  });

  it('双引号标识符中的分号不切分', () => {
    const stmts = splitSql('SELECT "a;b" FROM DUAL; SELECT 2 FROM DUAL;');
    assert.strictEqual(stmts.length, 2);
  });

  it('BEGIN...END 块作为单条语句', () => {
    const sql = `BEGIN\n  UPDATE t SET a = 1;\n  UPDATE t2 SET b = 2;\nEND;\nSELECT 1 FROM DUAL;`;
    const stmts = splitSql(sql);
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].text.startsWith('BEGIN'));
    assert.ok(stmts[0].text.trim().endsWith('END'));
  });

  it('块内 IF...END IF 不提前结束', () => {
    const sql = `BEGIN\n  IF 1 = 1 THEN\n    NULL;\n  END IF;\n  FOR i IN 1..3 LOOP\n    NULL;\n  END LOOP;\nEND;`;
    const stmts = splitSql(sql);
    assert.strictEqual(stmts.length, 1);
  });

  it('DECLARE 块作为单条语句', () => {
    const sql = `DECLARE\n  v NUMBER;\nBEGIN\n  v := 1;\nEND;\nSELECT 1 FROM DUAL;`;
    assert.strictEqual(splitSql(sql).length, 2);
  });

  it('CREATE PROCEDURE ... IS/AS 块作为单条语句', () => {
    const sql = `CREATE OR REPLACE PROCEDURE p AS\nBEGIN\n  NULL;\nEND p;\nSELECT 1 FROM DUAL;`;
    const stmts = splitSql(sql);
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].text.toUpperCase().startsWith('CREATE OR REPLACE PROCEDURE'));
  });

  it('CREATE TABLE（非块）正常分号终止', () => {
    const sql = `CREATE TABLE t (a NUMBER); SELECT 1 FROM DUAL;`;
    assert.strictEqual(splitSql(sql).length, 2);
  });

  it('CASE 表达式内的 END 不终止语句', () => {
    const sql = `SELECT CASE WHEN a = 1 THEN 'x' ELSE 'y' END FROM t; SELECT 2 FROM DUAL;`;
    assert.strictEqual(splitSql(sql).length, 2);
  });

  it('末尾无分号的语句仍被收集', () => {
    const stmts = splitSql('SELECT 1 FROM DUAL;\nSELECT 2 FROM DUAL');
    assert.strictEqual(stmts.length, 2);
  });

  it('空输入返回空数组', () => {
    assert.strictEqual(splitSql('').length, 0);
    assert.strictEqual(splitSql('   \n  ').length, 0);
  });

  it('statementAt：光标在语句内', () => {
    const sql = 'SELECT 1 FROM DUAL;\nSELECT 2 FROM DUAL;';
    const s = statementAt(sql, 5);
    assert.ok(s!.text.startsWith('SELECT 1'));
    const s2 = statementAt(sql, sql.length - 3);
    assert.ok(s2!.text.startsWith('SELECT 2'));
  });

  it('statementAt：光标在空行取下一条', () => {
    const sql = 'SELECT 1 FROM DUAL;\n\nSELECT 2 FROM DUAL;';
    const s = statementAt(sql, 22);
    assert.ok(s!.text.startsWith('SELECT 2'));
  });

  it('extractBinds：提取绑定变量并跳过 :=', () => {
    const sql = 'SELECT * FROM emp WHERE empno = :empno AND ename = :ename';
    const binds = extractBinds(sql);
    assert.deepStrictEqual(binds.sort(), ['empno', 'ename']);
    assert.strictEqual(extractBinds('DECLARE v NUMBER := 5; BEGIN NULL; END;').length, 0);
  });
});
