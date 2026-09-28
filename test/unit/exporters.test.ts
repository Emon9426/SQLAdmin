/** 导出器测试（F4-01..05） */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CsvWriter, JsonWriter, InsertWriter, HtmlWriter, XlsxWriter, defaultExportOptions } from '../../src/core/exporters';

const cols = ['ID', 'NAME', 'NOTE'];
const rows: unknown[][] = [
  [1, 'King', null],
  [2, "O'Brien;Jr", 'line1\nline2'],
  [3, 42.5, 'a,b'],
];

function tmp(name: string): string {
  return path.join(os.tmpdir(), `sqladmin-test-${Date.now()}-${name}`);
}

describe('exporters · 导出器', () => {
  it('CSV：转义引号/分隔符/换行，NULL 文本，BOM，行数正确', async () => {
    const file = tmp('a.csv');
    const w = new CsvWriter(file, { ...defaultExportOptions, delimiter: ',', bom: true, nullText: 'NULL' });
    await w.writeHeader(cols);
    for (const r of rows) { await w.writeRow(r); }
    const n = await w.close();
    const content = fs.readFileSync(file, 'utf8');
    assert.strictEqual(n, 3);
    assert.ok(content.startsWith('\uFEFF'));
    assert.ok(content.includes("2,O'Brien;Jr"));        // 值含分号（非分隔符）不包裹
    assert.ok(content.includes('"line1\nline2"'));        // 换行包裹
    assert.ok(content.includes('1,King,NULL'));           // NULL 文本
    assert.ok(content.includes('3,42.5,"a,b"'));          // 值含分隔符逗号 → 包裹转义
    assert.ok(content.replace(/^\uFEFF/, '').split('\n')[0].startsWith('ID,NAME,NOTE'));
  });

  it('CSV：自定义分隔符', async () => {
    const file = tmp('b.csv');
    const w = new CsvWriter(file, { ...defaultExportOptions, delimiter: ';', bom: false });
    await w.writeHeader(cols);
    await w.writeRow([1, 'a', 'b']);
    await w.close();
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('1;a;b'));
    assert.ok(!content.startsWith('\uFEFF'));
  });

  it('JSON：结构化输出，null 保留', async () => {
    const file = tmp('c.json');
    const w = new JsonWriter(file);
    await w.writeHeader(cols);
    for (const r of rows) { await w.writeRow(r); }
    const n = await w.close();
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(n, 3);
    assert.strictEqual(arr[0].ID, 1);
    assert.strictEqual(arr[0].NOTE, null);
    assert.strictEqual(arr[1].NAME, "O'Brien;Jr");
  });

  it('INSERT：字符串转义与 NULL', async () => {
    const file = tmp('d.sql');
    const w = new InsertWriter(file, 'HR.EMPLOYEES', cols);
    for (const r of rows) { await w.writeRow(r); }
    const n = await w.close();
    const content = fs.readFileSync(file, 'utf8');
    assert.strictEqual(n, 3);
    assert.ok(content.includes('INSERT INTO HR.EMPLOYEES ("ID", "NAME", "NOTE")'));
    assert.ok(content.includes(`(2, 'O''Brien;Jr', 'line1\nline2')`));
    assert.ok(content.includes('1, \'King\', NULL'));
  });

  it('HTML：转义与行计数', async () => {
    const file = tmp('e.html');
    const w = new HtmlWriter(file, '测试结果 <1>');
    await w.writeHeader(cols);
    await w.writeRow([1, '<b>x</b>&amp', null]);
    const n = await w.close();
    const content = fs.readFileSync(file, 'utf8');
    assert.strictEqual(n, 1);
    assert.ok(content.includes('&lt;b&gt;x&lt;/b&gt;&amp;amp'));
    assert.ok(content.includes('1 rows'));
  });

  it('XLSX：写出可再被 exceljs 读取', async function () {
    this.timeout(30000);
    const file = tmp('f.xlsx');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = new XlsxWriter(file) as any;
    await w.writeHeader(cols);
    for (const r of rows) { await w.writeRow(r); }
    const n = await w.close();
    assert.strictEqual(n, 3);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0];
    assert.strictEqual(ws.actualRowCount, 4); // 表头 + 3 行
    assert.strictEqual(ws.getRow(2).getCell(1).value, 1);
    assert.strictEqual(ws.getRow(2).getCell(3).value, null);
  });
});
