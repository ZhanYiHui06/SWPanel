import { CheckIcon } from "@swpanel/ui";

import { SIX_STAGES, stageIndex } from "../status.js";
import type { StageDescriptor } from "../status.js";

export type StageState = "completed" | "active" | "pending";

export interface StageProgressProps {
  /** The last reached user-visible stage (e.g. run.stage or the last StageChanged event). */
  readonly stage: string | null | undefined;
  /** When true, the last reached stage renders as active (RUNNING runs). */
  readonly live?: boolean;
  readonly label?: string;
}

const STATE_TEXT: Readonly<Record<StageState, string>> = {
  completed: "（已完成）",
  active: "（进行中）",
  pending: "（待处理）"
};

function stepState(index: number, reached: number, live: boolean): StageState {
  if (index < reached) return "completed";
  if (index === reached) return live ? "active" : "completed";
  return "pending";
}

/**
 * Six-stage Modeling Run progress indicator (`.stage-progress`).
 * Completed stages render a check dot, the reached stage renders as active when
 * the run is still running, and untouched stages stay pending.
 */
export function StageProgress({ stage, live = false }: StageProgressProps): React.JSX.Element {
  const reached = stageIndex(stage);
  const effectiveReached = reached < 0 ? 0 : reached;

  return (
    <ol className="stage-progress" aria-label="建模执行阶段">
      {SIX_STAGES.map((item: StageDescriptor, index: number) => {
        const state = stepState(index, effectiveReached, live);
        return (
          <li className={`stage-step ${state}`} key={item.key} aria-current={state === "active" ? "step" : undefined}>
            <span className="stage-step-dot" aria-hidden="true">
              {state === "completed" ? (
                <CheckIcon size={12} />
              ) : (
                String(index + 1)
              )}
            </span>
            <span className="stage-step-label">{item.label}</span>
            <span className="sr-only">{STATE_TEXT[state]}</span>
          </li>
        );
      })}
    </ol>
  );
}
