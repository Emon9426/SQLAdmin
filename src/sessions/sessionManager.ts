/**
 * 会话管理器：每个工作台/数据网格绑定一个数据库会话（独立事务）。
 * 提交/回滚统一收口；连接错误或断开且有未提交更改时默认回滚（F3-09）。
 */
import * as vscode from 'vscode';
import { ConnectionConfig, IDbDriver, RowChange } from '../driver/types';
import { createDriver } from '../driver/registry';
import { Changeset } from '../core/changeset';
import { ConnectionStore } from '../ui/connectionStore';

export interface SessionInfo {
  id: string;
  connectionId: string;
  connectionName: string;
  driver: IDbDriver;
  /** 每个结果面板一份变更集（key = panelId） */
  changesets: Map<string, Changeset>;
  busy: boolean;
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private nextId = 1;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  /** 断开且丢弃更改时通知（右下角默认回滚通知，F3-09） */
  private readonly _onSessionLost = new vscode.EventEmitter<{ session: SessionInfo; reason: string }>();
  readonly onSessionLost = this._onSessionLost.event;

  constructor(private store: ConnectionStore) {}

  async openSession(cfg: ConnectionConfig): Promise<SessionInfo> {
    const password = cfg.savePassword ? await this.store.getPassword(cfg.id) : undefined;
    const driver = createDriver(cfg);
    await driver.connect(password ?? cfg.password);
    const info: SessionInfo = {
      id: `s${this.nextId++}`,
      connectionId: cfg.id,
      connectionName: cfg.name,
      driver,
      changesets: new Map(),
      busy: false,
    };
    this.sessions.set(info.id, info);
    this.fire();
    return info;
  }

  async closeSession(id: string, opts: { silentRollback?: boolean } = {}): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) { return; }
    const pending = this.totalPending(s);
    try {
      if (pending > 0) {
        // F3-09：断开时默认回滚（服务端会话终止同样自动回滚未提交事务）
        await s.driver.rollback().catch(() => undefined);
        if (!opts.silentRollback) {
          vscode.window.showWarningMessage(
            `连接 ${s.connectionName} 断开：${pending} 项未提交更改已按默认策略回滚（ROLLBACK）丢弃。`,
          );
        }
      }
    } finally {
      s.changesets.clear();
      await s.driver.close().catch(() => undefined);
      this.sessions.delete(id);
      this.fire();
    }
  }

  get(id: string): SessionInfo | undefined { return this.sessions.get(id); }

  all(): SessionInfo[] { return [...this.sessions.values()]; }

  sessionsOfConnection(connectionId: string): SessionInfo[] {
    return this.all().filter((s) => s.connectionId === connectionId);
  }

  /** 活动会话：优先当前工作台映射，否则唯一会话 */
  active(editorKey: string | undefined): SessionInfo | undefined {
    if (editorKey) {
      const s = this.all().find((x) => (x as SessionInfo & { editorKey?: string }).editorKey === editorKey);
      if (s) { return s; }
    }
    if (this.sessions.size === 1) { return this.all()[0]; }
    return undefined;
  }

  bindEditor(sessionId: string, editorKey: string): void {
    const s = this.sessions.get(sessionId);
    if (s) { (s as SessionInfo & { editorKey?: string }).editorKey = editorKey; }
  }

  changeset(sessionId: string, panelId: string): Changeset {
    const s = this.sessions.get(sessionId);
    if (!s) { throw new Error('会话不存在'); }
    let cs = s.changesets.get(panelId);
    if (!cs) { cs = new Changeset(); s.changesets.set(panelId, cs); }
    return cs;
  }

  totalPending(s: SessionInfo): number {
    let n = 0;
    for (const cs of s.changesets.values()) { n += cs.size; }
    return n;
  }

  /** 提交：变更集为空时不可用（F3-09 按钮 enable 规则） */
  async commit(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const s = this.sessions.get(sessionId);
    if (!s) { return { ok: false, message: '会话不存在' }; }
    const pending = this.totalPending(s);
    if (pending === 0) {
      return { ok: false, message: '无未提交更改（提交/回滚仅在存在数据变更时可用）' };
    }
    s.busy = true;
    this.fire();
    try {
      let applied = 0;
      const errors: string[] = [];
      for (const cs of s.changesets.values()) {
        if (cs.isEmpty) { continue; }
        const r = await s.driver.applyChangeset([...cs.all]);
        applied += r.applied;
        errors.push(...r.errors);
      }
      if (errors.length > 0) {
        await s.driver.rollback().catch(() => undefined);
        for (const cs of s.changesets.values()) { /* 保留变更集供修正 */ }
        return { ok: false, message: `提交失败（已整体回滚）：${errors[0]}${errors.length > 1 ? ` 等 ${errors.length} 项错误` : ''}` };
      }
      await s.driver.commit();
      for (const cs of s.changesets.values()) { cs.clear(); }
      this.fire();
      return { ok: true, message: `已提交 ${applied} 项更改 (COMMIT)` };
    } catch (e) {
      await s.driver.rollback().catch(() => undefined);
      return { ok: false, message: `提交失败（已回滚）：${String(e)}` };
    } finally {
      s.busy = false;
      this.fire();
    }
  }

  /** 回滚：丢弃全部未提交更改（需上层二次确认） */
  async rollback(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const s = this.sessions.get(sessionId);
    if (!s) { return { ok: false, message: '会话不存在' }; }
    if (this.totalPending(s) === 0) {
      return { ok: false, message: '无未提交更改' };
    }
    try {
      await s.driver.rollback();
      for (const cs of s.changesets.values()) { cs.clear(); }
      this.fire();
      return { ok: true, message: '已回滚（ROLLBACK），全部未提交更改已丢弃' };
    } catch (e) {
      return { ok: false, message: `回滚失败：${String(e)}` };
    }
  }

  /** 连接异常（执行/操作抛错）处理：有未提交更改 → 默认回滚并通知 */
  async handleConnectionError(sessionId: string, reason: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) { return; }
    const pending = this.totalPending(s);
    this._onSessionLost.fire({ session: s, reason });
    if (pending > 0) {
      await this.closeSession(sessionId); // closeSession 内含默认回滚 + 通知
    } else {
      await this.closeSession(sessionId, { silentRollback: true });
    }
  }

  /** 汇总各会话变更（预览/树展示用） */
  allChanges(): Array<{ session: SessionInfo; changes: RowChange[] }> {
    return this.all().map((s) => ({
      session: s,
      changes: [...s.changesets.values()].flatMap((cs) => [...cs.all]),
    })).filter((x) => x.changes.length > 0);
  }

  private fire(): void { this._onDidChange.fire(); }
}
