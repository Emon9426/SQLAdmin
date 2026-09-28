/**
 * 连接树 + 对象树（F1-04 / F5-01..02）：连接 → Schema → 对象类型 → 对象。
 * 懒加载；对象节点点击打开（表→数据，代码对象→DDL/源码）。
 */
import * as vscode from 'vscode';
import { ConnectionConfig, OBJECT_TYPES, ObjectType, DbObjectRef } from '../driver/types';
import { ConnectionStore } from './connectionStore';
import { SessionManager } from '../sessions/sessionManager';

export type TreeNode =
  | { kind: 'connection'; cfg: ConnectionConfig; connected: boolean }
  | { kind: 'schema'; connectionId: string; schema: string }
  | { kind: 'type'; connectionId: string; schema: string; objectType: ObjectType }
  | { kind: 'object'; connectionId: string; ref: DbObjectRef }
  | { kind: 'info'; label: string };

const TYPE_ICONS: Record<string, string> = {
  TABLE: 'table', VIEW: 'eye', 'MATERIALIZED VIEW': 'eye-closed', SEQUENCE: 'list-ordered',
  PROCEDURE: 'symbol-method', FUNCTION: 'symbol-function', PACKAGE: 'package',
  TRIGGER: 'zap', SYNONYM: 'link', TYPE: 'symbol-class', JOB: 'clock', 'DB LINK': 'globe',
};

const TYPE_LABELS: Record<string, string> = {
  TABLE: '表', VIEW: '视图', 'MATERIALIZED VIEW': '物化视图', SEQUENCE: '序列',
  PROCEDURE: '存储过程', FUNCTION: '函数', PACKAGE: '包', TRIGGER: '触发器',
  SYNONYM: '同义词', TYPE: '类型', JOB: '作业', 'DB LINK': '数据库链接',
};

export class ConnectionsTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTree = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTree.event;

  constructor(private store: ConnectionStore, private sessions: SessionManager) {
    sessions.onDidChange(() => this.refresh());
  }

  refresh(): void { this._onDidChangeTree.fire(); }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'connection') {
      const item = new vscode.TreeItem(element.cfg.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'connection';
      item.iconPath = new vscode.ThemeIcon('database', element.connected
        ? new vscode.ThemeColor('testing.iconPassed')
        : new vscode.ThemeColor('descriptionForeground'));
      item.description = element.connected
        ? `${(this.sessions.sessionsOfConnection(element.cfg.id)[0]?.driver.currentSchema ?? '')} ●`
        : (element.cfg.type === 'mock' ? '演示' : '');
      item.tooltip = `${element.cfg.type.toUpperCase()} · ${element.cfg.mode}${element.cfg.readOnly ? ' · 只读 🔒' : ''}`;
      item.command = { command: 'sqladmin.connect', title: '连接', arguments: [element] };
      return item;
    }
    if (element.kind === 'schema') {
      const item = new vscode.TreeItem(element.schema, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'schema';
      item.iconPath = new vscode.ThemeIcon('folder-library');
      return item;
    }
    if (element.kind === 'type') {
      const item = new vscode.TreeItem(TYPE_LABELS[element.objectType] ?? element.objectType, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'type';
      item.iconPath = new vscode.ThemeIcon(TYPE_ICONS[element.objectType] ?? 'circle-outline');
      item.description = element.objectType;
      return item;
    }
    if (element.kind === 'object') {
      const isTable = element.ref.type === 'TABLE';
      const item = new vscode.TreeItem(element.ref.name, vscode.TreeItemCollapsibleState.None);
      item.contextValue = `object${isTable ? '.table' : ''}`;
      item.iconPath = new vscode.ThemeIcon(TYPE_ICONS[element.ref.type] ?? 'circle-outline');
      item.tooltip = `${element.ref.schema}.${element.ref.name} (${element.ref.type})`;
      item.command = {
        command: isTable ? 'sqladmin.openTableData' : 'sqladmin.viewDdl',
        title: isTable ? '查看表数据' : '查看 DDL',
        arguments: [element],
      };
      return item;
    }
    return new vscode.TreeItem(element.label);
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      const conns = await this.store.list();
      if (conns.length === 0) { return []; }
      return conns.map((cfg) => ({
        kind: 'connection' as const, cfg, connected: this.sessions.sessionsOfConnection(cfg.id).length > 0,
      }));
    }
    if (element.kind === 'connection') {
      const session = this.sessions.sessionsOfConnection(element.cfg.id)[0];
      if (!session) { return [{ kind: 'info', label: '未连接（点击连接名称登录）' }]; }
      try {
        const schemas = await session.driver.listSchemas();
        return schemas.map((s) => ({ kind: 'schema' as const, connectionId: element.cfg.id, schema: s }));
      } catch (e) {
        return [{ kind: 'info', label: `加载失败: ${String(e)}` }];
      }
    }
    if (element.kind === 'schema') {
      return OBJECT_TYPES.map((t) => ({ kind: 'type' as const, connectionId: element.connectionId, schema: element.schema, objectType: t }));
    }
    if (element.kind === 'type') {
      const session = this.sessions.sessionsOfConnection(element.connectionId)[0];
      if (!session) { return [{ kind: 'info', label: '会话已断开' }]; }
      try {
        const objs = await session.driver.listObjects(element.schema, element.objectType);
        if (objs.length === 0) { return [{ kind: 'info', label: '（无）' }]; }
        return objs.map((ref) => ({ kind: 'object' as const, connectionId: element.connectionId, ref }));
      } catch (e) {
        return [{ kind: 'info', label: `加载失败: ${String(e)}` }];
      }
    }
    return [];
  }
}
