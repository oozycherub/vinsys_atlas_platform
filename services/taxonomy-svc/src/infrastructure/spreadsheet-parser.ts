import ExcelJS from 'exceljs';
import { type SpreadsheetParser } from '../application/import.service';
import { TaxonomyDomainError } from '../domain/errors';
import {
  type ImportRow,
  KNOWN_COLUMNS,
  MAX_IMPORT_ROWS,
  REQUIRED_COLUMNS,
} from '../domain/import-plan';

/** A UTF-8 byte-order mark, written as a code point so the source stays plain ASCII. */
const BOM = new RegExp('^' + String.fromCharCode(0xfeff));

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, optional UTF-8 BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(BOM, '');
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (quoted) {
    throw new TaxonomyDomainError(
      'validation',
      'INVALID_CSV',
      'The CSV has an unterminated quote.',
    );
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Header row + data rows → ImportRow[] (line numbers are 1-based spreadsheet lines). */
export function toImportRows(table: string[][]): ImportRow[] {
  const [header, ...data] = table;
  if (!header) throw new TaxonomyDomainError('validation', 'IMPORT_EMPTY', 'The file is empty.');
  const columns = header.map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    throw new TaxonomyDomainError(
      'validation',
      'IMPORT_MISSING_COLUMNS',
      `Missing required column(s): ${missing.join(', ')}. Known columns: ${KNOWN_COLUMNS.join(', ')}.`,
    );
  }
  if (data.length > MAX_IMPORT_ROWS) {
    throw new TaxonomyDomainError(
      'validation',
      'IMPORT_TOO_LARGE',
      `At most ${MAX_IMPORT_ROWS} rows per import.`,
    );
  }
  const rows: ImportRow[] = [];
  data.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === '')) return;
    const values: Record<string, string> = {};
    columns.forEach((column, j) => {
      if ((KNOWN_COLUMNS as readonly string[]).includes(column)) values[column] = cells[j] ?? '';
    });
    rows.push({ line: i + 2, values });
  });
  return rows;
}

/** CSV or XLSX (first worksheet). The upload size limit is enforced by the HTTP layer. */
export class TaxonomySpreadsheetParser implements SpreadsheetParser {
  async parse(file: { name: string; mimeType: string; content: Buffer }): Promise<ImportRow[]> {
    const name = file.name.toLowerCase();
    if (name.endsWith('.csv') || file.mimeType === 'text/csv') {
      return toImportRows(parseCsv(file.content.toString('utf8')));
    }
    if (name.endsWith('.xlsx')) {
      const workbook = new ExcelJS.Workbook();
      try {
        await workbook.xlsx.load(file.content as unknown as ArrayBuffer);
      } catch {
        throw new TaxonomyDomainError(
          'validation',
          'INVALID_XLSX',
          'The file is not a readable .xlsx workbook.',
        );
      }
      const sheet = workbook.worksheets[0];
      if (!sheet) {
        throw new TaxonomyDomainError(
          'validation',
          'IMPORT_EMPTY',
          'The workbook has no worksheet.',
        );
      }
      const table: string[][] = [];
      sheet.eachRow({ includeEmpty: true }, (row) => {
        const cells: string[] = [];
        for (let c = 1; c <= sheet.columnCount; c += 1) cells.push(row.getCell(c).text);
        table.push(cells);
      });
      return toImportRows(table);
    }
    throw new TaxonomyDomainError(
      'validation',
      'UNSUPPORTED_FILE_TYPE',
      'Upload a .csv or .xlsx file.',
    );
  }
}
