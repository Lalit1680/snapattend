import EmptyState from './EmptyState.jsx';
import LoadingBlock from './LoadingBlock.jsx';

const ALIGN_CLASS = { right: 'col-right', center: 'col-center' };

/** Controls inside a row own their own activation; the row must not fire too. */
const NESTED_CONTROL = 'button, a, input, select, label';

function isNestedControl(target) {
  return Boolean(target && typeof target.closest === 'function' && target.closest(NESTED_CONTROL));
}

function cellClass(column) {
  return (
    [ALIGN_CLASS[column.align], column.nowrap ? 'col-nowrap' : null].filter(Boolean).join(' ') ||
    undefined
  );
}

function resolveRowKey(rowKey, row, index) {
  if (typeof rowKey === 'function') return rowKey(row, index);
  if (typeof rowKey === 'string' && row && row[rowKey] !== undefined && row[rowKey] !== null) {
    return row[rowKey];
  }
  if (row && row.id !== undefined && row.id !== null) return row.id;
  return index;
}

function renderCell(column, row, index) {
  if (typeof column.render === 'function') return column.render(row, index);
  const value = row ? row[column.key] : undefined;
  // A blank cell reads as a rendering bug; an em dash reads as "no value".
  return value === null || value === undefined ? '—' : value;
}

function Table({ columns, rows, rowKey, empty, loading, compact = false, onRowClick, footer }) {
  // Pages pass `rows={data?.items}`, which is undefined until the first load lands.
  const safeColumns = Array.isArray(columns) ? columns : [];
  const safeRows = Array.isArray(rows) ? rows : [];
  const clickable = typeof onRowClick === 'function';
  // Stale rows stay visible during a reload rather than flashing a spinner over
  // data that is still valid, so the refetch is announced instead of shown.
  const busy = loading ? 'true' : undefined;

  const activate = (row, index, event) => {
    if (isNestedControl(event.target)) return;
    onRowClick(row, index);
  };

  const handleKeyDown = (row, index) => (event) => {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    if (isNestedControl(event.target)) return;
    event.preventDefault(); // Space would scroll the page instead of opening the row
    onRowClick(row, index);
  };

  if (safeRows.length === 0) {
    return (
      <div className="table-wrap">
        {loading ? (
          <LoadingBlock />
        ) : empty === undefined ? (
          <EmptyState title="Nothing to show yet" />
        ) : (
          empty
        )}
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table
        className={['table', compact ? 'table-compact' : null].filter(Boolean).join(' ')}
        aria-busy={busy}
      >
        <thead>
          <tr>
            {safeColumns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cellClass(column)}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {safeRows.map((row, index) => (
            <tr
              key={resolveRowKey(rowKey, row, index)}
              className={clickable ? 'is-clickable' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? (event) => activate(row, index, event) : undefined}
              onKeyDown={clickable ? handleKeyDown(row, index) : undefined}
            >
              {safeColumns.map((column) => (
                <td key={column.key} className={cellClass(column)}>
                  {renderCell(column, row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot className="table-foot">
            <tr>
              <td colSpan={safeColumns.length}>{footer}</td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

export default Table;
