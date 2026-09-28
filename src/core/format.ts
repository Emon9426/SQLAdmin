/**
 * SQL 格式化（需求 F2-11）：sql-formatter plsql 方言 + 缩进/大小写配置。
 */
import { format as sqlFormat } from 'sql-formatter';

export interface FormatOptions {
  tabSize: number;
  uppercaseKeywords: boolean;
}

export const defaultFormatOptions: FormatOptions = { tabSize: 2, uppercaseKeywords: true };

export function formatSql(sql: string, opts: FormatOptions = defaultFormatOptions): string {
  return sqlFormat(sql, {
    language: 'plsql',
    tabWidth: opts.tabSize,
    keywordCase: opts.uppercaseKeywords ? 'upper' : 'preserve',
    expressionWidth: 80,
    logicalOperatorNewline: 'before',
  });
}
