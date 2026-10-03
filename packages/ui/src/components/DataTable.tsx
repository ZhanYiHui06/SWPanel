import { cx } from "../lib/cx.js";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

/** A table cell value. Raw strings render as text; ReactNode passes through. */
export type CellContent = ReactNode;

/** Cell class hint, matching prototype column helpers. */
export type CellClass =
  | "mono"
  | "date"
  | "result"
  | "result-muted"
  | "version"
  /** Right-aligned tabular figures for quantities and amounts. */
  | "numeric"
  /** Right-aligned, non-wrapping action buttons. */
  | "actions";

/**
 * DataTable column definition. The `align` and `width` helpers map to the
 * prototype's `col-*` presentation classes.
 */
export interface DataTableColumn {
  header: ReactNode;
  /** Optional machine key used for `keyColumn` rows; not required. */
  key?: string;
  /** Presentation class hint for the data cell. */
  cellClass?: CellClass;
  /** Width hint (e.g. "32%"), applied to the header as inline style. */
  width?: string | number;
  align?: "left" | "right" | "center";
}

/**
 * DataTable — bordered table shell with sticky header styling matching the
 * prototype (`.data-sheet` + `.data-table`). Row hover requires `rowClick`
 * to be provided, which renders rows as focusable keyboard-accessible buttons.
 */
export interface DataTableProps {
  columns: ReadonlyArray<DataTableColumn>;
  rows: ReadonlyArray<Record<string, CellContent>>;
  /** Column key used for the React row key. */
  keyColumn: string;
  /** When set, each row becomes a clickable, keyboard-accessible row. */
  rowClick?: (row: Record<string, CellContent>, index: number) => void;
  className?: string;
  /** Aria label for the table. */
  label: string;
}

const cellClassMap: Partial<Record<CellClass, string>> = {
  mono: "col-mono",
  date: "col-date",
  result: "col-result",
  "result-muted": "col-result-muted",
  version: "col-version",
  numeric: "col-numeric",
  actions: "col-actions"
};

const alignClassMap: Record<NonNullable<DataTableColumn["align"]>, string> = {
  left: "",
  right: "col-right",
  center: ""
};

/** Header cells follow the column's alignment so labels sit over right-aligned values. */
function headerAlignClass(column: DataTableColumn): string | undefined {
  if (column.align === "right" || column.cellClass === "numeric" || column.cellClass === "actions") {
    return "col-right";
  }
  return undefined;
}

const interactiveSelector =
  "a, button, input, select, textarea, summary, [role='button'], [role='link'], [contenteditable='true']";

function isNestedInteractiveTarget(event: MouseEvent<HTMLTableRowElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const interactiveTarget = target.closest(interactiveSelector);
  return interactiveTarget !== null && interactiveTarget !== event.currentTarget;
}

export function DataTable({
  columns,
  rows,
  keyColumn,
  rowClick,
  className,
  label
}: DataTableProps) {
  const clickable = rowClick !== undefined;

  return (
    <div className={cx("data-sheet", className)}>
      <table className="data-table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th
                key={index}
                scope="col"
                className={headerAlignClass(column)}
                style={column.width !== undefined ? { width: column.width } : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const key = String(row[keyColumn] ?? rowIndex);
            const cells = columns.map((column, columnIndex) => {
              const cellClass = cellClassMap[column.cellClass ?? "result"];
              const alignClass = alignClassMap[column.align ?? "left"];
              return (
                <td key={columnIndex} className={cx(cellClass, alignClass)}>
                  {row[column.key ?? String(columnIndex)] ?? ""}
                </td>
              );
            });

            if (clickable) {
              return (
                <tr
                  key={key}
                  className="clickable"
                  role="button"
                  tabIndex={0}
                  data-row={key}
                  onClick={(event) => {
                    if (!isNestedInteractiveTarget(event)) rowClick(row, rowIndex);
                  }}
                  onKeyDown={(event: KeyboardEvent<HTMLTableRowElement>) => {
                    if (event.target !== event.currentTarget || event.repeat) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      rowClick(row, rowIndex);
                    }
                  }}
                >
                  {cells}
                </tr>
              );
            }

            return <tr key={key}>{cells}</tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}
