/**
 * 变更集（待提交更改）管理（需求 F3-05..09）。
 * 所有网格编辑先进入变更集；提交时统一生成绑定变量 DML 执行；
 * 预览时生成带前后值注释的 SQL。
 */
import { RowChange, ChangesetSummary, summarizeChanges } from '../driver/types';

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function previewValue(v: unknown): string {
  if (v === null || v === undefined) { return 'NULL'; }
  if (typeof v === 'number') { return String(v); }
  const s = String(v);
  if (s.length > 40) { return `'${s.slice(0, 37)}...'`; }
  return `'${s}'`;
}

/** 生成某条变更的预览 SQL（带注释），用于「预览更改」与提交确认 */
export function generatePreviewSql(change: RowChange): string {
  const table = change.schema ? `${quoteIdent(change.schema)}.${quoteIdent(change.table)}` : quoteIdent(change.table);
  if (change.kind === 'update') {
    const cols = Object.keys(change.changes);
    if (cols.length === 0) { return `-- 空更新（无字段变化）: ${table} ROWID=${change.rowId}`; }
    const sets = cols.map((c, i) => {
      const { old, new: nv } = change.changes[c];
      return `${quoteIdent(c)} = :b${i + 1}  /* ${previewValue(old)} -> ${previewValue(nv)} */`;
    });
    return `UPDATE ${table}\n   SET ${sets.join(',\n       ')}\n WHERE ROWID = :rowid;`;
  }
  if (change.kind === 'insert') {
    const cols = Object.keys(change.values);
    const binds = cols.map((c, i) => `:i${i + 1}`).join(', ');
    return `INSERT INTO ${table} (${cols.map(quoteIdent).join(', ')})\nVALUES (${binds});`;
  }
  return `DELETE FROM ${table}\n WHERE ROWID = :rowid;`;
}

/** 变更集整体预览 */
export function generateChangesetPreview(changes: readonly RowChange[]): string {
  if (changes.length === 0) { return '-- 无待提交更改'; }
  const s = summarizeChanges(changes);
  const head = `-- 待提交更改：${changes.length} 项（UPDATE ${s.updates} / INSERT ${s.inserts} / DELETE ${s.deletes}）\n-- 将在同一事务内执行，任一失败整体回滚\n`;
  return head + changes.map((c) => generatePreviewSql(c)).join('\n');
}

/** 生成驱动执行的 DML + 绑定变量 */
export interface GeneratedDml { sql: string; binds: Record<string, unknown> }

export function generateDml(change: RowChange): GeneratedDml {
  const table = change.schema ? `${quoteIdent(change.schema)}.${quoteIdent(change.table)}` : quoteIdent(change.table);
  if (change.kind === 'update') {
    const cols = Object.keys(change.changes);
    const binds: Record<string, unknown> = { rowid: change.rowId };
    const sets = cols.map((c, i) => {
      binds[`b${i + 1}`] = change.changes[c].new;
      return `${quoteIdent(c)} = :b${i + 1}`;
    });
    return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE ROWID = :rowid`, binds };
  }
  if (change.kind === 'insert') {
    const cols = Object.keys(change.values);
    const binds: Record<string, unknown> = {};
    const holders = cols.map((c, i) => {
      binds[`i${i + 1}`] = change.values[c];
      return `:i${i + 1}`;
    });
    return { sql: `INSERT INTO ${table} (${cols.map(quoteIdent).join(', ')}) VALUES (${holders.join(', ')})`, binds };
  }
  return { sql: `DELETE FROM ${table} WHERE ROWID = :rowid`, binds: { rowid: change.rowId } };
}

/** 变更集容器：UI 持有，提交/回滚收口 */
export class Changeset {
  private changes: RowChange[] = [];

  addUpdate(schema: string | undefined, table: string, rowId: string, column: string, oldVal: unknown, newVal: unknown): void {
    const existing = this.changes.find(
      (c) => c.kind === 'update' && c.rowId === rowId,
    ) as Extract<RowChange, { kind: 'update' }> | undefined;
    if (existing) {
      existing.changes[column] = { old: oldVal, new: newVal };
    } else {
      this.changes.push({ kind: 'update', rowId, table, schema, changes: { [column]: { old: oldVal, new: newVal } } });
    }
  }

  addInsert(schema: string | undefined, table: string, values: Record<string, unknown>): void {
    this.changes.push({ kind: 'insert', table, schema, values });
  }

  addDelete(schema: string | undefined, table: string, rowId: string): void {
    // 同一行的待提交 INSERT 被删除 ⇒ 直接移除该 INSERT
    const idx = this.changes.findIndex(
      (c) => c.kind === 'insert' && (c as { __rowKey?: string }).__rowKey === rowId,
    );
    if (idx >= 0 && this.changes[idx].kind === 'insert') {
      const ins = this.changes[idx] as Extract<RowChange, { kind: 'insert' }> & { __rowKey?: string };
      if (ins.__rowKey === rowId) { this.changes.splice(idx, 1); return; }
    }
    // 已有该行的 UPDATE 先移除（删除优先）
    this.changes = this.changes.filter((c) => !(c.kind === 'update' && c.rowId === rowId));
    if (!this.changes.some((c) => c.kind === 'delete' && c.rowId === rowId)) {
      this.changes.push({ kind: 'delete', rowId, table, schema });
    }
  }

  /** 新增行需要带临时 key 以便删除时回收 */
  addInsertWithKey(schema: string | undefined, table: string, rowId: string, values: Record<string, unknown>): void {
    const c = { kind: 'insert', table, schema, values } as Extract<RowChange, { kind: 'insert' }>;
    (c as { __rowKey?: string }).__rowKey = rowId;
    this.changes.push(c);
  }

  undoCell(rowId: string, column?: string): void {
    if (column === undefined) {
      this.changes = this.changes.filter((c) => !(c.kind === 'update' && c.rowId === rowId));
      return;
    }
    const idx = this.changes.findIndex((c) => c.kind === 'update' && c.rowId === rowId);
    if (idx >= 0 && this.changes[idx].kind === 'update') {
      const upd = this.changes[idx] as Extract<RowChange, { kind: 'update' }>;
      delete upd.changes[column];
      if (Object.keys(upd.changes).length === 0) { this.changes.splice(idx, 1); }
    }
  }

  get all(): readonly RowChange[] { return this.changes; }
  get size(): number { return this.changes.length; }
  get isEmpty(): boolean { return this.changes.length === 0; }
  summary(): ChangesetSummary { return summarizeChanges(this.changes); }
  clear(): void { this.changes = []; }
  preview(): string { return generateChangesetPreview(this.changes); }
  /** 供 UI 徽标/按钮状态（F3-09：空=置灰） */
  get isEmptyForUi(): boolean { return this.changes.length === 0; }
}
