/**
 * Oracle SQL / PL-SQL 语句切分器（需求 F2-02/F2-03，风险 R4）。
 *
 * 规则：
 * - 以「;」终止语句，但位于字符串 / q'' 字面量 / 注释内时除外；
 * - PL/SQL 块（DECLARE/BEGIN/CREATE ... IS|AS ... BEGIN）作为单条语句，
 *   通过块深度跟踪，直到与块起点匹配的 END 后的「;」才终止；
 * - "END LOOP/IF/CASE" 的限定词不计为新的块开始。
 */

export interface Statement { text: string; startOffset: number; endOffset: number }

const OPENERS = new Set(['BEGIN', 'CASE', 'LOOP', 'IF']);
/** END 后面可跟的限定词，跳过避免误判为新的块开始 */
const END_QUALIFIERS = new Set(['LOOP', 'IF', 'CASE', 'WHILE']);

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$#]/.test(ch);
}

/** 词法扫描，返回带类型标记的 token 流中需要的部分 */
function scan(sql: string): Statement[] {
  const statements: Statement[] = [];
  let depth = 0;
  let stmtStart = 0;
  let i = 0;
  const n = sql.length;

  /** 块锚点：DECLARE / CREATE ... IS|AS 打开的层级。主 END 使 depth 降到 anchor-1 后，下一个 ';' 终止整个块 */
  let anchorDepth = -1;

  /** 上一个裸词（用于识别 CREATE PROCEDURE ... IS/AS 块起点） */
  let pendingCreateObject: 'maybe' | 'proc-like' | null = null;
  let prevWord = '';

  const pushStatement = (endExclusive: number) => {
    const raw = sql.slice(stmtStart, endExclusive);
    let text = raw.trim();
    if (text.endsWith(';')) { text = text.slice(0, -1).trimEnd(); }
    if (text.length > 0) {
      statements.push({ text, startOffset: stmtStart, endOffset: endExclusive });
    }
    stmtStart = endExclusive;
  };

  /** 块整体结束（主 END 后的分号） */
  const finishBlock = (endExclusive: number) => {
    pushStatement(endExclusive);
    depth = 0;
    anchorDepth = -1;
    pendingCreateObject = null;
  };

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    // 行注释
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') { i++; }
      continue;
    }
    // 块注释
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) { i++; }
      i = Math.min(i + 2, n);
      continue;
    }
    // 普通字符串
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // q'[...]' / q'x...x' 替代引用
    if (ch === 'q' || ch === 'Q') {
      const after = sql.slice(i + 1, i + 2);
      if (after === "'") {
        const open = sql[i + 2];
        let close: string;
        let skip = 0;
        if (open === '[') { close = ']'; skip = 3; }
        else if (open === '{') { close = '}'; skip = 3; }
        else if (open === '(') { close = ')'; skip = 3; }
        else if (open === '<') { close = '>'; skip = 3; }
        else { close = open; skip = 3; }
        i += skip;
        while (i < n && sql[i] !== close) { i++; }
        if (i < n) { i++; }
        if (sql[i] === "'") { i++; }
        continue;
      }
    }
    // 双引号标识符
    if (ch === '"') {
      i++;
      while (i < n && sql[i] !== '"') { i++; }
      i++;
      continue;
    }

    // 标识符/关键字
    if (/[A-Za-z]/.test(ch)) {
      const start = i;
      while (i < n && isIdentChar(sql[i])) { i++; }
      const word = sql.slice(start, i).toUpperCase();
      const prevChar = sql.slice(start - 1, start).trim() === '' ? ' ' : sql[start - 1];

      if (word === 'END') {
        depth = Math.max(0, depth - 1);
        // 跳过 END LOOP / END IF / END CASE / END <块名> 中的限定词
        let j = i;
        while (j < n && /\s/.test(sql[j])) { j++; }
        let k = j;
        while (k < n && isIdentChar(sql[k])) { k++; }
        const qual = sql.slice(j, k).toUpperCase();
        if (END_QUALIFIERS.has(qual)) { i = k; }
        // 若回到锚点层之下：等待块尾分号（finishBlock 由分号触发）
      } else if (word === 'BEGIN') {
        // 声明段（DECLARE / CREATE..IS）之后的主 BEGIN 与锚点同层配对，不额外打开
        if (depth !== anchorDepth) { depth++; }
      } else if (word === 'DECLARE') {
        depth++;
        anchorDepth = depth;
      } else if (OPENERS.has(word) && prevChar !== '.' && !(word === 'IF' && prevWord === 'END')) {
        depth++;
      } else if (pendingCreateObject === 'proc-like' && (word === 'IS' || word === 'AS')) {
        depth++;
        anchorDepth = depth;
        pendingCreateObject = null;
      } else if (word === 'CREATE') {
        pendingCreateObject = 'maybe';
      } else if (pendingCreateObject === 'maybe') {
        if (['PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'TYPE'].includes(word)) {
          pendingCreateObject = 'proc-like';
        } else if (!['OR', 'REPLACE'].includes(word)
          && !['TABLE', 'VIEW', 'INDEX', 'SYNONYM', 'SEQUENCE', 'MATERIALIZED'].includes(word)) {
          pendingCreateObject = null;
        }
      }

      prevWord = word;
      continue;
    }

    if (ch === ';') {
      if (depth === Math.max(0, anchorDepth - 1) && anchorDepth > 0) {
        // 块尾分号：DECLARE / CREATE ... IS 块整体结束
        finishBlock(i + 1);
      } else if (depth === 0) {
        pushStatement(i + 1);
      }
      i++;
      continue;
    }

    i++;
  }

  // 末尾无分号的残余
  if (stmtStart < n) {
    const tail = sql.slice(stmtStart).trim();
    if (tail.length > 0 && tail !== ';') {
      statements.push({ text: tail.replace(/;+\s*$/, '').trim(), startOffset: stmtStart, endOffset: n });
    }
  }
  return statements;
}

/** 切分全部语句 */
export function splitSql(sql: string): Statement[] {
  return scan(sql);
}

/** 取得光标所在语句（无选区时的「执行当前语句」语义，F2-02） */
export function statementAt(sql: string, offset: number): Statement | undefined {
  const all = scan(sql);
  // 语句之间的空白归属：取 startOffset <= offset < endOffset 的语句；
  // 若落在间隙，取前一条（光标在上一条结尾分号后通常意图下一条→取后一条更符合工具行为：
  // SQL Developer 语义：光标在空行按 Ctrl+Enter 执行下一条）。
  for (let idx = 0; idx < all.length; idx++) {
    const s = all[idx];
    const nextStart = all[idx + 1]?.startOffset ?? Number.MAX_SAFE_INTEGER;
    const prevEnd = all[idx - 1]?.endOffset ?? 0;
    if (offset >= prevEnd && offset < nextStart) {
      // 光标位于「上一条结束 ~ 下一条开始」之间的间隙：
      // 更靠近哪条的文本主体就执行哪条；间隙正中（空行）取下一条。
      const sStart = s.startOffset;
      const gapMid = (prevEnd + nextStart) / 2;
      if (idx > 0 && offset < sStart && offset < gapMid) {
        return all[idx - 1];
      }
      return s;
    }
    if (offset >= s.startOffset && offset < s.endOffset) { return s; }
  }
  return all.length ? all[all.length - 1] : undefined;
}

/** 提取绑定变量名（:name），跳过 := 赋值符（F2-08） */
export function extractBinds(sql: string): string[] {
  const names = new Set<string>();
  const re = /(?<![:!\w])(?::)([A-Za-z][A-Za-z0-9_$#]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    names.add(m[1]);
  }
  return [...names];
}
