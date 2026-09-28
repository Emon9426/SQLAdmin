/**
 * 导出器（需求 F4）：CSV / JSON / INSERT / HTML 即写即流；XLSX 走 exceljs 流式 WorkbookWriter。
 * 全部接受行数组分批写入，内存有上界（配合 driver.executeStream 实现全量导出）。
 */
import * as fs from 'fs';
import { once } from 'events';
import { ColumnMeta } from '../driver/types';

/** 尊重流背压：写缓冲满时等待 drain，保证大数据量导出内存有上界 */
async function writeChunk(stream: fs.WriteStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, 'drain');
  }
}

export interface ExportOptions {
  includeHeader: boolean;
  nullText: string;
  delimiter: string;
  /** CSV 是否写 UTF-8 BOM（Excel 兼容） */
  bom: boolean;
  dateFormat?: string;
}

export const defaultExportOptions: ExportOptions = {
  includeHeader: true,
  nullText: 'NULL',
  delimiter: ',',
  bom: true,
};

function cellText(v: unknown): string {
  if (v === null || v === undefined) { return 'NULL'; }
  if (v instanceof Date) {
    const p = (x: number) => String(x).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  return String(v);
}

export class CsvWriter {
  private stream: fs.WriteStream;
  private count = 0;
  constructor(file: string, private opts: ExportOptions) {
    this.stream = fs.createWriteStream(file, { encoding: 'utf8' });
    if (opts.bom) { this.stream.write('\uFEFF'); }
  }
  async writeHeader(columns: string[]): Promise<void> {
    if (!this.opts.includeHeader) { return; }
    await writeChunk(this.stream, columns.map((c) => csvEscape(c, this.opts.delimiter)).join(this.opts.delimiter) + '\n');
  }
  async writeRow(row: unknown[]): Promise<void> {
    await writeChunk(this.stream, row.map((v) => v === null || v === undefined ? this.opts.nullText : csvEscape(v, this.opts.delimiter)).join(this.opts.delimiter) + '\n');
    this.count++;
  }
  async close(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    return this.count;
  }
}

function csvEscape(v: unknown, delimiter: string): string {
  const s = cellText(v);
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export class JsonWriter {
  private stream: fs.WriteStream;
  private count = 0;
  private first = true;
  private columns: string[] = [];
  constructor(file: string) {
    this.stream = fs.createWriteStream(file, { encoding: 'utf8' });
    this.stream.write('[\n');
  }
  async writeHeader(columns: string[]): Promise<void> { this.columns = columns; }
  async writeRow(row: unknown[]): Promise<void> {
    const obj: Record<string, unknown> = {};
    this.columns.forEach((c, i) => {
      const v = row[i];
      obj[c] = v === null || v === undefined ? null : v instanceof Date ? cellText(v) : v;
    });
    await writeChunk(this.stream, `${this.first ? ' ' : ','}${JSON.stringify(obj)}\n`);
    this.first = false;
    this.count++;
  }
  async close(): Promise<number> {
    await writeChunk(this.stream, ']\n');
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    return this.count;
  }
}

export class InsertWriter {
  private stream: fs.WriteStream;
  private count = 0;
  constructor(file: string, private table: string, private columns: string[]) {
    this.stream = fs.createWriteStream(file, { encoding: 'utf8' });
  }
  async writeHeader(columns: string[]): Promise<void> { void columns; /* 列由构造传入 */ }
  async writeRow(row: unknown[]): Promise<void> {
    const cols = this.columns.map((c) => `"${c}"`).join(', ');
    const vals = row.map((v) => {
      if (v === null || v === undefined) { return 'NULL'; }
      if (typeof v === 'number') { return String(v); }
      return `'${String(v).replace(/'/g, "''")}'`;
    }).join(', ');
    await writeChunk(this.stream, `INSERT INTO ${this.table} (${cols}) VALUES (${vals});\n`);
    this.count++;
  }
  async close(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    return this.count;
  }
}

export class HtmlWriter {
  private stream: fs.WriteStream;
  private count = 0;
  private openedTable = false;
  constructor(file: string, private title: string) {
    this.stream = fs.createWriteStream(file, { encoding: 'utf8' });
    this.stream.write(`<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>\n`);
    this.stream.write(`<style>body{font-family:Segoe UI,Arial,sans-serif;margin:24px;color:#1f2328}h1{font-size:18px}table{border-collapse:collapse;font-size:13px}th,td{border:1px solid #d0d7de;padding:4px 10px}th{background:#eef2f7}tr:nth-child(even) td{background:#fbfcfe}</style>\n`);
    this.stream.write(`</head><body><h1>${escapeHtml(title)}</h1>\n<table>\n`);
  }
  async writeHeader(columns: string[]): Promise<void> {
    await writeChunk(this.stream, '<tr>' + columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>\n');
    this.openedTable = true;
  }
  async writeRow(row: unknown[]): Promise<void> {
    await writeChunk(this.stream, '<tr>' + row.map((v) => `<td>${escapeHtml(v === null || v === undefined ? 'NULL' : cellText(v))}</td>`).join('') + '</tr>\n');
    this.count++;
  }
  async close(): Promise<number> {
    if (!this.openedTable) { await writeChunk(this.stream, '</table>\n'); }
    await writeChunk(this.stream, `</table><p>${this.count} rows</p></body></html>\n`);
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    return this.count;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type ExportFormat = 'csv' | 'xlsx' | 'json' | 'insert' | 'html';

/** XLSX 流式写入器（懒加载 exceljs，减小启动开销） */
export class XlsxWriter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private workbook: any;
  private sheet: any;
  private count = 0;
  private headerWritten = false;
  constructor(file: string, private sheetName = 'Sheet1') {
    const ExcelJS = require('exceljs');
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file });
    this.sheet = this.workbook.addWorksheet(sheetName);
  }
  async writeHeader(columns: string[]): Promise<void> {
    this.sheet.columns = columns.map((c) => ({ header: c, width: Math.max(12, Math.min(40, c.length + 4)) }));
    this.headerWritten = true;
  }
  async writeRow(row: unknown[]): Promise<void> {
    this.sheet.addRow(row.map((v) => (v === null || v === undefined ? null : v instanceof Date ? cellText(v) : v))).commit();
    this.count++;
  }
  async close(): Promise<number> {
    if (!this.headerWritten) { this.sheet.columns = []; }
    this.sheet.commit();
    await this.workbook.commit();
    return this.count;
  }
}

export interface RowBatchWriter {
  writeHeader(columns: string[]): Promise<void>;
  writeRow(row: unknown[]): Promise<void>;
  close(): Promise<number>;
}

export function createWriter(format: ExportFormat, file: string, opts: ExportOptions, columns: string[], table?: string): RowBatchWriter {
  switch (format) {
    case 'csv': return new CsvWriter(file, opts);
    case 'json': return new JsonWriter(file);
    case 'insert': return new InsertWriter(file, table ?? 'TABLE', columns);
    case 'html': return new HtmlWriter(file, table ?? 'RESULT');
    case 'xlsx': return new XlsxWriter(file);
  }
}

/** 列名提取（ColumnMeta[] → string[]） */
export function columnNames(columns: ColumnMeta[] | undefined, rows: unknown[][] | undefined): string[] {
  if (columns && columns.length) { return columns.map((c) => c.name); }
  const first = rows?.[0];
  return first ? first.map((_, i) => `COL_${i + 1}`) : [];
}
