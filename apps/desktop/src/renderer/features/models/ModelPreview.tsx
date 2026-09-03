/**
 * ModelPreview — the isometric cylinder glyph used by Model cards and the Model
 * Detail preview. Faithful to the inline SVG in `.design/pages/model-detail.html`
 * (roll shape: top ellipse, side walls, base ellipse, inner bore).
 */

export interface ModelPreviewProps {
  readonly modelLabel: string;
  readonly size?: number;
  readonly showLabel?: boolean;
  readonly className?: string;
}

export function ModelPreview({
  modelLabel,
  size = 100,
  showLabel = false,
  className
}: ModelPreviewProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 110 110"
      fill="none"
      className={className}
      role="img"
      aria-label={`${modelLabel} 模型预览`}
    >
      <ellipse cx="55" cy="25" rx="32" ry="10" stroke="#737373" strokeWidth="1.2" fill="#fafafa" />
      <path
        d="M23 25v60c0 5.5 14.3 10 32 10s32-4.5 32-10V25"
        stroke="#737373"
        strokeWidth="1.2"
        fill="#f5f5f5"
      />
      <ellipse cx="55" cy="85" rx="32" ry="10" stroke="#737373" strokeWidth="1.2" fill="none" />
      <ellipse cx="55" cy="25" rx="14" ry="4.5" stroke="#a3a3a3" strokeWidth="1" fill="#fff" />
      <path
        d="M41 25v50c0 2.5 6.3 4.5 14 4.5s14-2 14-4.5V25"
        stroke="#a3a3a3"
        strokeWidth="1"
        fill="none"
      />
      <ellipse cx="55" cy="75" rx="14" ry="4.5" stroke="#a3a3a3" strokeWidth="1" fill="none" />
      {showLabel && <path d="M23 45h64" stroke="#a3a3a3" strokeWidth="0.8" strokeDasharray="2 2" />}
    </svg>
  );
}
