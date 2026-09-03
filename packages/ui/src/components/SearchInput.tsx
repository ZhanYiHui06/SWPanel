import { cx } from "../lib/cx.js";
import { SearchIcon } from "../icons/index.js";

/**
 * SearchInput — bordered text input with a leading magnifier (`.search-input`).
 */
export interface SearchInputProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  /** `.wide` gives the field a 320px minimum width. */
  wide?: boolean;
  disabled?: boolean;
  className?: string;
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
}

export function SearchInput({
  value: controlled,
  defaultValue,
  onValueChange,
  placeholder,
  wide = false,
  disabled = false,
  className,
  inputProps
}: SearchInputProps) {
  return (
    <div className={cx("search-input", wide && "wide", className)}>
      <SearchIcon className="search-input-icon" />
      <input
        type="search"
        value={controlled}
        defaultValue={defaultValue}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onValueChange?.(event.target.value)}
        {...inputProps}
      />
    </div>
  );
}
