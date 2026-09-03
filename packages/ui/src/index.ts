/* SWPanel UI package — shared visual primitives, tokens and local icons.
   Styles and fonts are side-effect imports; app entry wires them once:
     import "@swpanel/ui/styles";
     import "@swpanel/ui/fonts";  */

export { Button, type ButtonProps } from "./components/Button.js";
export { IconButton, type IconButtonProps } from "./components/IconButton.js";
export {
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  CardFooter,
  CardDescription,
  type CardBodyProps
} from "./components/Card.js";
export { StatusBadge, type StatusBadgeProps } from "./components/StatusBadge.js";
export {
  Tabs,
  FilterTabs,
  type TabsProps,
  type FilterTabsProps,
  type TabOption
} from "./components/Tabs.js";
export { SearchInput, type SearchInputProps } from "./components/SearchInput.js";
export {
  FormField,
  TextInput,
  NumberInput,
  Textarea,
  Select,
  InputGroup,
  InputSuffix,
  UnitSelect,
  type FormFieldProps,
  type TextInputProps,
  type NumberInputProps,
  type TextareaProps,
  type SelectProps,
  type SelectOption
} from "./components/forms.js";
export { EmptyState, type EmptyStateProps } from "./components/EmptyState.js";
export { InlineNotice, type InlineNoticeProps } from "./components/InlineNotice.js";
export {
  ToastContainer,
  ToastMessage,
  DEFAULT_TOAST_DURATION_MS,
  type ToastData,
  type ToastMessageProps,
  type ToastContainerProps,
  type ToastTone
} from "./components/Toast.js";
export { PropertyList, type PropertyListProps, type PropertyItem } from "./components/PropertyList.js";
export {
  DataTable,
  type DataTableProps,
  type DataTableColumn,
  type CellContent
} from "./components/DataTable.js";

export { cx } from "./lib/cx.js";
export { badgeTone, type StatusTone, type BadgeVariant } from "./lib/types.js";
export { fonts } from "./fonts.js";

export * from "./icons/index.js";
export { createIcon, iconBaseProps, iconStrokeProps, type IconProps } from "./icons/factory.js";
