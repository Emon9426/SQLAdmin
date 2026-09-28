/** 格式化与 Oracle SELECT 改写测试（F2-11 / F3-10） */
import * as assert from 'assert';
import { formatSql } from '../../src/core/format';
import { isSimpleTableSelect, rewriteEditableSelect } from '../../src/driver/oracleDriver';

describe('format · SQL 格式化（F2-11）', () => {
  it('关键字大写与缩进', () => {
    const out = formatSql('select id,name from employees where salary>1000 and dept=10', { tabSize: 2, uppercaseKeywords: true });
    assert.ok(out.includes('SELECT'));
    assert.ok(!/\bselect\b/.test(out));
    assert.ok(out.split('\n').length >= 3);
  });

  it('保留大小写选项', () => {
    const out = formatSql('select id from t', { tabSize: 2, uppercaseKeywords: false });
    assert.ok(out.includes('select'));
  });
});

describe('oracle · 可编辑查询识别与改写（F3-10）', () => {
  it('简单单表识别为可编辑', () => {
    const r = isSimpleTableSelect('SELECT * FROM EMPLOYEES WHERE SALARY > 100');
    assert.deepStrictEqual(r, { schema: undefined, table: 'EMPLOYEES' });
    const r2 = isSimpleTableSelect('select e.EMPLOYEE_ID from HR.EMPLOYEES e order by 1');
    assert.deepStrictEqual(r2, { schema: 'HR', table: 'EMPLOYEES' });
  });

  it('JOIN/聚合/集合运算不可编辑', () => {
    assert.strictEqual(isSimpleTableSelect('SELECT * FROM EMPLOYEES JOIN DEPARTMENTS ON 1=1'), undefined);
    assert.strictEqual(isSimpleTableSelect('SELECT DEPARTMENT_ID, COUNT(*) FROM EMPLOYEES GROUP BY DEPARTMENT_ID'), undefined);
    assert.strictEqual(isSimpleTableSelect('SELECT * FROM A UNION SELECT * FROM B'), undefined);
    assert.strictEqual(isSimpleTableSelect('SELECT DISTINCT LAST_NAME FROM EMPLOYEES'), undefined);
  });

  it('改写注入 ROWID 投影（无别名→注入别名；有别名→沿用）', () => {
    const r1 = rewriteEditableSelect('SELECT * FROM EMPLOYEES WHERE SALARY > 100', 'HR');
    assert.ok(r1!.sql.includes('sqladmin_t.ROWID AS "__ROWID__"'));
    assert.ok(r1!.sql.includes('FROM EMPLOYEES sqladmin_t'));
    assert.ok(r1!.sql.toUpperCase().includes('WHERE'), 'WHERE 子句必须保留（回归：P1 别名吞并关键字）');
    assert.ok(/where\s+salary\s*>\s*100/i.test(r1!.sql), 'WHERE 条件内容不得丢失');

    const r2 = rewriteEditableSelect('SELECT e.EMPLOYEE_ID, e.SALARY FROM EMPLOYEES e WHERE e.SALARY > 5', 'HR');
    assert.ok(r2!.sql.includes('e.ROWID AS "__ROWID__"'));
    assert.ok(r2!.sql.includes('FROM EMPLOYEES e'));
    assert.ok(/where\s+e\.salary\s*>\s*5/i.test(r2!.sql));

    const r3 = rewriteEditableSelect('SELECT * FROM EMPLOYEES ORDER BY SALARY DESC', 'HR');
    assert.ok(/order\s+by\s+salary\s+desc/i.test(r3!.sql), 'ORDER BY 必须保留');
  });

  it('聚合函数查询不可编辑（回归：COUNT(*) 不得被改写）', () => {
    assert.strictEqual(isSimpleTableSelect('SELECT COUNT(*) FROM EMPLOYEES'), undefined);
    assert.strictEqual(isSimpleTableSelect('SELECT DEPARTMENT_ID, SUM(SALARY) FROM EMPLOYEES'), undefined);
    assert.strictEqual(isSimpleTableSelect('SELECT MAX(salary) FROM employees'), undefined);
  });
});
