/**
 * SQL/PLSQL 补全（F2-10）与格式化（F2-11）。
 * 补全：关键字 + 活动会话的表/列元数据（内存缓存）。
 */
import * as vscode from 'vscode';
import { formatSql } from '../core/format';
import { SessionManager } from '../sessions/sessionManager';
import { ColumnMeta, OBJECT_TYPES, ObjectType } from '../driver/types';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN',
  'INNER JOIN', 'FULL JOIN', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL', 'IN',
  'EXISTS', 'BETWEEN', 'LIKE', 'AS', 'DISTINCT', 'UNION', 'UNION ALL', 'MINUS', 'INTERSECT',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'MERGE INTO', 'COMMIT', 'ROLLBACK',
  'CREATE TABLE', 'CREATE OR REPLACE PROCEDURE', 'CREATE OR REPLACE FUNCTION',
  'CREATE OR REPLACE PACKAGE', 'CREATE OR REPLACE TRIGGER', 'CREATE VIEW', 'CREATE SEQUENCE',
  'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE', 'BEGIN', 'END', 'IF', 'ELSIF', 'ELSE',
  'LOOP', 'WHILE', 'FOR', 'EXIT WHEN', 'RETURN', 'CASE WHEN', 'THEN', 'DECLARE', 'EXCEPTION',
  'WHEN OTHERS THEN', 'DBMS_OUTPUT.PUT_LINE', 'ROWNUM', 'SYSDATE', 'ROWID', 'CURRVAL', 'NEXTVAL',
];

export class CompletionProvider implements vscode.CompletionItemProvider {
  private tableCache = new Map<string, { tables: string[]; columns: Map<string, ColumnMeta[]> }>();

  constructor(private sessions: SessionManager) {}

  invalidate(sessionId?: string): void {
    if (sessionId) { this.tableCache.delete(sessionId); } else { this.tableCache.clear(); }
  }

  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
    const items: vscode.CompletionItem[] = [];
    const linePrefix = document.lineAt(position).text.slice(0, position.character);

    for (const kw of KEYWORDS) {
      const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
      item.insertText = kw;
      items.push(item);
    }

    const session = this.pickSession();
    if (session) {
      const cache = await this.tables(session.id, session.driver.currentSchema);
      // schema.table. 或 table. 前缀 → 列补全
      const dotted = linePrefix.match(/([A-Za-z_][\w$#]*)\.\s*([A-Za-z_]*)$/);
      if (dotted) {
        const t = dotted[1].toUpperCase();
        const cols = cache.columns.get(t) ?? (await this.columns(session.id, session.driver.currentSchema, t));
        for (const c of cols) {
          const it = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Field);
          it.detail = c.dataType;
          it.documentation = c.comment;
          items.push(it);
        }
        return items;
      }
      for (const t of cache.tables) {
        items.push(new vscode.CompletionItem(t, vscode.CompletionItemKind.Struct));
      }
    }
    return items;
  }

  private pickSession() {
    const all = this.sessions.all();
    if (all.length === 0) { return undefined; }
    const key = vscode.window.activeTextEditor?.document.uri.toString();
    return this.sessions.active(key) ?? all[0];
  }

  private async tables(sessionId: string, schema: string): Promise<{ tables: string[]; columns: Map<string, ColumnMeta[]> }> {
    const key = `${sessionId}:${schema}`;
    let c = this.tableCache.get(key);
    if (!c) {
      const s = this.sessions.get(sessionId);
      if (!s) { return { tables: [], columns: new Map() }; }
      const tables: string[] = [];
      const columns = new Map<string, ColumnMeta[]>();
      for (const t of OBJECT_TYPES as readonly ObjectType[]) {
        if (t === 'TABLE' || t === 'VIEW') {
          const objs = await s.driver.listObjects(schema, t).catch(() => [] as { schema: string; type: ObjectType; name: string }[]);
          tables.push(...objs.map((o) => o.name));
        }
      }
      c = { tables, columns };
      this.tableCache.set(key, c);
    }
    return c;
  }

  private async columns(sessionId: string, schema: string, table: string): Promise<ColumnMeta[]> {
    const s = this.sessions.get(sessionId);
    if (!s) { return []; }
    try {
      const { columns } = await s.driver.describeTable(schema, table);
      const cache = this.tableCache.get(`${sessionId}:${schema}`);
      cache?.columns.set(table, columns);
      return columns;
    } catch {
      return [];
    }
  }
}

export class SqlFormatProvider implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {
  provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
    const cfg = vscode.workspace.getConfiguration('sqladmin.format');
    const formatted = formatSql(document.getText(), {
      tabSize: cfg.get('tabSize') ?? 2,
      uppercaseKeywords: cfg.get('uppercaseKeywords') ?? true,
    });
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    return [vscode.TextEdit.replace(fullRange, formatted)];
  }

  provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range): vscode.TextEdit[] {
    const cfg = vscode.workspace.getConfiguration('sqladmin.format');
    const text = document.getText(range);
    const formatted = formatSql(text, {
      tabSize: cfg.get('tabSize') ?? 2,
      uppercaseKeywords: cfg.get('uppercaseKeywords') ?? true,
    });
    return [vscode.TextEdit.replace(range, formatted)];
  }
}
