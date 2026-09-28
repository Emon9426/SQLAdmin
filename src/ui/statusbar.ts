/**
 * 状态栏（F8-01）：连接·Schema / 事务徽标（仅变更集非空时显示，F3-09）/ 驱动模式。
 */
import * as vscode from 'vscode';
import { SessionManager } from '../sessions/sessionManager';

export class StatusBar {
  private connItem: vscode.StatusBarItem;
  private txnItem: vscode.StatusBarItem;
  private modeItem: vscode.StatusBarItem;

  constructor(private sessions: SessionManager) {
    this.connItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 300);
    this.connItem.name = 'SQLAdmin 连接';
    this.connItem.command = 'sqladmin.newWorksheet';
    this.txnItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 299);
    this.txnItem.name = 'SQLAdmin 事务';
    this.txnItem.command = 'sqladmin.previewChanges';
    this.txnItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.modeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 298);
    this.modeItem.name = 'SQLAdmin 驱动模式';
    sessions.onDidChange(() => this.update());
    this.update();
  }

  update(): void {
    const all = this.sessions.all();
    if (all.length === 0) {
      this.connItem.text = '$(database) SQLAdmin';
      this.connItem.tooltip = '点击新建工作台并选择连接';
      this.connItem.show();
      this.txnItem.hide();
      this.modeItem.hide();
      return;
    }
    const names = all.map((s) => `${s.connectionName} · ${s.driver.currentSchema}`);
    const first = all[0];
    this.connItem.text = `$(database) ${all.length === 1 ? names[0] : `${all.length} 个会话`}`;
    this.connItem.tooltip = new vscode.MarkdownString(names.join('  \n'));
    this.connItem.show();

    const pending = all.reduce((n, s) => n + this.sessions.totalPending(s), 0);
    if (pending > 0) {
      this.txnItem.text = `$(arrow-swap) 未提交 ${pending} 项更改`;
      this.txnItem.tooltip = '存在待提交更改：点击预览；提交=Ctrl+Alt+C，回滚=Ctrl+Alt+R';
      this.txnItem.show();
    } else {
      this.txnItem.hide();
    }
    this.modeItem.text = first.driver.capabilities.dialect;
    this.modeItem.tooltip = `驱动方言: ${first.driver.capabilities.dialect}`;
    this.modeItem.show();
  }

  dispose(): void {
    this.connItem.dispose(); this.txnItem.dispose(); this.modeItem.dispose();
  }
}
