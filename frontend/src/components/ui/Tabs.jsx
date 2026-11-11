import { useRef } from 'react';

/**
 * Horizontal tab strip. `tabs` are `{key, label, badge?}`; the caller owns the
 * selected key and renders the panel itself.
 */
export default function Tabs({ tabs, active, onChange }) {
  const items = Array.isArray(tabs) ? tabs : [];
  const buttonsRef = useRef([]);
  const activeIndex = items.findIndex((tab) => tab.key === active);
  // With a roving tabindex, every tab being -1 would make the strip unreachable
  // by keyboard — so when `active` matches nothing, the first tab takes the stop.
  const focusIndex = activeIndex === -1 ? 0 : activeIndex;

  function handleKeyDown(event, index) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    if (items.length < 2) return;
    event.preventDefault(); // otherwise the arrow scrolls an overflowing strip
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = (index + delta + items.length) % items.length;
    if (onChange) onChange(items[next].key);
    // Focus follows selection, so a second arrow press continues from the new tab
    // instead of snapping back to where the teacher started.
    const node = buttonsRef.current[next];
    if (node) node.focus();
  }

  return (
    <div className="tabs" role="tablist">
      {items.map((tab, index) => (
        <button
          key={tab.key}
          ref={(node) => {
            buttonsRef.current[index] = node;
          }}
          type="button"
          role="tab"
          aria-selected={index === activeIndex}
          tabIndex={index === focusIndex ? 0 : -1}
          className={['tab', index === activeIndex && 'is-active'].filter(Boolean).join(' ')}
          onClick={() => onChange && onChange(tab.key)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {tab.label}
          {/* A badge of 0 still renders; pass undefined to hide the count. */}
          {tab.badge === undefined || tab.badge === null ? null : (
            <span className="tab-badge">{tab.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}
