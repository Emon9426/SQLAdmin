/**
 * 连接存储（F1-01..05）：
 * - 连接元数据（不含密码）→ context.globalState；
 * - 密码 → context.secrets（SecretStorage，永不明文落盘，F1-03）。
 */
import * as vscode from 'vscode';
import { ConnectionConfig, newConnectionConfig } from '../driver/types';

const STATE_KEY = 'sqladmin.connections';
const secretKey = (id: string) => `sqladmin.conn.${id}`;

export class ConnectionStore {
  constructor(private context: vscode.ExtensionContext) {}

  async list(): Promise<ConnectionConfig[]> {
    const raw = this.context.globalState.get<ConnectionConfig[]>(STATE_KEY) ?? [];
    return raw.map((c) => newConnectionConfig(c));
  }

  async save(cfg: ConnectionConfig, password?: string): Promise<void> {
    const all = await this.list();
    const idx = all.findIndex((c) => c.id === cfg.id);
    const toPersist: ConnectionConfig = { ...cfg, password: undefined };
    if (idx >= 0) { all[idx] = toPersist; } else { all.push(toPersist); }
    await this.context.globalState.update(STATE_KEY, all);
    if (cfg.savePassword) {
      const pwd = password ?? cfg.password;
      if (pwd !== undefined) {
        await this.context.secrets.store(secretKey(cfg.id), pwd);
      }
    } else {
      await this.context.secrets.delete(secretKey(cfg.id));
    }
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.context.secrets.get(secretKey(id));
  }

  async remove(id: string): Promise<void> {
    const all = (await this.list()).filter((c) => c.id !== id);
    await this.context.globalState.update(STATE_KEY, all);
    await this.context.secrets.delete(secretKey(id));
  }

  async get(id: string): Promise<ConnectionConfig | undefined> {
    return (await this.list()).find((c) => c.id === id);
  }

  /** 导出脱敏配置（F1-09 / F1-03） */
  async exportSanitized(): Promise<string> {
    const all = await this.list();
    return JSON.stringify(
      all.map(({ password: _p, ...rest }) => ({ ...rest, password: undefined })),
      null,
      2,
    );
  }
}
