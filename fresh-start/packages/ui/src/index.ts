// Shared design-system components (doc 21). Apps import from here, never by file path.

// ---------------------------------------------------------------- tokens
export { token, toneTriple, STATUS_TONES, BREAKPOINTS, type Tone, type ToneTriple } from './tokens';

// ---------------------------------------------------------------- primitives
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './primitives/Button';
export {
  ButtonLink,
  LinkProvider,
  UiLink,
  type ButtonLinkProps,
  type LinkComponent,
  type UiLinkProps,
} from './primitives/Link';
export {
  CommandButton,
  type CommandButtonProps,
  type CommandProblem,
} from './primitives/CommandButton';
export {
  Checkbox,
  Field,
  Select,
  TextArea,
  TextInput,
  type CheckboxProps,
  type FieldProps,
  type SelectOption,
  type SelectProps,
  type TextAreaProps,
  type TextInputProps,
} from './primitives/Field';
export { ReasonField, type ReasonFieldProps } from './primitives/ReasonField';
export { Icon, ICON_NAMES, type IconName, type IconProps } from './primitives/Icon';
export { ErrorSummary, type ErrorSummaryProps } from './primitives/ErrorSummary';

// ---------------------------------------------------------------- layout
export { AppShell, type AppShellProps, type NavItem } from './layout/AppShell';
export { Card, Page, type CardProps, type PageProps } from './layout/Page';
export { TabBar, type TabBarProps, type TabItem, type TabPrimaryAction } from './layout/TabBar';
export { Hero, type HeroProps } from './layout/Hero';
export { isActivePath } from './layout/paths';
export { Inline, SplitPane, Stack, type InlineProps, type StackProps } from './layout/Stack';

// ---------------------------------------------------------------- data display
export { Callout, type CalloutProps } from './data/Callout';
export { DataTable, type Column, type DataTableProps } from './data/DataTable';
export { DescriptionList, type DescriptionItem } from './data/DescriptionList';
export { Stepper, type Step, type StepState } from './data/Stepper';
export {
  EmptyState,
  ErrorState,
  LoadingState,
  RouteError,
  Skeleton,
  type ErrorStateProps,
  type RouteErrorProps,
} from './data/States';
export { CopyableId, type CopyableIdProps } from './data/CopyableId';
export { FilterChips, type FilterChipOption, type FilterChipsProps } from './data/FilterChips';
export { RecordCard, RecordList, type RecordCardProps } from './data/RecordCard';
export { LiveRegion, type LiveRegionProps } from './feedback/LiveRegion';

// ---------------------------------------------------------------- domain
export { Chip, StatusChip, type StatusChipProps } from './status/StatusChip';
export { ActionNeededCard, type ActionNeededCardProps } from './status/ActionNeededCard';
export { QueueCard, describeAge, type QueueCardProps } from './status/QueueCard';
export { QuickAction, QuickActionGrid, type QuickActionProps } from './status/QuickAction';
export { GateMatrix, type GateMatrixGate, type GateMatrixProps } from './gates/GateMatrix';
export { ManifestHeader, ManifestRow, type ManifestRowProps } from './document/ManifestRow';
export {
  FileUpload,
  formatBytes,
  type FileUploadApi,
  type FileUploadProps,
  type UploadPhase,
  type UploadProblem,
  type VersionState,
} from './upload/FileUpload';
export {
  MeasurementInput,
  UnitSelect,
  type MeasurementInputProps,
  type UnitSelectProps,
} from './forms/MeasurementInput';
export { ChoiceCards, type ChoiceCardOption, type ChoiceCardsProps } from './forms/ChoiceCards';
export {
  formatMoney,
  minorUnitDigits,
  MoneyInput,
  type MoneyInputProps,
  type MoneyValue,
} from './forms/MoneyInput';
