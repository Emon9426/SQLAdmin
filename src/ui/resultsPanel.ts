/**
 * 结果面板（Webview）：结果集网格 + 脚本输出 + DBMS_OUTPUT 标签。
 * 支持结果内编辑（F3-05..09）：单元格编辑/行增删 → 变更集 → 预览/提交/回滚。
 * 提交/回滚按钮仅在变更集非空时可用并高亮（F3-09）。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { QueryResult, ColumnMeta } from '../driver/types';
import { SessionManager, SessionInfo } from '../sessions/sessionManager';
import { createWriter, ExportFormat, defaultExportOptions, columnNames } from '../core/exporters';
import { generateChangesetPreview } from '../core/changeset';

interface GridCell { v: string; state: 'normal' | 'mod' | 'err'; isNull: boolean }
interface GridRow { key: string; isNew: boolean; deleted: boolean; cells: GridCell[]; selected: boolean }
interface PanelState {
  title: string;
  editable: boolean;
  readOnlyReason?: string;
  columns: { name: string; dataType: string; numeric: boolean }[];
  rows: GridRow[];
  nullText: string;
  truncated: boolean;
  totalRows: number;
  durationMs: number;
  dbmsOutput: string[];
  scriptLog: string[];
  changesCount: number;
  lastError?: string;
}

export class ResultsPanel {
  private static panels = new Map<string, ResultsPanel>();
  readonly panel: vscode.WebviewPanel;
  private state!: PanelState;
  private originalRows: Map<string, string[]> = new Map(); // key → 原始值（字符串化）
  private nextNewKey = 1;

  private constructor(
    private key: string,
    private sessionId: string,
    private sessions: SessionManager,
    private resultContext: { schema?: string; table: string } | undefined,
    private reload: () => Promise<QueryResult | undefined>,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'sqladmin.results',
      `结果 · ${key}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.panel.onDidDispose(() => ResultsPanel.panels.delete(key));
  }

  static forKey(key: string, sessionId: string, sessions: SessionManager,
    reload: () => Promise<QueryResult | undefined>): ResultsPanel {
    let p = ResultsPanel.panels.get(key);
    if (p && p.sessionId === sessionId) { p.panel.reveal(); return p; }
    if (p) { p.panel.dispose(); }
    p = new ResultsPanel(key, sessionId, sessions, undefined, reload);
    ResultsPanel.panels.set(key, p);
    return p;
  }

  static find(key: string): ResultsPanel | undefined { return ResultsPanel.panels.get(key); }

  /** 展示一次执行的全部结果（多结果集 + 脚本日志 + DBMS_OUTPUT） */
  async showResults(results: QueryResult[], scriptLog: string[]): Promise<void> {
    const errs = results.filter((r) => r.error).map((r) => r.error);
    const first = results.find((r) => r.kind === 'SELECT' && !r.error) ?? results[0];
    this.resultContext = first?.editable ? { schema: first.editable.schema, table: first.editable.table } : undefined;
    this.setStateFromResult(first, results, scriptLog, errs[0]);
  }

  private setStateFromResult(res: QueryResult | undefined, all: QueryResult[], scriptLog: string[], lastError?: string): void {
    const cfg = vscode.workspace.getConfiguration('sqladmin');
    const nullText: string = cfg.get('results.nullText') ?? '(NULL)';
    const session = this.sessions.get(this.sessionId);
    const readOnlyConn = session?.driver.config.readOnly;
    this.originalRows.clear();
    let columns: PanelState['columns'] = [];
    let rows: GridRow[] = [];
    let editable = false;
    let readOnlyReason: string | undefined;
    if (res && res.kind === 'SELECT' && res.columns && res.rows) {
      const rowIdCol = res.editable?.rowIdColumn;
      const rowIdIdx = rowIdCol ? res.columns.findIndex((c) => c.name === rowIdCol) : -1;
      columns = res.columns
        .map((c, i) => ({ name: c.name, dataType: c.dataType, numeric: /^number|binary_double|binary_float/i.test(c.dataType) }))
        .filter((_, i) => i !== rowIdIdx);
      if (!res.editable) {
        readOnlyReason = '结果非单表可定位查询（JOIN/聚合等），只读';
      } else if (readOnlyConn) {
        readOnlyReason = '只读连接（F1-06），编辑已禁用';
      } else {
        editable = true;
      }
      rows = res.rows.map((r) => {
        const key = String(rowIdIdx >= 0 ? r[rowIdIdx] : `r-${this.originalRows.size}`);
        const vals = (r as unknown[]).map((v) => stringify(v, nullText));
        this.originalRows.set(key, vals);
        const cells = (r as unknown[])
          .filter((_, i) => i !== rowIdIdx)
          .map((v) => ({ v: stringify(v, nullText), state: 'normal' as const, isNull: v === null || v === undefined }));
        return { key, isNew: false, deleted: false, cells, selected: false };
      });
    }
    const dbmsOutput = all.flatMap((r) => r.dbmsOutput ?? []);
    const changes = this.safeChangeset();
    this.state = {
      title: res?.editable ? `${res.editable.schema ? res.editable.schema + '.' : ''}${res.editable.table}` : (res?.kind ?? '结果'),
      editable,
      readOnlyReason,
      columns,
      rows,
      nullText,
      truncated: !!res?.truncated,
      totalRows: res?.rowCount ?? rows.length,
      durationMs: res?.durationMs ?? 0,
      dbmsOutput,
      scriptLog,
      changesCount: changes?.size ?? 0,
      lastError: lastError ?? (res?.error),
    };
    this.render();
  }

  refreshCounts(): void {
    if (!this.state) { return; }
    this.state.changesCount = this.safeChangeset()?.size ?? 0;
    this.render();
  }

  private safeChangeset() {
    try { return this.sessions.changeset(this.sessionId, this.key); } catch { return undefined; }
  }

  private render(): void {
    this.panel.webview.html = this.html(this.state);
  }

  private html(s: PanelState): string {
    const nonce = Math.random().toString(36).slice(2);
    const cs = this.safeChangeset();
    const summary = cs?.summary() ?? { updates: 0, inserts: 0, deletes: 0 };
    const stateLiteral = JSON.stringify(s).replace(/<\/script/gi, '<\\/script');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12.5px; color: var(--vscode-editor-foreground); padding: 0; margin: 0; }
  .tabs { display: flex; gap: 2px; padding: 4px 8px 0; background: var(--vscode-panel-background); border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { padding: 4px 12px; cursor: pointer; color: var(--vscode-descriptionForeground); border-radius: 4px 4px 0 0; }
  .tab.active { color: var(--vscode-panelTitle-activeForeground); border-bottom: 2px solid var(--vscode-panelTitle-activeBorder); }
  .toolbar { display: flex; align-items: center; gap: 6px; padding: 5px 10px; flex-wrap: wrap; background: var(--vscode-panel-background); border-bottom: 1px solid var(--vscode-panel-border); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 3px 12px; cursor: pointer; font-size: 12px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.warn { background: var(--vscode-inputValidation-warningBackground, #9a6700); color: #fff; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.commit-hl:not(:disabled) { box-shadow: 0 0 0 1px var(--vscode-focusBorder), 0 0 8px var(--vscode-button-background); }
  input.filter { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 2px 8px; width: 180px; }
  .grid-wrap { overflow: auto; max-height: 60vh; }
  table { border-collapse: collapse; width: 100%; font-family: var(--vscode-editor-font-family); font-size: 12px; table-layout: fixed; }
  th { position: sticky; top: 0; background: var(--vscode-editorGroupHeader-tabsBackground); color: var(--vscode-foreground); text-align: left; padding: 4px 8px; border: 1px solid var(--vscode-panel-border); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td { padding: 4px 8px; border: 1px solid var(--vscode-panel-border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: default; }
  tr.new td { background: color-mix(in srgb, var(--vscode-testing-iconPassed) 18%, transparent); }
  tr.deleted td { background: color-mix(in srgb, var(--vscode-testing-iconFailed) 20%, transparent); text-decoration: line-through; opacity: 0.75; }
  td.mod { background: color-mix(in srgb, var(--vscode-editorGutter.modifiedBackground, #e2b93d) 35%, transparent); }
  td.err { background: color-mix(in srgb, var(--vscode-testing-iconFailed) 35%, transparent); }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  tr.sel td { background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 70%, transparent); }
  td input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-focusBorder); font: inherit; }
  .footer { display: flex; gap: 16px; padding: 4px 10px; color: var(--vscode-descriptionForeground); font-size: 11.5px; flex-wrap: wrap; }
  .pre { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); padding: 8px 12px; margin: 0; }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 9px; padding: 0 8px; font-size: 11px; }
  .errbar { background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, #5a1d1d) 80%, transparent); padding: 4px 10px; color: var(--vscode-errorForeground); }
</style></head>
<body>
<div class="tabs" id="tabs"></div>
<div id="view"></div>
<script nonce="${nonce}">
const S = ${stateLiteral};
const SUMMARY = ${JSON.stringify(summary)};
const vscode = acquireVsCodeApi();
let sortCol = -1, sortDesc = false, filterText = '';
let view = 'grid';
function esc(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function changed(){ return S.changesCount > 0; }
function render(){
  document.getElementById('tabs').innerHTML = [
    '<span class="tab '+(view==='grid'?'active':'')+'" onclick="setView(\\'grid\\')">结果集</span>',
    '<span class="tab '+(view==='script'?'active':'')+'" onclick="setView(\\'script\\')">脚本输出</span>',
    '<span class="tab '+(view==='out'?'active':'')+'" onclick="setView(\\'out\\')">DBMS_OUTPUT</span>',
  ].join('');
  const v = document.getElementById('view');
  if (view === 'grid') { v.innerHTML = gridHtml(); wire(); }
  else if (view === 'script') { v.innerHTML = '<pre class="pre">' + esc(S.scriptLog.join('\\n') || '(无脚本输出)') + '</pre>'; }
  else { v.innerHTML = '<pre class="pre">' + esc(S.dbmsOutput.join('\\n') || '(无输出)') + '</pre>'; }
}
function setView(x){ view = x; render(); }
function gridHtml(){
  const canEdit = S.editable;
  const btn = (label, msg, cls, extra) =>
    '<button ' + (extra||'') + ' class="'+cls+'" onclick="post(\\''+msg+'\\')">'+label+'</button>';
  let h = '<div class="toolbar">';
  h += '<input class="filter" placeholder="筛选已加载行…" oninput="filterText=this.value;render()">';
  h += '<span style="flex:1"></span>';
  if (canEdit) {
    h += btn('＋ 行', 'addRow', 'secondary');
    h += btn('－ 删行', 'deleteRows', 'secondary', 'id="btnDel"');
    h += btn('⌫ 撤销单元格', 'undoCell', 'secondary');
    h += '<button class="secondary" onclick="post(\\'preview\\')">👁 预览更改' + (changed() ? ' <span class="badge">'+S.changesCount+'</span>' : '') + '</button>';
    h += '<button id="btnCommit" class="commit-hl" ' + (changed()?'':'disabled') + ' onclick="post(\\'commit\\')">✓ 提交' + (changed() ? ' ('+S.changesCount+')' : '') + '</button>';
    h += '<button id="btnRollback" class="warn" ' + (changed()?'':'disabled') + ' onclick="post(\\'rollbackConfirm\\')">↩ 回滚</button>';
  } else if (S.readOnlyReason) {
    h += '<span style="color:var(--vscode-descriptionForeground)">🔒 ' + esc(S.readOnlyReason) + '</span>';
  }
  h += btn('⬇ 导出', 'export', 'secondary');
  h += '</div>';
  if (S.lastError) { h += '<div class="errbar">✗ ' + esc(S.lastError) + '</div>'; }
  h += '<div class="grid-wrap"><table><thead><tr><th style="width:28px"></th>';
  S.columns.forEach((c, i) => {
    h += '<th style="width:'+Math.floor(92/S.columns.length)+'%" title="'+esc(c.dataType)+'" onclick="sortBy('+i+')">' + esc(c.name) + (sortCol===i?(sortDesc?' ▼':' ▲'):'') + '</th>';
  });
  h += '</tr></thead><tbody>';
  let rows = S.rows.filter(r => !filterText || r.cells.some(c => c.v && c.v.toLowerCase().includes(filterText.toLowerCase())));
  if (sortCol >= 0) { rows = rows.slice().sort((a,b)=>{const x=a.cells[sortCol].v,y=b.cells[sortCol].v;const n=S.columns[sortCol].numeric? (parseFloat(x)||0)-(parseFloat(y)||0) : x.localeCompare(y);return sortDesc?-n:n;}); }
  rows.forEach((r) => {
    h += '<tr data-key="'+esc(r.key)+'" class="'+(r.isNew?'new ':'')+(r.deleted?'deleted':'')+'" onclick="toggleSel(\\''+esc(r.key)+'\\')">';
    h += '<td>'+(r.deleted?'✕':(r.selected?'▸':''))+'</td>';
    r.cells.forEach(c => {
      const cls = [c.state==='mod'?'mod':'', c.isNull?'null':''].join(' ');
      h += '<td class="'+cls+'" data-key="'+esc(r.key)+'" ondblclick="editCell(this,\\''+esc(r.key)+'\\','+r.cells.indexOf(c)+')" title="'+esc(c.v)+'">'+esc(c.isNull?S.nullText:c.v)+'</td>';
    });
    h += '</tr>';
  });
  h += '</tbody></table></div>';
  const dirty = S.changesCount>0 ? ' · <b>更改 '+S.changesCount+'（改'+ (changed() ? SUMMARY.updates : 0) +' 增'+(changed()?SUMMARY.inserts:0)+' 删'+(changed()?SUMMARY.deletes:0)+'）</b>' : '';
  h += '<div class="footer"><span>行 '+rows.length+' / 已加载 '+S.rows.length+(S.totalRows>S.rows.length?' / 共 '+S.totalRows:'')+(S.truncated?'（已截断，导出“全部行”可获取全量）':'')+'</span><span>'+S.durationMs+' ms</span>'+(dirty?'<span>'+dirty+'</span>':'')+'</div>';
  return h;
}
let editing = null;
function wire(){
  document.addEventListener('click', e => { if (editing && !editing.contains(e.target)) { applyEdit(false); } }, true);
}
function editCell(td, key, colIdx){
  if (!S.editable) { return; }
  if (editing) { applyEdit(false); }
  const row = S.rows.find(r => r.key === key);
  if (!row || row.isNew || row.deleted) { return; }
  const inp = document.createElement('input');
  inp.value = row.cells[colIdx].isNull ? 'NULL' : row.cells[colIdx].v;
  td.textContent = '';
  td.appendChild(inp);
  inp.focus(); inp.select();
  editing = { inp, key, colIdx };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { applyEdit(true); }
    if (e.key === 'Escape') { applyEdit(false); render(); }
  };
}
function applyEdit(confirm){
  if (!editing) { return; }
  const { inp, key, colIdx } = editing;
  const val = inp.value;
  editing = null;
  if (!confirm) { return; }
  const col = S.columns[colIdx];
  const isNull = /^null$/i.test(val.trim());
  if (!isNull && col.numeric && val.trim() !== '' && isNaN(Number(val.trim()))) {
    vscode.postMessage({ type: 'cellEditError', key, colIdx, message: '类型错误：'+col.name+' 为 '+col.dataType+'，输入“'+val+'”不是数字' });
    return;
  }
  vscode.postMessage({ type: 'cellEdit', key, colIdx, value: isNull ? null : (col.numeric ? Number(val.trim()) : val) });
}
function toggleSel(key){
  const r = S.rows.find(x => x.key === key);
  if (r) { r.selected = !r.selected; render(); }
}
function sortBy(i){ if (sortCol === i) { sortDesc = !sortDesc; } else { sortCol = i; sortDesc = false; } render(); }
function post(t, extra){ vscode.postMessage(Object.assign({ type: t }, extra||{})); }
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') { Object.assign(S, m.state); render(); }
});
render();
</script>
</body></html>`;
  }

  private async onMessage(m: { type: string; key?: string; colIdx?: number; value?: unknown; message?: string }): Promise<void> {
    const session = this.sessions.get(this.sessionId);
    if (!session) {
      vscode.window.showErrorMessage('SQLAdmin: 会话已关闭');
      return;
    }
    const cs = this.sessions.changeset(this.sessionId, this.key);
    const ctx = this.resultContext;
    switch (m.type) {
      case 'cellEdit': {
        if (!ctx || !m.key || m.colIdx === undefined) { return; }
        const row = this.state.rows.find((r) => r.key === m.key);
        if (!row) { return; }
        const colName = this.state.columns[m.colIdx]?.name;
        if (!colName) { return; }
        if (row.isNew) {
          // 新行：值并入对应 INSERT 变更
          this.pendingNewRows ??= new Map();
          const vals = this.pendingNewRows.get(m.key) ?? {};
          vals[colName] = m.value;
          this.pendingNewRows.set(m.key, vals);
          row.cells[m.colIdx] = { v: m.value === null ? '' : String(m.value), state: 'normal', isNull: m.value === null };
          this.pushState();
          return;
        }
        const oldRaw = this.originalRows.get(m.key)?.[m.colIdx + 1]; // [0] 为 __ROWID__
        const oldVal = parseOld(oldRaw, this.state.columns[m.colIdx].numeric);
        cs.addUpdate(ctx.schema, ctx.table, m.key, colName, oldVal, m.value);
        row.cells[m.colIdx] = { v: m.value === null ? '' : String(m.value), state: 'mod', isNull: m.value === null };
        this.pushState();
        break;
      }
      case 'cellEditError':
        vscode.window.showErrorMessage(`SQLAdmin: ${m.message ?? '类型校验失败'}`);
        break;
      case 'addRow': {
        if (!ctx) { return; }
        const key = `NEW-${this.nextNewKey++}`;
        const cells = this.state.columns.map((c) => ({ v: '', state: 'normal' as const, isNull: true }));
        this.state.rows.push({ key, isNew: true, deleted: false, cells, selected: false });
        const values: Record<string, unknown> = {};
        this.state.columns.forEach((c) => { values[c.name] = null; });
        cs.addInsertWithKey(ctx.schema, ctx.table, key, values);
        // 新行的值在提交前由 cellEditOnNew 更新
        this.pendingNewRows = this.pendingNewRows ?? new Map();
        this.pendingNewRows.set(key, values);
        this.pushState();
        break;
      }
      case 'deleteRows': {
        if (!ctx) { return; }
        const targets = this.state.rows.filter((r) => r.selected && !r.deleted);
        if (targets.length === 0) { vscode.window.showInformationMessage('SQLAdmin: 请先点击选中要删除的行'); return; }
        for (const r of targets) {
          r.deleted = true;
          if (r.isNew) {
            // 删除待提交的新增行 ⇒ 撤销对应 INSERT 变更并移除本地行
            cs.addDelete(ctx.schema, ctx.table, r.key);
            this.pendingNewRows?.delete(r.key);
            this.state.rows = this.state.rows.filter((x) => x.key !== r.key);
          } else {
            cs.addDelete(ctx.schema, ctx.table, r.key);
          }
        }
        this.pushState();
        break;
      }
      case 'undoCell': {
        const sel = this.state.rows.find((r) => r.selected);
        if (!sel) { vscode.window.showInformationMessage('SQLAdmin: 请先选中包含已修改单元格的行'); return; }
        cs.undoCell(sel.key);
        const orig = this.originalRows.get(sel.key);
        if (orig) {
          sel.cells = orig
            .filter((_, i) => i !== 0)
            .map((v, i) => ({ v: v === nullishSentinel ? '' : v, state: 'normal' as const, isNull: v === nullishSentinel }));
        }
        this.pushState();
        break;
      }
      case 'preview': {
        const doc = await vscode.workspace.openTextDocument({ language: 'sqladmin-sql', content: generateChangesetPreview([...cs.all]) });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        break;
      }
      case 'commit': {
        if (cs.isEmpty) { return; }
        // 新行的值合并进 INSERT 变更
        this.mergeNewRowValues(cs);
        const summary = cs.summary();
        const pick = await vscode.window.showWarningMessage(
          `提交 ${cs.size} 项更改（UPDATE ${summary.updates} + INSERT ${summary.inserts} + DELETE ${summary.deletes}）并 COMMIT？`,
          { modal: true },
          '提交',
        );
        if (pick !== '提交') { return; }
        const r = await this.sessions.commit(this.sessionId);
        if (r.ok) {
          vscode.window.showInformationMessage(`SQLAdmin: ${r.message}`);
          await this.reloadAndReshow();
        } else {
          vscode.window.showErrorMessage(`SQLAdmin: ${r.message}`);
          this.pushState();
        }
        break;
      }
      case 'rollbackConfirm': {
        if (cs.isEmpty) { return; }
        const pick = await vscode.window.showWarningMessage(
          `回滚并丢弃全部 ${cs.size} 项未提交更改？`,
          { modal: true },
          '回滚',
        );
        if (pick !== '回滚') { return; }
        const r = await this.sessions.rollback(this.sessionId);
        vscode.window[r.ok ? 'showInformationMessage' : 'showErrorMessage'](`SQLAdmin: ${r.message}`);
        await this.reloadAndReshow();
        break;
      }
      case 'export':
        await this.exportFlow(session);
        break;
      case 'refresh':
        await this.reloadAndReshow();
        break;
    }
  }

  private pendingNewRows: Map<string, Record<string, unknown>> | undefined;

  /** 新行单元格编辑目前经由 cellEdit 到达（key 为 NEW-*），把值写入 INSERT 变更 */
  private mergeNewRowValues(cs: ReturnType<SessionManager['changeset']>): void {
    if (!this.pendingNewRows) { return; }
    for (const [key, values] of this.pendingNewRows) {
      const ins = [...cs.all].find(
        (c) => c.kind === 'insert' && (c as unknown as { __rowKey?: string }).__rowKey === key,
      ) as Extract<import('../driver/types').RowChange, { kind: 'insert' }> & { __rowKey?: string } | undefined;
      if (ins) { ins.values = { ...values }; }
    }
  }

  private async reloadAndReshow(): Promise<void> {
    this.pendingNewRows?.clear();
    this.nextNewKey = 1;
    const res = await this.reload();
    this.setStateFromResult(res, res ? [res] : [], []);
  }

  private async exportFlow(session: SessionInfo): Promise<void> {
    const fmtPick = await vscode.window.showQuickPick(
      [
        { label: 'CSV', value: 'csv' }, { label: 'XLSX (Excel)', value: 'xlsx' },
        { label: 'JSON', value: 'json' }, { label: 'INSERT 语句', value: 'insert' }, { label: 'HTML 报表', value: 'html' },
      ].map((x) => ({ label: x.label, description: x.value })),
      { placeHolder: '选择导出格式' },
    );
    if (!fmtPick) { return; }
    const format = (fmtPick.description ?? 'csv') as ExportFormat;
    const rangePick = await vscode.window.showQuickPick(
      [
        { label: '全部行（流式重查）', value: 'all' },
        { label: `已加载的 ${this.state.rows.length} 行`, value: 'loaded' },
      ],
      { placeHolder: '导出范围' },
    );
    if (!rangePick) { return; }
    const defaultName = `${(this.resultContext?.table ?? 'result').toLowerCase()}_${new Date().toISOString().slice(0, 10)}.${extOf(format)}`;
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(require('os').homedir(), defaultName)) });
    if (!target) { return; }
    const columns = this.state.columns.map((c) => c.name);
    const opts = { ...defaultExportOptions };
    const writer = createWriter(format, target.fsPath, opts, columns, this.resultContext ? `${this.resultContext.schema ? this.resultContext.schema + '.' : ''}${this.resultContext.table}` : undefined);
    await writer.writeHeader(columns);
    try {
      if (rangePick.value === 'loaded') {
        for (const r of this.state.rows.filter((x) => !x.isNew && !x.deleted)) {
          await writer.writeRow(r.cells.map((c, i) => (c.isNull ? null : (this.state.columns[i]?.numeric ? Number(c.v || 0) || null : c.v))));
        }
      } else {
        const sql = this.lastSql;
        if (!sql) { vscode.window.showErrorMessage('SQLAdmin: 无法重查（原始语句不可用）'); return; }
        const batch: number = vscode.workspace.getConfiguration('sqladmin').get('export.batchSize') ?? 5000;
        await session.driver.executeStream(sql, {}, batch, async (rows) => {
          for (const row of rows) { await writer.writeRow(row); }
        });
      }
      const n = await writer.close();
      const open = '打开所在位置';
      const pick = await vscode.window.showInformationMessage(`SQLAdmin: 已导出 ${n} 行 → ${path.basename(target.fsPath)}`, open);
      if (pick === open) { vscode.commands.executeCommand('revealFileInOS', target); }
    } catch (e) {
      await writer.close().catch(() => undefined);
      vscode.window.showErrorMessage(`SQLAdmin: 导出失败 ${String(e)}`);
    }
  }

  private lastSql: string | undefined;

  setReloadContext(reload: () => Promise<QueryResult | undefined>, lastSql: string): void {
    this.reload = reload;
    this.lastSql = lastSql;
  }

  private pushState(): void {
    const cs = this.safeChangeset();
    this.state.changesCount = cs?.size ?? 0;
    // 仅推送状态增量：webview 内部重渲染，避免整页重建导致排序/筛选/滚动丢失
    this.panel.webview.postMessage({ type: 'state', state: { rows: this.state.rows, changesCount: this.state.changesCount, lastError: this.state.lastError } });
  }
}

const nullishSentinel = '__SQLADMIN_NULL__';

function stringify(v: unknown, nullText: string): string {
  if (v === null || v === undefined) { return nullishSentinel; }
  if (v instanceof Date) {
    const p = (x: number) => String(x).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  return String(v);
}

function parseOld(raw: string | undefined, numeric: boolean): unknown {
  if (raw === undefined || raw === nullishSentinel) { return null; }
  if (numeric) { const n = Number(raw); return Number.isNaN(n) ? raw : n; }
  return raw;
}

function extOf(format: ExportFormat): string {
  return format === 'xlsx' ? 'xlsx' : format === 'insert' ? 'sql' : format;
}
