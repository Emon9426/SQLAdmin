/**
 * DDL 只读视图（F5-04）：sqladmin-ddl: scheme + TextDocumentContentProvider，
 * 复用编辑器 SQL 高亮。
 */
import * as vscode from 'vscode';
import { DbObjectRef } from '../driver/types';
import { SessionManager } from '../sessions/sessionManager';

export const DDL_SCHEME = 'sqladmin-ddl';

export function ddlUri(sessionId: string, ref: DbObjectRef): vscode.Uri {
  return vscode.Uri.parse(`${DDL_SCHEME}://${encodeURIComponent(sessionId)}/${encodeURIComponent(ref.schema)}/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.name)}.sql?raw=1`);
}

export function parseDdlUri(uri: vscode.Uri): { sessionId: string; ref: DbObjectRef } | undefined {
  if (uri.scheme !== DDL_SCHEME) { return undefined; }
  // sessionId 位于 authority；path 段为 schema/type/name
  const sessionId = decodeURIComponent(uri.authority);
  const parts = uri.path.split('/').filter((p) => p.length > 0).map((p) => decodeURIComponent(p));
  const [schema, type, name] = parts;
  if (!sessionId || !schema || !type || !name) { return undefined; }
  return { sessionId, ref: { schema, type: type as DbObjectRef['type'], name: name.replace(/\.sql$/, '') } };
}

export class DdlContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private sessions: SessionManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parsed = parseDdlUri(uri);
    if (!parsed) { return '-- 无效的 DDL URI'; }
    const session = this.sessions.get(parsed.sessionId);
    if (!session) { return '-- 会话已关闭'; }
    try {
      const ddl = await session.driver.getDdl(parsed.ref);
      return `-- ${parsed.ref.schema}.${parsed.ref.name} (${parsed.ref.type})\n-- 来源: DBMS_METADATA.GET_DDL / 驱动 ${session.driver.capabilities.dialect}\n\n${ddl.trim()}\n`;
    } catch (e) {
      return `-- 获取 DDL 失败: ${String(e)}\n`;
    }
  }
}
