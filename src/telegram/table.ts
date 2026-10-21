/**
 * Fixed-width tables for Telegram.
 *
 * Telegram renders a fenced block in a monospace face on every client, so a
 * padded table lines up the same way a rendered image would — while staying
 * selectable, copy-pasteable and searchable, and costing no image pipeline.
 *
 * (A PNG was the other option. It would mean rasterising SVG through sharp,
 * whose text rendering depends on system fonts via fontconfig — which
 * serverless images generally do not ship. The boxes would draw and the labels
 * would not, so the list is built as text instead.)
 */

export type Column = {
  header: string;
  /** Hard cap; longer cells are cut with an ellipsis. */
  width: number;
  align?: 'left' | 'right';
};

const ELLIPSIS = '…';

const fit = (value: string, width: number, align: 'left' | 'right'): string => {
  const text = value.replace(/\s+/g, ' ').trim();
  const cell = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}${ELLIPSIS}` : text;
  return align === 'right' ? cell.padStart(width) : cell.padEnd(width);
};

/** Only the fence characters and backslashes are special inside a code block. */
const escapeBlock = (value: string): string => value.replace(/([`\\])/g, '\\$1');

/**
 * Renders rows as a MarkdownV2 code block.
 *
 * Telegram does not wrap inside a code block — it scrolls horizontally — so
 * widths are chosen by the caller to suit a phone rather than squeezed to fit.
 */
export const table = (columns: Column[], rows: string[][]): string => {
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => {
        const column = columns[index]!;
        return fit(cell, column.width, column.align ?? 'left');
      })
      .join('  ')
      .trimEnd();

  const body = [
    line(columns.map((c) => c.header.toUpperCase())),
    line(columns.map((c) => '─'.repeat(c.width))),
    ...rows.map(line),
  ].join('\n');

  return `\`\`\`\n${escapeBlock(body)}\n\`\`\``;
};
