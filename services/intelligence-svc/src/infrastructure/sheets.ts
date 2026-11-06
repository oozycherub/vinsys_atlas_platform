import ExcelJS from 'exceljs';
import { type DemandSheets } from '../application/ports';

/** The first worksheet of an .xlsx file as rows of cell text (dates as YYYY-MM-DD). */
export class ExcelDemandSheets implements DemandSheets {
  async rows(_fileName: string, content: Buffer): Promise<string[][]> {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(content as unknown as ArrayBuffer);
    const sheet = book.worksheets[0];
    if (!sheet) return [];
    const out: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= row.cellCount; c++) {
        const v = row.getCell(c).value;
        cells.push(
          v instanceof Date
            ? v.toISOString().slice(0, 10)
            : v === null || v === undefined
              ? ''
              : typeof v === 'object' && 'text' in v
                ? String(v.text)
                : typeof v === 'object' && 'result' in v
                  ? String(v.result ?? '')
                  : String(v as string | number | boolean),
        );
      }
      out.push(cells);
    });
    return out;
  }
}
