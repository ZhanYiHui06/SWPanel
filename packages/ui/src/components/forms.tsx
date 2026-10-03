import { cx } from "../lib/cx.js";
import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * FormField — label + control + hint/error container (`.form-field`).
 */
export interface FormFieldProps {
  label: string;
  htmlFor?: string;
  /** Renders the ` *` required asterisk (`.form-label-required`). */
  required?: boolean;
  hint?: string;
  /** Renders an error hint and marks the control invalid via fieldset data. */
  error?: string;
  className?: string;
  children: ReactNode;
}

export function FormField({
  label,
  htmlFor,
  required = false,
  hint,
  error,
  className,
  children
}: FormFieldProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const messageId = `${useId()}-message`;
  const hasMessage = error !== undefined || hint !== undefined;
  const invalid = error !== undefined;

  // Controls are wrapped by other components (TextInput, Select, ...), so the
  // association is applied to the rendered control: the one `htmlFor` points
  // at, otherwise the first form control. Attributes the caller already set
  // are never overwritten, and everything added here is removed on cleanup.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return undefined;
    const byId = htmlFor !== undefined ? root.querySelector(`[id="${htmlFor}"]`) : null;
    const control =
      byId instanceof HTMLElement && byId.matches("input, select, textarea")
        ? byId
        : root.querySelector<HTMLElement>("input, select, textarea");
    if (control === null) return undefined;

    const added: string[] = [];
    const set = (name: string, value: string): void => {
      if (control.hasAttribute(name)) return;
      control.setAttribute(name, value);
      added.push(name);
    };
    if (hasMessage) set("aria-describedby", messageId);
    if (required) set("aria-required", "true");
    if (invalid) set("aria-invalid", "true");
    return () => {
      for (const name of added) control.removeAttribute(name);
    };
  }, [htmlFor, hasMessage, invalid, required, messageId]);

  return (
    <div ref={rootRef} className={cx("form-field", className)}>
      <label className={cx("form-label", required && "form-label-required")} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error !== undefined ? (
        <span id={messageId} className={cx("form-hint", "form-hint-error")} role="alert">
          {error}
        </span>
      ) : (
        hint !== undefined && (
          <span id={messageId} className="form-hint">
            {hint}
          </span>
        )
      )}
    </div>
  );
}

/** Shared control props for the form inputs. */
export interface TextInputProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  /** Mono styling (`.form-input.mono`), e.g. drawing numbers and paths. */
  mono?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
}

/**
 * TextInput — `.form-input`.
 */
export function TextInput({
  value: controlled,
  defaultValue,
  onValueChange,
  placeholder,
  mono = false,
  disabled = false,
  invalid = false,
  className,
  inputProps
}: TextInputProps) {
  return (
    <input
      type="text"
      className={cx("form-input", mono && "mono", className)}
      value={controlled}
      defaultValue={defaultValue}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onChange={(event) => onValueChange?.(event.target.value)}
      {...inputProps}
    />
  );
}

/**
 * NumberInput — numeric input with mono/numeric styling (`.form-input-number`).
 */
export interface NumberInputProps
  extends Omit<TextInputProps, "mono" | "inputProps" | "value" | "defaultValue"> {
  value?: number | string;
  defaultValue?: number | string;
  onValueChange?: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
}

export function NumberInput({
  value,
  defaultValue,
  onValueChange,
  placeholder,
  disabled = false,
  invalid = false,
  className,
  min,
  max,
  step,
  inputProps
}: NumberInputProps) {
  return (
    <input
      type="number"
      className={cx("form-input", "form-input-number", className)}
      value={value}
      defaultValue={defaultValue}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      min={min}
      max={max}
      step={step}
      onChange={(event) => onValueChange?.(event.target.value)}
      {...inputProps}
    />
  );
}

/** TextareaProps — `.form-textarea`. */
export interface TextareaProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  rows?: number;
  className?: string;
  textareaProps?: React.TextareaHTMLAttributes<HTMLTextAreaElement>;
}

export function Textarea({
  value: controlled,
  defaultValue,
  onValueChange,
  placeholder,
  disabled = false,
  invalid = false,
  rows,
  className,
  textareaProps
}: TextareaProps) {
  return (
    <textarea
      className={cx("form-textarea", className)}
      value={controlled}
      defaultValue={defaultValue}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      rows={rows}
      onChange={(event) => onValueChange?.(event.target.value)}
      {...textareaProps}
    />
  );
}

/** SelectOption — value may be omitted for non-value options. */
export interface SelectOption {
  label: string;
  value?: string;
  disabled?: boolean;
}

/** SelectProps — `.form-select` with the prototype's custom arrow. */
export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  options: ReadonlyArray<SelectOption>;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  selectProps?: React.SelectHTMLAttributes<HTMLSelectElement>;
}

export function Select({
  value: controlled,
  defaultValue,
  onValueChange,
  placeholder,
  options,
  disabled = false,
  invalid = false,
  className,
  selectProps
}: SelectProps) {
  return (
    <select
      className={cx("form-select", className)}
      value={controlled}
      defaultValue={defaultValue}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onChange={(event) => onValueChange?.(event.target.value)}
      {...selectProps}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option.label} value={option.value ?? option.label} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** InputGroup — value input with a fixed suffix (`.input-group` + `.input-suffix`). */
export interface InputGroupProps {
  children: ReactNode;
  className?: string;
}

export function InputGroup({ children, className }: InputGroupProps) {
  return <div className={cx("input-group", className)}>{children}</div>;
}

export function InputSuffix({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={cx("input-suffix", className)}>{children}</span>;
}

/** UnitSelect — suffix unit picker (`.input-unit-select`), e.g. mm/cm/m. */
export interface UnitSelectProps extends Omit<SelectProps, "placeholder" | "className" | "selectProps"> {
  options: ReadonlyArray<SelectOption>;
  className?: string;
  selectProps?: React.SelectHTMLAttributes<HTMLSelectElement>;
}

export function UnitSelect({
  value,
  defaultValue,
  onValueChange,
  options,
  disabled = false,
  className,
  selectProps
}: UnitSelectProps) {
  return (
    <select
      className={cx("input-unit-select", className)}
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
      {...selectProps}
    >
      {options.map((option) => (
        <option key={option.label} value={option.value ?? option.label} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
