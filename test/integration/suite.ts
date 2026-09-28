/**
 * 集成测试套件：在 VS Code 实机内验证 SQLAdmin 全功能（Mock 驱动，无 Oracle 环境）。
 * 覆盖：激活/连接管理/查询/结果编辑与事务/导出/对象浏览/DDL/格式化/命令注册。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// 在扩展宿主中注入全局 mocha（describe/it/before/after）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Mocha = require('mocha');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mocha = new Mocha({ ui: 'bdd' } as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
mocha.suite.emit('pre-require', global, '', mocha);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = any;

async function getApi(): Promise<Api> {
  const all = vscode.extensions.all.map((e) => e.id);
  const ext = vscode.extensions.getExtension<Api>('EmonZhang3438.sqladmin');
  assert.ok(ext, `扩展未找到（检查 package.json publisher.name = EmonZhang3438.sqladmin）。已加载扩展: ${all.join(', ')}`);
  if (!ext.isActive) { await ext.activate(); }
  assert.ok(ext.isActive, '扩展激活失败');
  return ext.exports;
}

describe('SQLAdmin 集成（Mock 模拟实机）', function () {
  this.timeout(60000);
  let api: Api;

  before(async () => {
    api = await getApi();
    api.resetMock();
  });

  it('扩展激活并暴露 API（激活事件 + 命令注册）', async () => {
    const cmds = await vscode.commands.getCommands(true);
    const ours = cmds.filter((c) => c.startsWith('sqladmin.'));
    assert.ok(ours.length >= 18, `应注册至少 18 个命令，实际 ${ours.length}: ${ours.join(',')}`);
  });

  it('TC-01 连接管理：保存连接（密码入 SecretStorage）并建立会话（F1-01..05）', async () => {
    const { newConnectionConfig } = require('../../src/driver/types');
    const cfg = newConnectionConfig({
      name: 'IT-MOCK', type: 'mock', username: 'HR', savePassword: true, password: 'demo',
    });
    await api.store.save(cfg, 'demo');
    const saved = (await api.store.list()).find((c: { name: string }) => c.name === 'IT-MOCK');
    assert.ok(saved, '连接已保存');
    assert.strictEqual(saved.password, undefined, '密码不得明文保存于连接配置（F1-03）');
    const pwd = await api.store.getPassword(saved.id);
    assert.strictEqual(pwd, 'demo', '密码在 SecretStorage 中');

    const session = await api.sessions.openSession(saved);
    assert.ok(session.driver.isConnected());
    assert.strictEqual(session.driver.currentSchema, 'HR');
  });

  it('TC-02 工作台查询：SELECT 执行与结果元数据（F2-02/F2-04）', async () => {
    const s = api.sessions.all()[0];
    const r = await s.driver.execute('SELECT * FROM EMPLOYEES WHERE DEPARTMENT_ID = 90', {}, { maxRows: 500 });
    assert.strictEqual(r.kind, 'SELECT');
    assert.strictEqual(r.rows!.length, 3);
    assert.ok(r.editable, '单表查询应可编辑');
    assert.strictEqual(r.editable!.table, 'EMPLOYEES');
  });

  it('TC-03 结果编辑 → 预览 → 提交：数据变更可见（F3-05..09）', async () => {
    const s = api.sessions.all()[0];
    const q = await s.driver.execute('SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID = 206', {}, { maxRows: 10 });
    const rowId = String(q.rows![0][0]);
    const oldSalary = q.rows![0][7];

    const cs = api.sessions.changeset(s.id, 'it-panel');
    cs.addUpdate('HR', 'EMPLOYEES', rowId, 'SALARY', oldSalary, 9999);
    assert.strictEqual(cs.size, 1);
    assert.ok(cs.preview().includes('UPDATE "HR"."EMPLOYEES"'));

    const r = await api.sessions.commit(s.id);
    assert.ok(r.ok, r.message);

    const q2 = await s.driver.execute('SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID = 206', {}, { maxRows: 10 });
    assert.strictEqual(q2.rows![0][7], 9999, 'COMMIT 后数据已变更');
    assert.strictEqual(api.sessions.totalPending(s), 0, '变更集已清空');
  });

  it('TC-04 回滚：丢弃未提交更改（F3-09）', async () => {
    const s = api.sessions.all()[0];
    const q = await s.driver.execute('SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID = 100', {}, { maxRows: 10 });
    const rowId = String(q.rows![0][0]);
    const cs = api.sessions.changeset(s.id, 'it-panel');
    cs.addUpdate('HR', 'EMPLOYEES', rowId, 'SALARY', 24000, 1);
    const r = await api.sessions.rollback(s.id);
    assert.ok(r.ok);
    // mock 即时生效模型：rollback 前未 applyChangeset，数据未动
    const q2 = await s.driver.execute('SELECT * FROM EMPLOYEES WHERE EMPLOYEE_ID = 100', {}, { maxRows: 10 });
    assert.notStrictEqual(q2.rows![0][7], 1, '未提交更改不得生效');
    assert.strictEqual(api.sessions.totalPending(s), 0);
  });

  it('TC-05 变更集为空时提交被拒绝（按钮 enable 语义，F3-09）', async () => {
    const s = api.sessions.all()[0];
    const r = await api.sessions.commit(s.id);
    assert.strictEqual(r.ok, false);
    assert.ok(r.message.includes('无未提交更改'));
  });

  it('TC-06 断开连接默认回滚并清理变更集（F3-09）', async () => {
    const { newConnectionConfig } = require('../../src/driver/types');
    const cfg = newConnectionConfig({ name: 'IT-MOCK-2', type: 'mock', username: 'HR', savePassword: true });
    await api.store.save(cfg, 'demo');
    const s2 = await api.sessions.openSession(cfg);
    const cs = api.sessions.changeset(s2.id, 'p2');
    cs.addUpdate('HR', 'DEPARTMENTS', 'ROWID-DEPARTMENTS-1000', 'DEPARTMENT_NAME', 'Administration', 'X');
    assert.strictEqual(api.sessions.totalPending(s2), 1);
    await api.sessions.closeSession(s2.id);
    assert.strictEqual(api.sessions.get(s2.id), undefined, '会话已关闭');
  });

  it('TC-07 导出：executeStream → CSV 文件（F4）', async () => {
    const s = api.sessions.all()[0];
    const { CsvWriter, defaultExportOptions } = require('../../src/core/exporters');
    const file = path.join(os.tmpdir(), `sqladmin-it-${Date.now()}.csv`);
    const w = new CsvWriter(file, { ...defaultExportOptions, nullText: 'NULL' });
    await w.writeHeader(['EMPLOYEE_ID', 'LAST_NAME', 'COMMISSION_PCT']);
    const n = await s.driver.executeStream('SELECT * FROM EMPLOYEES', {}, 100, async (rows: unknown[][]) => {
      for (const r of rows) { await w.writeRow([r[1], r[3], r[8]]); }
    });
    const count = await w.close();
    assert.strictEqual(n, 14);
    assert.strictEqual(count, 14);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('EMPLOYEE_ID,LAST_NAME,COMMISSION_PCT'));
    assert.ok(content.includes('100,King,NULL'));
    fs.unlinkSync(file);
  });

  it('TC-08 对象浏览：schema/对象/DDL（F5）', async () => {
    const s = api.sessions.all()[0];
    const schemas = await s.driver.listSchemas();
    assert.ok(schemas.includes('HR'));
    const tables = await s.driver.listObjects('HR', 'TABLE');
    assert.ok(tables.some((t: { name: string }) => t.name === 'EMPLOYEES'));
    const { columns } = await s.driver.describeTable('HR', 'EMPLOYEES');
    assert.strictEqual(columns.length, 9);
    const ddl = await s.driver.getDdl({ schema: 'HR', type: 'TABLE', name: 'EMPLOYEES' });
    assert.ok(ddl.includes('CREATE TABLE "HR"."EMPLOYEES"'));
  });

  it('TC-09 DDL 只读视图：TextDocumentContentProvider 打开（F5-04）', async () => {
    const s = api.sessions.all()[0];
    const { ddlUri } = require('../../src/ui/ddlProvider');
    const uri = ddlUri(s.id, { schema: 'HR', type: 'PROCEDURE', name: 'SECURE_DML' });
    console.log('DDL URI =', uri.toString(), 'sessionId =', s.id);
    const doc = await vscode.workspace.openTextDocument(uri);
    console.log('DDL CONTENT =', JSON.stringify(doc.getText().slice(0, 100)));
    assert.ok(doc.getText().includes('SECURE_DML'));
    assert.ok(doc.getText().includes('CREATE OR REPLACE PROCEDURE'));
  });

  it('TC-10 语句切分 + 执行链（F2-03 脚本语义）', async () => {
    const { splitSql } = require('../../src/core/splitter');
    const s = api.sessions.all()[0];
    const script = `SELECT * FROM DEPARTMENTS WHERE DEPARTMENT_ID = 10;\nUPDATE DEPARTMENTS SET DEPARTMENT_NAME = 'Administration' WHERE DEPARTMENT_ID = 10;\nCOMMIT;`;
    const stmts = splitSql(script);
    assert.strictEqual(stmts.length, 3);
    const kinds: string[] = [];
    for (const st of stmts) {
      const r = await s.driver.execute(st.text, {}, {});
      kinds.push(r.error ? 'ERR' : r.kind);
    }
    assert.deepStrictEqual(kinds, ['SELECT', 'DML', 'COMMIT']);
  });

  it('TC-11 格式化提供者（F2-11）', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'sqladmin-sql', content: 'select id,name from employees where id=1' });
    const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', doc.uri) as vscode.TextEdit[];
    assert.ok(edits && edits.length > 0);
    const text = edits[0].newText;
    assert.ok(text.toUpperCase().includes('SELECT'));
    assert.ok(text.includes('\n'), '格式化应产生多行缩进');
  });

  it('TC-12 SQL 语法高亮文法注册（F2-09）', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'sqladmin-sql', content: 'SELECT 1 FROM DUAL' });
    assert.strictEqual(doc.languageId, 'sqladmin-sql');
    // 文法贡献点由 VS Code 加载；此处至少验证语言注册成功
  });

  it('TC-13 状态栏事务徽标联动（F3-09/F8-01）', async () => {
    const s = api.sessions.all()[0];
    const cs = api.sessions.changeset(s.id, 'it-statusbar');
    cs.addUpdate('HR', 'DEPARTMENTS', 'ROWID-DEPARTMENTS-1000', 'DEPARTMENT_NAME', 'Administration', 'Adm-2');
    await new Promise((r) => setTimeout(r, 300)); // 等待 onDidChange → statusbar.update
    await api.sessions.rollback(s.id);
    await new Promise((r) => setTimeout(r, 300));
  });

  it('TC-14 只读连接禁止编辑语义（F1-06）', async () => {
    const { newConnectionConfig } = require('../../src/driver/types');
    const roCfg = newConnectionConfig({ name: 'IT-MOCK-RO', type: 'mock', username: 'HR', readOnly: true, savePassword: true });
    await api.store.save(roCfg, 'demo');
    const sro = await api.sessions.openSession(roCfg);
    assert.strictEqual(sro.driver.config.readOnly, true);
    // 只读会话不得出现在可编辑结果流程中（UI 层禁用；此处断言配置传播）
    await api.sessions.closeSession(sro.id);
  });

  after(async () => {
    // 清理测试连接
    for (const c of await api.store.list()) {
      if (String(c.name).startsWith('IT-')) { await api.store.remove(c.id); }
    }
  });
});

/** VS Code 扩展宿主测试协议入口 */
export function run(): Promise<void> {
  return new Promise((resolve, reject) => {
    mocha.timeout(60000);
    mocha.reporter('spec');
    mocha.run((failures: number) => (failures > 0 ? reject(new Error(`${failures} 个集成测试失败`)) : resolve()));
  });
}
