/**
 * SQLAdmin 扩展入口：注册驱动、命令、树视图、Webview、提供者、状态栏。
 */
import * as vscode from 'vscode';
import { ConnectionConfig, newConnectionConfig, ConnectionType, DbObjectRef } from './driver/types';
import { registerDriver } from './driver/registry';
import { OracleDriver, configureOracleMode } from './driver/oracleDriver';
import { MockDriver, resetMockDatabase } from './driver/mockDriver';
import { ConnectionStore } from './ui/connectionStore';
import { SessionManager } from './sessions/sessionManager';
import { ConnectionsTree } from './ui/connectionsTree';
import { ResultsPanel } from './ui/resultsPanel';
import { DdlContentProvider, DDL_SCHEME, ddlUri } from './ui/ddlProvider';
import { StatusBar } from './ui/statusbar';
import { CompletionProvider, SqlFormatProvider } from './providers/sqlProviders';
import { splitSql, statementAt, extractBinds } from './core/splitter';
import { loadTnsAliases } from './core/tns';

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('SQLAdmin');
  context.subscriptions.push(output);
  output.appendLine(`SQLAdmin ${require('../package.json').version} 激活`);

  // 驱动注册（F7-01）
  registerDriver('oracle', (cfg) => new OracleDriver(cfg));
  registerDriver('mock', (cfg) => new MockDriver(cfg));
  registerDriver('postgres', () => {
    throw new Error('PostgreSQL 支持预留中（计划 v1.0，M5）——当前版本提供 Oracle 与 Mock 演示连接');
  });
  const oracleCfg = vscode.workspace.getConfiguration('sqladmin.oracle');
  configureOracleMode(
    oracleCfg.get('mode') === 'thick' ? 'thick' : 'thin',
    oracleCfg.get('clientLibDir') || undefined,
  );

  const store = new ConnectionStore(context);
  const sessions = new SessionManager(store);
  const tree = new ConnectionsTree(store, sessions);
  gStore = store;
  gTree = tree;
  const statusBar = new StatusBar(sessions);
  const completion = new CompletionProvider(sessions);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('sqladmin.connections', tree),
    vscode.workspace.registerTextDocumentContentProvider(DDL_SCHEME, new DdlContentProvider(sessions)),
    statusBar,
    vscode.languages.registerCompletionItemProvider(['sqladmin-sql', 'sql'], completion, '.', ' '),
    vscode.languages.registerDocumentFormattingEditProvider(['sqladmin-sql', 'sql'], new SqlFormatProvider()),
    vscode.languages.registerDocumentRangeFormattingEditProvider(['sqladmin-sql', 'sql'], new SqlFormatProvider()),
  );

  sessions.onSessionLost(({ session, reason }) => {
    vscode.window.showErrorMessage(`SQLAdmin: 连接 ${session.connectionName} 发生错误（${reason}），会话已按默认策略回滚并关闭。`);
  });

  const D = vscode.commands.registerCommand;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(D(id, fn));

  /* ---------------- 连接管理（F1） ---------------- */

  reg('sqladmin.addConnection', () => connectionWizard(store, sessions, tree));
  reg('sqladmin.createDemoConnection', async () => {
    const existing = (await store.list()).find((c) => c.type === 'mock');
    const cfg = existing ?? newConnectionConfig({
      name: '演示数据库 (Mock HR)', type: 'mock', username: 'HR',
    });
    if (!existing) { await store.save({ ...cfg, password: 'demo', savePassword: true }); }
    await ensureSession(sessions, cfg, tree);
    vscode.window.showInformationMessage('SQLAdmin: 演示连接就绪（内存 HR 示例库：EMPLOYEES 14 行 / DEPARTMENTS 6 行）');
    await vscode.commands.executeCommand('sqladmin.newWorksheet');
  });
  reg('sqladmin.editConnection', (node) => {
    const cfg = node?.kind === 'connection' ? node.cfg : undefined;
    return cfg ? connectionWizard(store, sessions, tree, cfg) : undefined;
  });
  reg('sqladmin.duplicateConnection', async (node) => {
    if (node?.kind !== 'connection') { return; }
    const copy = newConnectionConfig({ ...node.cfg, id: undefined as unknown as string, name: `${node.cfg.name} (副本)` });
    copy.id = undefined as unknown as string;
    await store.save({ ...copy, id: `${copy.name}-${Date.now().toString(36)}` });
    tree.refresh();
  });
  reg('sqladmin.removeConnection', async (node) => {
    const cfg = node?.kind === 'connection' ? node.cfg : (await pickConnection(store));
    if (!cfg) { return; }
    const pick = await vscode.window.showWarningMessage(`删除连接「${cfg.name}」？（不删除数据库对象）`, { modal: true }, '删除');
    if (pick !== '删除') { return; }
    for (const s of sessions.sessionsOfConnection(cfg.id)) { await sessions.closeSession(s.id, { silentRollback: true }); }
    await store.remove(cfg.id);
    tree.refresh();
  });
  reg('sqladmin.connect', async (node) => {
    const cfg = node?.kind === 'connection' ? node.cfg : (await pickConnection(store));
    if (!cfg) { return; }
    await ensureSession(sessions, cfg, tree);
    tree.refresh();
  });
  reg('sqladmin.disconnect', async (node) => {
    const cfg = node?.kind === 'connection' ? node.cfg : (await pickConnection(store));
    if (!cfg) { return; }
    const list = sessions.sessionsOfConnection(cfg.id);
    if (list.length === 0) { vscode.window.showInformationMessage('SQLAdmin: 该连接当前无活动会话'); return; }
    const pending = list.reduce((n, s) => n + sessions.totalPending(s), 0);
    if (pending > 0) {
      const pick = await vscode.window.showWarningMessage(
        `断开 ${cfg.name}：${pending} 项未提交更改将按默认策略回滚（ROLLBACK）丢弃。`,
        { modal: true }, '回滚并断开', '取消');
      if (pick !== '回滚并断开') { return; }
    }
    for (const s of list) { await sessions.closeSession(s.id); }
    tree.refresh();
  });

  /* ---------------- 工作台与执行（F2） ---------------- */

  reg('sqladmin.newWorksheet', async () => {
    const session = await pickSessionInteractive(sessions);
    if (!session) { return; }
    const doc = await vscode.workspace.openTextDocument({ language: 'sqladmin-sql', content: '-- SQLAdmin 工作台 · Ctrl+Enter 执行当前语句 / Ctrl+Shift+Enter 执行脚本\n' });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    sessions.bindEditor(session.id, doc.uri.toString());
    editor.edit((eb) => { eb.insert(new vscode.Position(1, 0), 'SELECT * FROM EMPLOYEES;\n'); });
    output.appendLine(`新建工作台 ${doc.uri.toString()} → 会话 ${session.id}`);
  });

  reg('sqladmin.runStatement', () => runInEditor(sessions, output, 'statement'));
  reg('sqladmin.runScript', () => runInEditor(sessions, output, 'script'));

  /* ---------------- 事务（F3-09） ---------------- */

  reg('sqladmin.commitTransaction', async () => {
    const s = await pickActiveSession(sessions);
    if (!s) { return; }
    const pending = sessions.totalPending(s);
    if (pending === 0) {
      vscode.window.showInformationMessage('SQLAdmin: 无未提交更改（提交/回滚仅在存在数据变更时可用）');
      return;
    }
    const pick = await vscode.window.showWarningMessage(`提交 ${pending} 项更改并 COMMIT？`, { modal: true }, '提交');
    if (pick !== '提交') { return; }
    const r = await sessions.commit(s.id);
    vscode.window[r.ok ? 'showInformationMessage' : 'showErrorMessage'](`SQLAdmin: ${r.message}`);
    refreshAllResults(sessions);
  });
  reg('sqladmin.rollbackTransaction', async () => {
    const s = await pickActiveSession(sessions);
    if (!s) { return; }
    const pending = sessions.totalPending(s);
    if (pending === 0) {
      vscode.window.showInformationMessage('SQLAdmin: 无未提交更改');
      return;
    }
    const pick = await vscode.window.showWarningMessage(`回滚并丢弃全部 ${pending} 项未提交更改？`, { modal: true }, '回滚');
    if (pick !== '回滚') { return; }
    const r = await sessions.rollback(s.id);
    vscode.window[r.ok ? 'showInformationMessage' : 'showErrorMessage'](`SQLAdmin: ${r.message}`);
    refreshAllResults(sessions);
  });
  reg('sqladmin.previewChanges', async () => {
    const s = await pickActiveSession(sessions);
    if (!s) { return; }
    const { generateChangesetPreview } = await import('./core/changeset');
    const preview = generateChangesetPreview([...s.changesets.values()].flatMap((c) => [...c.all]));
    if (preview === '-- 无待提交更改') {
      vscode.window.showInformationMessage('SQLAdmin: 无待提交更改');
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'sqladmin-sql', content: preview });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  });
  reg('sqladmin.discardAllChanges', async () => {
    const s = await pickActiveSession(sessions);
    if (!s) { return; }
    const r = await sessions.rollback(s.id);
    vscode.window[r.ok ? 'showInformationMessage' : 'showErrorMessage'](`SQLAdmin: ${r.message}`);
    refreshAllResults(sessions);
  });
  reg('sqladmin.exportResults', () => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'));

  /* ---------------- 对象浏览器（F5） ---------------- */

  reg('sqladmin.openTableData', async (node) => {
    const ref: DbObjectRef | undefined = node?.kind === 'object' ? node.ref : undefined;
    if (!ref) { return; }
    const session = sessions.sessionsOfConnection(node.connectionId)[0];
    if (!session) { vscode.window.showErrorMessage('SQLAdmin: 会话已断开'); return; }
    const sql = `SELECT * FROM ${ref.schema}.${ref.name}`;
    const res = await session.driver.execute(sql, {}, { maxRows: fetchRows() });
    const panelKey = `data:${ref.schema}.${ref.name}`;
    const panel = ResultsPanel.forKey(panelKey, session.id, sessions,
      async () => (await session.driver.execute(sql, {}, { maxRows: fetchRows() })));
    panel.setReloadContext(async () => (await session.driver.execute(sql, {}, { maxRows: fetchRows() })), sql);
    await panel.showResults([res], []);
  });
  reg('sqladmin.viewDdl', async (node) => {
    const ref: DbObjectRef | undefined = node?.kind === 'object' ? node.ref : undefined;
    if (!ref) { return; }
    const session = sessions.sessionsOfConnection(node.connectionId)[0];
    if (!session) { vscode.window.showErrorMessage('SQLAdmin: 会话已断开'); return; }
    const uri = ddlUri(session.id, ref);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  });
  reg('sqladmin.generateSelect', async (node) => {
    const ref: DbObjectRef | undefined = node?.kind === 'object' ? node.ref : undefined;
    if (!ref) { return; }
    const session = sessions.sessionsOfConnection(node.connectionId)[0];
    if (!session) { return; }
    const { columns } = await session.driver.describeTable(ref.schema, ref.name);
    const cols = columns.map((c) => `  ${c.name.toLowerCase()}`).join(',\n');
    const doc = await vscode.workspace.openTextDocument({
      language: 'sqladmin-sql',
      content: `SELECT\n${cols}\n  FROM ${ref.schema}.${ref.name.toLowerCase()}\n WHERE 1 = 1;\n`,
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  });
  reg('sqladmin.generateInsert', async (node) => {
    const ref: DbObjectRef | undefined = node?.kind === 'object' ? node.ref : undefined;
    if (!ref) { return; }
    const session = sessions.sessionsOfConnection(node.connectionId)[0];
    if (!session) { return; }
    const { columns } = await session.driver.describeTable(ref.schema, ref.name);
    const cols = columns.map((c) => c.name.toLowerCase()).join(', ');
    const vals = columns.map((c) => `:${c.name.toLowerCase().replace(/_(.)/g, (_m, g) => g.toUpperCase())}`).join(', ');
    const binds = columns.map((c) => `  ${(c.name.toLowerCase().replace(/_(.)/g, (_m, g) => g.toUpperCase()))} ${c.dataType}${c.nullable ? '' : ' NOT NULL'}`).join('\n');
    const doc = await vscode.workspace.openTextDocument({
      language: 'sqladmin-sql',
      content: `INSERT INTO ${ref.schema}.${ref.name.toLowerCase()} (${cols})\nVALUES (${vals});\n\n/* 绑定变量：\n${binds}\n*/\n`,
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  });
  reg('sqladmin.refreshTree', () => { completion.invalidate(); tree.refresh(); });
  reg('sqladmin.showOutputChannel', () => output.show());

  // 测试/演示 API（集成测试使用）
  const api = {
    sessions, store, tree, output,
    resetMock: () => resetMockDatabase(),
    createSessionFor: async (cfg: ConnectionConfig) => ensureSession(sessions, cfg, tree),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (module.exports as any).sqladminApi = api;
  return api;
}

export function deactivate(): void {
  /* 会话清理由各 driver close 处理 */
}

/* ======================= 辅助函数 ======================= */

let gStore: ConnectionStore;
let gTree: ConnectionsTree;

function fetchRows(): number {
  return vscode.workspace.getConfiguration('sqladmin').get('defaultFetchRows') ?? 500;
}

async function pickConnection(store: ConnectionStore): Promise<ConnectionConfig | undefined> {
  const all = await store.list();
  if (all.length === 0) {
    vscode.window.showInformationMessage('SQLAdmin: 尚无保存的连接，请先新建连接');
    await vscode.commands.executeCommand('sqladmin.addConnection');
    return undefined;
  }
  const picks = all.map((c) => ({ label: c.name, description: c.type, cfg: c }));
  const sel = await vscode.window.showQuickPick(picks, { placeHolder: '选择连接' });
  return sel?.cfg;
}

async function ensureSession(sessions: SessionManager, cfg: ConnectionConfig, tree: ConnectionsTree | undefined) {
  const existing = sessions.sessionsOfConnection(cfg.id);
  if (existing.length > 0) { return existing[0]; }
  try {
    const s = await sessions.openSession(cfg);
    (tree ?? gTree)?.refresh();
    return s;
  } catch (e) {
    vscode.window.showErrorMessage(`SQLAdmin: 连接失败 ${cfg.name} — ${String(e)}`);
    gTree?.refresh();
    return undefined;
  }
}

async function pickSessionInteractive(sessions: SessionManager) {
  const live = sessions.all();
  const livePicks = live.map((s) => ({
    label: `${s.connectionName} · ${s.driver.currentSchema}`,
    description: `会话 ${s.id}（已连接）`,
    session: s,
  }));
  const connPicks = (await gStore.list()).map((c) => ({ label: c.name, description: c.type, conn: c }));
  const all = [...livePicks, ...connPicks];
  if (all.length === 0) {
    vscode.window.showInformationMessage('SQLAdmin: 请先创建连接');
    await vscode.commands.executeCommand('sqladmin.addConnection');
    return undefined;
  }
  const sel = all.length === 1 ? all[0] : await vscode.window.showQuickPick(all, { placeHolder: '选择数据库会话' });
  if (!sel) { return undefined; }
  if ('session' in sel) { return sel.session; }
  return ensureSession(sessions, sel.conn, undefined);
}

async function pickActiveSession(sessions: SessionManager) {
  const key = vscode.window.activeTextEditor?.document.uri.toString();
  const active = sessions.active(key);
  if (active) { return active; }
  return pickSessionInteractive(sessions);
}

const bindValueCache = new Map<string, Record<string, unknown>>();

/** 连接类错误（会话不可用）：ORA-03113/03114 断连、超时、TNS 丢失等 */
function isConnectionError(message: string): boolean {
  return /ORA-(0311[0-9]|1254[0-9]|1257[0-9]|12170|28547)|NJS-\d+|connection\s+(terminat|closed|reset)|not\s+connected/i.test(message);
}

async function runInEditor(sessions: SessionManager, output: vscode.OutputChannel, mode: 'statement' | 'script'): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage('SQLAdmin: 请先打开 SQL 工作台'); return; }
  const session = await pickActiveSession(sessions);
  if (!session) { return; }
  const doc = editor.document;
  const text = doc.getText();
  const panelKey = doc.uri.toString();

  let statements: { text: string; startOffset: number }[];
  if (mode === 'statement') {
    if (editor.selection && !editor.selection.isEmpty) {
      statements = [{ text: doc.getText(editor.selection), startOffset: doc.offsetAt(editor.selection.start) }];
    } else {
      const offset = doc.offsetAt(editor.selection.active);
      const stmt = statementAt(text, offset);
      if (!stmt) { vscode.window.showInformationMessage('SQLAdmin: 光标处未找到可执行的语句'); return; }
      statements = [stmt];
    }
  } else {
    statements = splitSql(text).filter((s) => s.text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0);
    if (statements.length === 0) { vscode.window.showInformationMessage('SQLAdmin: 未发现可执行语句'); return; }
  }

  const driver = session.driver;
  const maxRows = fetchRows();
  const results: import('./driver/types').QueryResult[] = [];
  const logs: string[] = [];
  let stopOnError = true;

  for (const stmt of statements) {
    const lineNo = text.slice(0, stmt.startOffset).split('\n').length;
    const t0 = Date.now();
    // 绑定变量（F2-08）
    const binds = extractBinds(stmt.text);
    const values: Record<string, unknown> = {};
    const cached = bindValueCache.get(session.id) ?? {};
    for (const b of binds) {
      const input = await vscode.window.showInputBox({
        prompt: `绑定变量 :${b}（语句第 ${lineNo} 行）`,
        value: String(cached[b] ?? ''),
        ignoreFocusOut: true,
      });
      if (input === undefined) { logs.push(`✗ 已取消（:${b} 未赋值）`); return; }
      values[b] = input === '' ? null : (isNaN(Number(input)) ? input : Number(input));
    }
    if (binds.length > 0) { bindValueCache.set(session.id, { ...cached, ...values }); }

    const res = await driver.execute(stmt.text, values, { maxRows });
    results.push(res);
    if (res.error) {
      logs.push(`✗ 语句 ${logs.length + 1} (第 ${lineNo} 行): ${res.error}`);
      if (isConnectionError(res.error)) {
        // 连接类错误：会话不可用，按默认策略回滚未提交更改并关闭（F3-09）
        logs.push('⚠ 连接错误：未提交更改已按默认策略回滚，会话已关闭');
        await sessions.handleConnectionError(session.id, res.error);
        break;
      }
      if (stopOnError) { break; }
    } else if (res.kind === 'SELECT') {
      logs.push(`✓ 语句 ${logs.length + 1} (第 ${lineNo} 行): ${res.kind} · ${res.rows?.length ?? 0} 行 · ${res.durationMs} ms`);
    } else {
      logs.push(`✓ 语句 ${logs.length + 1} (第 ${lineNo} 行): ${res.kind} · ${res.message ?? ''} · ${res.durationMs} ms`);
    }
    if (res.dbmsOutput?.length) { logs.push(...res.dbmsOutput.map((l) => `DBMS_OUTPUT: ${l}`)); }
    output.appendLine(`[${session.connectionName}] ${res.error ? '✗' : '✓'} ${stmt.text.slice(0, 80)} (${Date.now() - t0}ms)`);
  }

  const reloadFn = async () => {
    const lastSelect = [...results].reverse().find((r) => r.kind === 'SELECT' && !r.error);
    if (!lastSelect) { return undefined; }
    return driver.execute(lastSelect.sql, {}, { maxRows });
  };
  const panel = ResultsPanel.forKey(panelKey, session.id, sessions, reloadFn);
  panel.setReloadContext(reloadFn, [...results].reverse().find((r) => r.kind === 'SELECT')?.sql ?? '');
  await panel.showResults(results, logs);
  const errs = results.filter((r) => r.error);
  if (errs.length > 0) {
    vscode.window.showErrorMessage(`SQLAdmin: ${errs[0].error}`);
  }
}

function refreshAllResults(sessions: SessionManager): void {
  for (const s of sessions.all()) {
    for (const [key] of s.changesets) {
      ResultsPanel.find(key)?.refreshCounts();
    }
  }
}

/* ---------------- 连接向导（F1-01/03/05） ---------------- */

async function connectionWizard(store: ConnectionStore, sessions: SessionManager, tree: ConnectionsTree, edit?: ConnectionConfig): Promise<void> {
  const cfg = edit ? { ...edit } : newConnectionConfig();

  // 1. 连接类型
  const typePick = await vscode.window.showQuickPick([
    { label: 'Oracle Database', value: 'oracle' as ConnectionType },
    { label: 'Mock 演示数据库（无需 Oracle，内置 HR 示例库）', value: 'mock' as ConnectionType },
    { label: 'PostgreSQL（预留，v1.0 支持）', value: 'postgres' as ConnectionType, picked: false, disabled: true } as vscode.QuickPickItem & { value: ConnectionType; disabled?: boolean },
  ], { placeHolder: '连接类型', ignoreFocusOut: true });
  if (!typePick) { return; }
  if ((typePick as { disabled?: boolean }).disabled) {
    vscode.window.showInformationMessage('SQLAdmin: PostgreSQL 支持预留中（F7-02），将在 v1.0 提供');
    return;
  }
  cfg.type = typePick.value;

  // 2. 名称
  const name = await vscode.window.showInputBox({ prompt: '连接名称', value: cfg.name, ignoreFocusOut: true });
  if (name === undefined) { return; }
  cfg.name = name.trim() || 'New Connection';

  // 3. 寻址模式（F1-05：基本 / TNS 别名 / 连接串）
  if (cfg.type === 'oracle') {
    const modePick = await vscode.window.showQuickPick([
      { label: '基本（主机 / 端口 / 服务名）', value: 'basic' },
      { label: 'TNS 别名（解析本机 tnsnames.ora）', value: 'tns' },
      { label: '连接串（Easy Connect / 完整描述符）', value: 'connstring' },
    ], { placeHolder: '连接模式', ignoreFocusOut: true });
    if (!modePick) { return; }
    cfg.mode = modePick.value as ConnectionConfig['mode'];

    if (cfg.mode === 'basic') {
      const host = await vscode.window.showInputBox({ prompt: '主机名', value: cfg.host || 'localhost', ignoreFocusOut: true });
      if (host === undefined) { return; }
      const port = await vscode.window.showInputBox({ prompt: '端口', value: String(cfg.port || 1521), ignoreFocusOut: true });
      if (port === undefined) { return; }
      const svc = await vscode.window.showInputBox({ prompt: '服务名（如 XEPDB1）', value: cfg.serviceName, ignoreFocusOut: true });
      if (svc === undefined) { return; }
      cfg.host = host.trim(); cfg.port = Number(port) || 1521; cfg.serviceName = svc.trim();
    } else if (cfg.mode === 'tns') {
      const tnsCustom: string = vscode.workspace.getConfiguration('sqladmin.tns').get('customPath') ?? cfg.tnsFile;
      const tns = loadTnsAliases(tnsCustom);
      if (tns.error) {
        vscode.window.showWarningMessage(`SQLAdmin: ${tns.error}`);
        const manual = await vscode.window.showInputBox({ prompt: '手动输入 tnsnames.ora 路径（留空跳过）', value: cfg.tnsFile, ignoreFocusOut: true });
        if (manual === undefined) { return; }
        cfg.tnsFile = manual.trim();
        const retry = loadTnsAliases(cfg.tnsFile);
        if (retry.error) { vscode.window.showErrorMessage(`SQLAdmin: ${retry.error}`); return; }
        return tnsPick(retry, cfg, store, sessions, tree);
      }
      return tnsPick(tns, cfg, store, sessions, tree);
    } else {
      const cs = await vscode.window.showInputBox({
        prompt: '连接串（Easy Connect 如 host:1521/service 或完整连接描述符）',
        value: cfg.connectString, ignoreFocusOut: true,
      });
      if (cs === undefined) { return; }
      cfg.connectString = cs.trim();
    }
  }

  return credentialSteps(cfg, store, sessions, tree);
}

async function tnsPick(tns: ReturnType<typeof loadTnsAliases>, cfg: ConnectionConfig, store: ConnectionStore, sessions: SessionManager, tree: ConnectionsTree): Promise<void> {
  const items = tns.entries.flatMap((e) => e.aliases.map((a) => ({
    label: a,
    description: e.host ? `${e.host}:${e.port ?? 1521}${e.service ? '/' + e.service : ''}` : '',
    detail: e.description.split('\n').slice(0, 3).join(' '),
  })));
  const sel = await vscode.window.showQuickPick(items, {
    placeHolder: `选择 TNS 别名（解析自 ${tns.file}，共 ${items.length} 个）`,
    ignoreFocusOut: true,
    matchOnDetail: true,
  });
  if (!sel) { return; }
  cfg.tnsAlias = sel.label;
  return credentialSteps(cfg, store, sessions, tree);
}

async function credentialSteps(cfg: ConnectionConfig, store: ConnectionStore, sessions: SessionManager, tree: ConnectionsTree): Promise<void> {
  // 用户名 / 密码（F1-03）
  const user = await vscode.window.showInputBox({ prompt: '用户名', value: cfg.username || (cfg.type === 'mock' ? 'HR' : ''), ignoreFocusOut: true });
  if (user === undefined) { return; }
  cfg.username = user.trim();
  const pwd = await vscode.window.showInputBox({
    prompt: '密码', password: true, value: cfg.password ?? (cfg.type === 'mock' ? 'demo' : ''),
    ignoreFocusOut: true, placeHolder: cfg.type === 'mock' ? '演示连接默认 demo' : '',
  });
  if (pwd === undefined) { return; }
  cfg.password = pwd;
  const savePwdPick = await vscode.window.showQuickPick([
    { label: '保存密码（VS Code 安全存储，永不明文写入配置）', value: true },
    { label: '不保存密码（每次连接时询问）', value: false },
  ], { placeHolder: '密码保存策略', ignoreFocusOut: true });
  if (!savePwdPick) { return; }
  cfg.savePassword = savePwdPick.value;

  const rolePick = await vscode.window.showQuickPick([
    { label: 'default', value: 'default' }, { label: 'SYSDBA', value: 'sysdba' }, { label: 'SYSOPER', value: 'sysoper' },
  ], { placeHolder: '角色', ignoreFocusOut: true });
  if (!rolePick) { return; }
  cfg.role = rolePick.value as ConnectionConfig['role'];
  const roPick = await vscode.window.showQuickPick([
    { label: '否（允许编辑数据）', value: false }, { label: '是·只读连接（禁止结果编辑与 DML 确认）', value: true },
  ], { placeHolder: '只读连接？（生产环境建议开启）', ignoreFocusOut: true });
  if (!roPick) { return; }
  cfg.readOnly = roPick.value;

  // 测试连接
  const testPick = await vscode.window.showQuickPick([
    { label: '测试连接', value: 'test' }, { label: '直接保存', value: 'save' },
  ], { placeHolder: '下一步', ignoreFocusOut: true });
  if (!testPick) { return; }
  if (testPick.value === 'test') {
    const { createDriver } = await import('./driver/registry');
    try {
      const tester = createDriver(cfg);
      const r = await tester.testConnection(cfg.password);
      if (r.ok) { vscode.window.showInformationMessage(`SQLAdmin: ✓ 连接成功 — ${r.detail}`); }
      else {
        const cont = await vscode.window.showErrorMessage(`SQLAdmin: ✗ ${r.detail}`, '仍然保存', '返回修改');
        if (cont !== '仍然保存') { return credentialSteps(cfg, store, sessions, tree); }
      }
    } catch (e) {
      vscode.window.showErrorMessage(`SQLAdmin: ${String(e)}`);
    }
  }
  await store.save(cfg, cfg.password);
  tree.refresh();
  vscode.window.showInformationMessage(`SQLAdmin: 连接「${cfg.name}」已保存`);
}
