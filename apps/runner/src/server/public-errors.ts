/**
 * Public (HTTP-visible) business error surface.
 *
 * Handler errors carry technical English messages that may embed ids or server
 * paths, so the Web layer never forwards `message`. It forwards a STABLE CODE
 * plus a fixed Chinese message looked up from this table. Fine-grained codes are
 * derived from an explicit `CODE: ` message prefix (preferred convention for new
 * errors) or from the known message shapes below; everything else keeps its
 * coarse RunnerError code.
 */

/** code -> fixed, path-free, user-facing message. */
const PUBLIC_MESSAGES: Readonly<Record<string, string>> = {
  // Coarse RunnerError codes
  NOT_FOUND: "请求的对象不存在或已被删除",
  ENTITY_CONFLICT: "数据已发生变化或存在冲突，请刷新后重试",
  INVALID_ARGUMENT: "提交的内容不符合要求，请检查后重试",
  DOMAIN_INVARIANT: "当前状态不允许此操作",
  // Fine-grained business codes
  DRAWING_NUMBER_DUPLICATE: "图号已存在，请更换图号",
  DRAWING_NUMBER_REQUIRED: "请填写图号",
  DRAWING_NAME_REQUIRED: "请填写图纸名称",
  MODEL_GEOMETRY_UNAVAILABLE: "已审核模型缺少经过验证的成品体积，暂时无法生成成本报告",
  MODEL_NOT_ELIGIBLE: "该模型不是当前版本的当前已审核模型，不能测算成本",
  QUANTITY_INVALID: "数量必须是正整数",
  MATERIAL_NOT_FOUND: "所选材料不在当前成本数据中",
  MATERIAL_INVALID: "材料的采购单价、计价单位或密度不完整",
  STOCK_SPEC_INVALID: "毛坯规格无效，请检查尺寸和单位",
  FIXED_COST_INVALID: "固定成本金额或计费方式无效",
  ALLOWANCE_INVALID: "加工余量必须是非负的毫米数值",
  COST_CALCULATION_INVALID: "成本计算结果无效，请检查输入",
  // Integrity / storage (messages stay generic; codes stay stable)
  LEDGER_FILE_MISSING: "文件缺失，无法读取",
  LEDGER_HASH_MISMATCH: "文件完整性验证失败",
  LEDGER_SIZE_MISMATCH: "文件完整性验证失败",
  RUNNER_NOT_OPEN: "服务尚未就绪，请稍后重试",
  UNSUPPORTED_PHASE_OPERATION: "该操作当前不可用",
  INTERNAL_ERROR: "服务暂时无法完成请求，请稍后重试"
};
const GENERIC_MESSAGE = "操作未能完成，请检查输入后重试";

/** Messages (from the services) that identify a more specific, safe-to-publish reason. */
const MESSAGE_RULES: ReadonlyArray<readonly [RegExp, string, string?]> = [
  [/^A Drawing with number .* already exists$/s, "DRAWING_NUMBER_DUPLICATE", "ENTITY_CONFLICT"],
  [/^drawingNumber must be a non-empty string$/, "DRAWING_NUMBER_REQUIRED", "INVALID_ARGUMENT"],
  [/^name must be a non-empty string$/, "DRAWING_NAME_REQUIRED", "INVALID_ARGUMENT"],
  [/is not eligible for Cost Estimate Report generation/, "MODEL_NOT_ELIGIBLE", "INVALID_ARGUMENT"],
  [/is not the current approved model for Revision/, "MODEL_NOT_ELIGIBLE", "INVALID_ARGUMENT"],
  [/^Quantity must be a positive integer$/, "QUANTITY_INVALID", "INVALID_ARGUMENT"],
  [/^Material is not present in the current company cost data$/, "MATERIAL_NOT_FOUND", "INVALID_ARGUMENT"],
  [/^Material requires a valid purchase price/, "MATERIAL_INVALID", "INVALID_ARGUMENT"],
  [/^Stock (type is invalid|specification requires|dimensions must)/, "STOCK_SPEC_INVALID", "INVALID_ARGUMENT"],
  [/^Enabled fixed costs require/, "FIXED_COST_INVALID", "INVALID_ARGUMENT"],
  [/^Company machining allowances must be/, "ALLOWANCE_INVALID", "INVALID_ARGUMENT"],
  [/^Cost calculation overflowed/, "COST_CALCULATION_INVALID", "INVALID_ARGUMENT"]
];
const PREFIX_CODE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):/;

export interface PublicError { code: string; message: string }

/** Maps a handler error ({code, message}) to its public form. Never returns the original message. */
export function toPublicError(error: { code: string; message: string }): PublicError {
  const prefixed = PREFIX_CODE.exec(error.message)?.[1];
  if (prefixed !== undefined) return { code: prefixed, message: PUBLIC_MESSAGES[prefixed] ?? GENERIC_MESSAGE };
  for (const [pattern, code, onlyFor] of MESSAGE_RULES) {
    if ((onlyFor === undefined || onlyFor === error.code) && pattern.test(error.message)) {
      return { code, message: PUBLIC_MESSAGES[code]! };
    }
  }
  return { code: error.code, message: PUBLIC_MESSAGES[error.code] ?? GENERIC_MESSAGE };
}
