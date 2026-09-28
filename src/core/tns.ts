/**
 * 本机 tnsnames.ora 解析器（需求 F1-05，M）。
 *
 * 解析策略（经典 tnsnames 格式）：
 * - 别名定义行从第 0 列开始（不含前导空白），形如 `NAME =` 或 `NAME1,NAME2 =`；
 * - 描述体为其后的嵌套括号内容，直到下一个顶格定义行；
 * - `#` 引导行注释（不在引号内时）。
 */

export interface TnsEntry {
  aliases: string[];
  description: string;
  host?: string;
  port?: number;
  service?: string;
  sid?: string;
}

export function parseTnsNames(content: string): TnsEntry[] {
  // 预处理：去掉行注释（保守处理：仅当 # 之前没有未闭合引号时；简化为按行去掉非引号内 #）
  const lines: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = '';
    let inQuote = false;
    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i];
      if (ch === '"') { inQuote = !inQuote; line += ch; continue; }
      if (ch === '#' && !inQuote) { break; }
      line += ch;
    }
    lines.push(line);
  }

  const entries: TnsEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 顶格且包含 '=' 的行 = 别名定义行
    if (line.length > 0 && !/\s/.test(line[0]) && line.includes('=')) {
      const eq = line.indexOf('=');
      const aliasPart = line.slice(0, eq).trim();
      const aliases = aliasPart.split(',').map((a) => a.trim()).filter((a) => a.length > 0);
      const restOfLine = line.slice(eq + 1);
      i++;
      // 收集描述体：直到下一个顶格定义行
      const descLines: string[] = [restOfLine];
      while (i < lines.length) {
        const next = lines[i];
        if (next.length > 0 && !/\s/.test(next[0]) && next.includes('=')) { break; }
        descLines.push(next);
        i++;
      }
      const description = descLines.join('\n').trim();
      if (aliases.length && description.length) {
        entries.push({ aliases, description, ...extractDetails(description) });
      }
    } else {
      i++;
    }
  }
  return entries;
}

function extractDetails(description: string): Pick<TnsEntry, 'host' | 'port' | 'service' | 'sid'> {
  const host = firstMatch(description, /\bHOST\s*=\s*([A-Za-z0-9._-]+)/i);
  const portStr = firstMatch(description, /\bPORT\s*=\s*(\d+)/i);
  const service = firstMatch(description, /\bSERVICE_NAME\s*=\s*([A-Za-z0-9._$#-]+)/i);
  const sid = firstMatch(description, /\bSID\s*=\s*([A-Za-z0-9._$#-]+)/i);
  return {
    host: host || undefined,
    port: portStr ? Number(portStr) : undefined,
    service: service || undefined,
    sid: sid || undefined,
  };
}

function firstMatch(s: string, re: RegExp): string | undefined {
  const m = s.match(re);
  return m ? m[1] : undefined;
}

export function findTnsFile(customPath: string): string | undefined {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const os = require('os') as typeof import('os');

  const candidates: string[] = [];
  if (customPath) {
    candidates.push(customPath);
  }
  const tnsAdmin = process.env.TNS_ADMIN;
  if (tnsAdmin) {
    candidates.push(path.join(tnsAdmin, 'tnsnames.ora'));
  }
  const oracleHome = process.env.ORACLE_HOME ?? process.env.ORACLE_BASE;
  if (oracleHome) {
    candidates.push(path.join(oracleHome, 'network', 'admin', 'tnsnames.ora'));
  }
  // 常见 Instant Client 位置
  candidates.push(path.join(os.homedir(), 'oracle', 'network', 'admin', 'tnsnames.ora'));
  candidates.push(path.join(os.homedir(), '.oracle', 'network', 'admin', 'tnsnames.ora')); // Windows Instant Client 惯例

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) { return c; }
    } catch {
      /* 忽略不可访问路径 */
    }
  }
  return undefined;
}

export function loadTnsAliases(customPath: string): { file?: string; entries: TnsEntry[]; error?: string } {
  const fs = require('fs') as typeof import('fs');
  const file = findTnsFile(customPath);
  if (!file) {
    return { entries: [], error: customPath ? `未找到 tnsnames.ora: ${customPath}` : '未找到本机 tnsnames.ora（可设置 sqladmin.tns.customPath）' };
  }
  try {
    const content = fs.readFileSync(file, 'utf8');
    return { file, entries: parseTnsNames(content) };
  } catch (e) {
    return { file, entries: [], error: `读取 tnsnames.ora 失败: ${String(e)}` };
  }
}
