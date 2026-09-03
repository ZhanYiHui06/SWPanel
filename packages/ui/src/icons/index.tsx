import { createIcon } from "./factory.js";

/**
 * SWPanel 16px thin-stroke icon set.
 *
 * Matches the effective inline prototype style: 16x16 viewBox, `fill="none"`,
 * `stroke="currentColor"`, stroke-width 1.3, round caps/joins (see the inline
 * SVGs across `.design/pages/*.html`). A few glyphs intentionally keep the
 * prototype's filled shapes (Play, MoreHorizontal, grid navigation icons).
 */

const S = {
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const
};

/** Primary navigation — 工作台 (home) */
export const HomeIcon = createIcon(
  <>
    <path {...S} d="M2 6.5L8 2l6 4.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6.5z" />
    <path {...S} d="M6 14V8h4v6" />
  </>
);

/** Primary navigation — 图纸库 (drawing file) */
export const FileIcon = createIcon(
  <>
    <path {...S} d="M3 2.5h7l3 3V13.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
    <path {...S} d="M10 2.5v3h3" />
    <path {...S} d="M5 8h6M5 10.5h4" />
  </>
);

/** Primary navigation — 建模任务 (grid of tasks) */
export const GridIcon = createIcon(
  <>
    <rect x="2" y="2" width="5" height="5" rx="1" {...S} />
    <rect x="9" y="2" width="5" height="5" rx="1" {...S} />
    <rect x="2" y="9" width="5" height="5" rx="1" {...S} />
    <rect x="9" y="9" width="5" height="5" rx="1" {...S} />
  </>
);

/** Primary navigation — 成本数据 (currency / yuan) */
export const CostIcon = createIcon(
  <>
    <path {...S} d="M8 1v14M3.5 5h9M4.5 8h7M5.5 11h5" />
  </>
);

/** Footer navigation — 设置 (gear) */
export const SettingsIcon = createIcon(
  <>
    <circle cx="8" cy="8" r="2.25" {...S} />
    <path {...S} d="M8 2.5a5.5 5.5 0 0 0-4.8 2.85M2.8 9.15A5.5 5.5 0 0 0 8 13.5M13.2 9.15A5.5 5.5 0 0 0 8 2.5" />
  </>
);

/** Topbar — 通知 (bell) */
export const BellIcon = createIcon(
  <path
    {...S}
    d="M8 2a4 4 0 0 0-4 4v2.5L2.5 10.5h11L12 8.5V6a4 4 0 0 0-4-4zM6.5 12.5a1.5 1.5 0 0 0 3 0"
  />
);

/** Overflow menu (three filled dots) */
export const MoreHorizontalIcon = createIcon(
  <>
    <circle cx="8" cy="3.5" r="1" fill="currentColor" />
    <circle cx="8" cy="8" r="1" fill="currentColor" />
    <circle cx="8" cy="12.5" r="1" fill="currentColor" />
  </>
);

/** Generic additive action — plus */
export const PlusIcon = createIcon(
  <path {...S} d="M8 1.5v13M1.5 8h13" />
);

/** Generic destructive-ish action — minus */
export const MinusIcon = createIcon(
  <path {...S} d="M2 8h12" />
);

/** Chevron — down */
export const ChevronDownIcon = createIcon(
  <path {...S} d="M4 6l4 4 4-4" />
);

/** Chevron — up */
export const ChevronUpIcon = createIcon(
  <path {...S} d="M4 10l4-4 4 4" />
);

/** Chevron — right */
export const ChevronRightIcon = createIcon(
  <path {...S} d="M6 4l4 4-4 4" />
);

/** Chevron — left */
export const ChevronLeftIcon = createIcon(
  <path {...S} d="M10 4l-4 4 4 4" />
);

/** Search — magnifier */
export const SearchIcon = createIcon(
  <>
    <circle cx="7" cy="7" r="4.5" {...S} />
    <path {...S} d="M10.5 10.5L14 14" />
  </>
);

/** Close — x */
export const CloseIcon = createIcon(
  <path {...S} d="M4 4l8 8M12 4l-8 8" />
);

/** Info — circled i */
export const InfoIcon = createIcon(
  <>
    <circle cx="8" cy="8" r="6.5" {...S} />
    <path {...S} d="M8 7v3.5M8 5v.01" />
  </>
);

/** Warning — triangle alert */
export const WarningIcon = createIcon(
  <>
    <path {...S} d="M8 2l6 11H2L8 2z" />
    <path {...S} d="M8 7v2.5M8 11.5v.01" />
  </>
);

/** Success — circled check */
export const SuccessIcon = createIcon(
  <>
    <circle cx="8" cy="8" r="6.5" {...S} />
    <path {...S} d="M5.5 8l1.8 1.8L10.5 6.5" />
  </>
);

/** Error — circled x */
export const ErrorIcon = createIcon(
  <>
    <circle cx="8" cy="8" r="6.5" {...S} />
    <path {...S} d="M6 6l4 4M10 6l-4 4" />
  </>
);

/** Plain checkmark */
export const CheckIcon = createIcon(
  <path {...S} d="M3 8l3.5 3.5L13 5" />
);

/** Question — circled question mark */
export const QuestionIcon = createIcon(
  <>
    <circle cx="8" cy="8" r="6.5" {...S} />
    <path {...S} d="M6.3 6.3a1.8 1.8 0 1 1 2.6 1.7c-.9.5-1 .8-.9 1.5M8 11.5v.01" />
  </>
);

/** Play — filled triangle (prototype uses a filled glyph) */
export const PlayIcon = createIcon(
  <path d="M3.5 2l7 5-7 5V2z" fill="currentColor" />
);

/** Upload — arrow into tray */
export const UploadIcon = createIcon(
  <>
    <path {...S} d="M7 1v8m0 0l-3-3m3 3l3-3M1 13h12" />
  </>
);

/** Download — arrow out of tray */
export const DownloadIcon = createIcon(
  <>
    <path {...S} d="M8 15V7m0 0L5 10m3-3l3 3M1 13h12" />
  </>
);

/** Open in external app */
export const ExternalLinkIcon = createIcon(
  <>
    <path {...S} d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M10 2h4v4M13.5 2.5L8 8" />
  </>
);

/** Folder */
export const FolderIcon = createIcon(
  <>
    <path {...S} d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z" />
    <path {...S} d="M2 7h12" />
  </>
);

/** Clock */
export const ClockIcon = createIcon(
  <>
    <circle cx="8" cy="8" r="6.25" {...S} />
    <path {...S} d="M8 4.5V8l2.25 1.5" />
  </>
);

/** Box / package */
export const PackageIcon = createIcon(
  <>
    <path {...S} d="M8 2l6 3.75v4.5L8 14l-6-3.75v-4.5L8 2z" />
    <path {...S} d="M2 5.75L8 9l6-3.25M8 9v5" />
  </>
);

/** Layers — used as the empty-state model glyph */
export const LayersIcon = createIcon(
  <>
    <path {...S} d="M8 2.5l5.5 3.25v4.5L8 13.5l-5.5-3.25v-4.5L8 2.5z" />
    <path {...S} d="M2.5 5.75L8 9l5.5-3.25M8 9v4.5" />
  </>
);

/** Message circle */
export const MessageCircleIcon = createIcon(
  <path
    {...S}
    d="M8 2.5a5.5 5.5 0 0 0-4.8 8.2L2 14l3.4-1.1A5.5 5.5 0 1 0 8 2.5z"
  />
);

/** User */
export const UserIcon = createIcon(
  <>
    <circle cx="8" cy="6" r="2.75" {...S} />
    <path {...S} d="M3 14a5 5 0 0 1 10 0" />
  </>
);

/** Filter / funnel */
export const FunnelIcon = createIcon(
  <path {...S} d="M2 3h12l-4.5 5v4l-3 2V8L2 3z" />
);

/** Trash */
export const TrashIcon = createIcon(
  <>
    <path {...S} d="M5 2h6a1 1 0 0 1 1 1v1H4V3a1 1 0 0 1 1-1z" />
    <path {...S} d="M6.5 6.5v5M9.5 6.5v5M4 5h8l-.55 7.9a1 1 0 0 1-1 .9H5.55a1 1 0 0 1-1-.9L4 5z" />
  </>
);

/** Heart */
export const HeartIcon = createIcon(
  <path {...S} d="M8 13.5C5.5 11.8 2.5 9.9 2.5 6.5A3 3 0 0 1 8 4.7a3 3 0 0 1 5.5 1.8c0 3.4-3 5.3-5.5 7z" />
);
