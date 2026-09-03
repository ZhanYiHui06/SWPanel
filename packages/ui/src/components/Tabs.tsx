import { cx } from "../lib/cx.js";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/**
 * Tabs — underline tab bar (`.tabs` / `.tab-item`).
 * Uncontrolled by default; pass `value`/`onChange` to control.
 */
export interface TabOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  /** Optional panel content associated with this tab. */
  panel?: ReactNode;
}

export interface TabsProps<V extends string> {
  options: ReadonlyArray<TabOption<V>>;
  value?: V;
  defaultValue?: V;
  onChange?: (value: V) => void;
  className?: string;
  /** aria-label for the tablist */
  label: string;
}

function findEnabledOption<V extends string>(
  options: ReadonlyArray<TabOption<V>>,
  preferred?: V
): TabOption<V> | undefined {
  return options.find((option) => option.value === preferred && !option.disabled)
    ?? options.find((option) => !option.disabled);
}

export function Tabs<V extends string>({
  options,
  value: controlled,
  defaultValue,
  onChange,
  className,
  label
}: TabsProps<V>) {
  const id = useId();
  const initialOption = findEnabledOption(options, controlled ?? defaultValue);
  const [internal, setInternal] = useState<V | undefined>(initialOption?.value);
  const selectedOption = findEnabledOption(options, controlled ?? internal);
  const active = selectedOption?.value;
  const [focusValue, setFocusValue] = useState<V | undefined>(initialOption?.value);
  const focusedOption = findEnabledOption(options, focusValue) ?? selectedOption;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function select(option: TabOption<V>) {
    if (option.disabled) return;
    if (controlled === undefined) setInternal(option.value);
    setFocusValue(option.value);
    onChange?.(option.value);
  }

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, optionIndex: number) {
    const enabledIndexes = options.flatMap((option, index) => (option.disabled ? [] : [index]));
    const currentEnabledIndex = enabledIndexes.indexOf(optionIndex);
    let targetIndex: number | undefined;

    if (event.key === "Home") targetIndex = enabledIndexes[0];
    if (event.key === "End") targetIndex = enabledIndexes.at(-1);
    if (event.key === "ArrowRight" && currentEnabledIndex !== -1) {
      targetIndex = enabledIndexes[(currentEnabledIndex + 1) % enabledIndexes.length];
    }
    if (event.key === "ArrowLeft" && currentEnabledIndex !== -1) {
      targetIndex = enabledIndexes[(currentEnabledIndex - 1 + enabledIndexes.length) % enabledIndexes.length];
    }

    if (targetIndex === undefined) return;
    event.preventDefault();
    const target = options[targetIndex];
    if (target === undefined) return;
    setFocusValue(target.value);
    tabRefs.current[targetIndex]?.focus();
  }

  return (
    <>
      <div className={cx("tabs", className)} role="tablist" aria-label={label}>
        {options.map((option, index) => {
          const isActive = option.value === active;
          return (
            <button
              key={option.value}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${index}`}
              aria-selected={isActive}
              aria-controls={`${id}-panel-${index}`}
              tabIndex={!option.disabled && option.value === focusedOption?.value ? 0 : -1}
              className={cx("tab-item", isActive && "active")}
              disabled={option.disabled}
              onFocus={() => setFocusValue(option.value)}
              onKeyDown={(event) => moveFocus(event, index)}
              onClick={() => select(option)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {options.map((option, index) => (
        <div
          key={option.value}
          role="tabpanel"
          id={`${id}-panel-${index}`}
          aria-labelledby={`${id}-tab-${index}`}
          hidden={option.value !== active}
        >
          {option.panel}
        </div>
      ))}
    </>
  );
}

/**
 * FilterTabs — segmented control (`.filter-tabs` / `.filter-tab`),
 * used for run/drawing status filtering.
 */
export interface FilterTabsProps<V extends string> {
  options: ReadonlyArray<TabOption<V>>;
  value?: V;
  defaultValue?: V;
  onChange?: (value: V) => void;
  className?: string;
  /** aria-label for the group */
  label: string;
}

export function FilterTabs<V extends string>({
  options,
  value: controlled,
  defaultValue,
  onChange,
  className,
  label
}: FilterTabsProps<V>) {
  const [internal, setInternal] = useState<V | undefined>(defaultValue);
  const active = controlled ?? internal;

  function select(option: TabOption<V>) {
    if (option.disabled) return;
    setInternal(option.value);
    onChange?.(option.value);
  }

  return (
    <div className={cx("filter-tabs", className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === active}
          className={cx("filter-tab", option.value === active && "active")}
          disabled={option.disabled}
          onClick={() => select(option)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
