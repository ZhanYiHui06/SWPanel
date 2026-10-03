/**
 * Maps stable business/transport error codes to actionable Simplified Chinese
 * messages. The code is the primary key: server messages may be generic or
 * (on older servers) English, so they are only used when they already read as
 * Chinese and the code is unknown.
 *
 * `HttpTransport` still passes the server message through unchanged; pages call
 * `describeError(error)` to decide what the user sees.
 */

export interface DescribedError {
  /** Chinese, user-facing, with a next step where one exists. */
  readonly message: string;
  /** Stable code, for a secondary "technical details" line. */
  readonly code?: string;
}

const MESSAGES: Readonly<Record<string, string>> = {
  // Transport / environment
  NETWORK_ERROR: "无法连接 SWPanel 服务，请检查网络或确认后端服务已启动后重试",
  INVALID_RESPONSE: "服务返回了无法识别的内容，请刷新页面；若仍然出现，请联系管理员确认前后端版本一致",
  RUNNER_UNAVAILABLE: "未连接到 SWPanel 服务，请确认后端服务已启动",
  BRIDGE_UNAVAILABLE: "未连接到 SWPanel 服务，请确认后端服务已启动",
  RUNNER_NOT_OPEN: "服务尚未就绪，请稍后重试",
  HOST_NOT_ALLOWED: "当前访问地址不被服务允许，请使用管理员提供的地址访问",
  ORIGIN_NOT_ALLOWED: "当前访问来源不被服务允许，请使用管理员提供的地址访问",
  INTERNAL_ERROR: "服务暂时无法完成请求，请稍后重试",
  VERSION_MISMATCH: "前端与服务版本不一致，请刷新页面后重试",
  PROTOCOL_VERSION_MISMATCH: "前端与服务版本不一致，请刷新页面后重试",
  // Generic request problems
  NOT_FOUND: "请求的对象不存在或已被删除，请返回列表刷新后重试",
  ENTITY_CONFLICT: "数据已发生变化或存在冲突，请刷新页面后重试",
  INVALID_ARGUMENT: "提交的内容不符合要求，请检查后重试",
  INVALID_INPUT: "提交的内容不符合要求，请检查后重试",
  INVALID_PAYLOAD: "提交的内容不符合要求，请检查后重试",
  INVALID_REQUEST: "请求无效，请刷新页面后重试",
  INVALID_ENVELOPE: "请求无效，请刷新页面后重试",
  INVALID_JSON: "请求内容无效，请刷新页面后重试",
  UNKNOWN_OPERATION: "该操作当前不可用",
  UNSUPPORTED_PHASE_OPERATION: "该操作当前不可用",
  OPERATION_NOT_AVAILABLE: "该操作不支持通过网页使用",
  DOMAIN_INVARIANT: "当前状态不允许此操作，请刷新页面查看最新状态",
  IDEMPOTENCY_CONFLICT: "同一提交内容已变化，请重新填写后再提交",
  // Uploads
  TOKEN_NOT_FOUND: "上传凭证已过期或已被使用，请重新选择文件",
  UPLOAD_LIMIT: "待导入的图纸过多，请先完成或放弃已选择的文件",
  UPLOAD_BUSY: "正在处理的上传过多，请稍后重试",
  UPLOAD_STORAGE_FULL: "暂存的图纸文件总量已达上限，请先完成导入",
  PAYLOAD_TOO_LARGE: "文件超过大小上限（20 MB），请压缩或拆分后重新上传",
  INVALID_FILE_NAME: "文件名无效：不能包含路径或特殊字符，也不能以点开头，请改名后重试",
  INPUT_UNSUPPORTED: "仅支持 PDF、DWG 和 DXF 格式的图纸",
  FILE_READ_FAILED: "无法读取所选文件，请确认文件未被占用后重新选择",
  FILE_PICKER_FAILED: "无法打开文件选择窗口，请刷新页面后重试",
  FILE_UNAVAILABLE: "文件不可用，请重新上传",
  SSE_LIMIT: "任务事件连接过多，请关闭其他页面后重试",
  // Drawings / revisions
  DRAWING_NUMBER_DUPLICATE: "图号已存在，请更换图号",
  DRAWING_NUMBER_REQUIRED: "请填写图号",
  DRAWING_NAME_REQUIRED: "请填写图纸名称",
  REVISION_HAS_DEPENDENCIES: "该版本已有建模任务、模型或成本报告，不能删除",
  RUN_HAS_PENDING_CLARIFICATION: "该任务还有待补充的信息，处理后才能删除",
  RUN_NOT_TERMINAL: "任务仍在进行中，结束后才能删除",
  SETTINGS_ERROR: "设置内容无效，请检查后重试",
  SETTINGS_IO_ERROR: "服务器无法保存设置，请检查磁盘空间和目录权限",
  // Models / cost
  MODEL_NOT_ELIGIBLE: "该模型不是当前版本的当前已审核模型，不能测算成本",
  MODEL_GEOMETRY_UNAVAILABLE: "已审核模型缺少经过验证的成品体积，暂时无法生成成本报告",
  QUANTITY_INVALID: "数量必须是正整数",
  MATERIAL_NOT_FOUND: "所选材料不在当前成本数据中，请先在成本数据中维护该材料",
  MATERIAL_INVALID: "材料的采购单价、计价单位或密度不完整，请在成本数据中补全",
  STOCK_SPEC_INVALID: "毛坯规格无效，请检查尺寸和单位",
  FIXED_COST_INVALID: "固定成本金额或计费方式无效",
  ALLOWANCE_INVALID: "加工余量必须是非负的毫米数值",
  COST_CALCULATION_INVALID: "成本计算结果无效，请检查输入",
  LEDGER_FILE_MISSING: "文件缺失，无法读取，请联系管理员",
  LEDGER_HASH_MISMATCH: "文件完整性验证失败，请联系管理员",
  LEDGER_SIZE_MISMATCH: "文件完整性验证失败，请联系管理员",
  // Run event stream
  STREAM_UNAVAILABLE: "当前浏览器不支持任务实时更新，请换用新版浏览器",
  STREAM_LOST: "任务实时连接中断，正在重新连接",
  STREAM_RESTARTED: "任务服务已重启，请刷新页面",
  EVENT_GAP: "任务事件不连续，请刷新页面",
  RUN_EVENT_GAP: "任务事件不连续，请刷新页面",
  RUN_EVENT_INVALID: "任务事件无效，请刷新页面",
  RUN_EVENT_STREAM_LOST: "任务实时连接多次中断，请点击重试重新连接",
  RUN_EVENT_STREAM_CLOSED: "任务实时连接已关闭，请刷新页面",
  INVALID_EVENT: "任务事件无效，请刷新页面",
  // Run failure codes
  AGENT_RUNTIME_UNAVAILABLE: "建模代理暂不可用，请联系管理员检查服务端建模配置后重试",
  AGENT_PROTOCOL_INCOMPATIBLE: "建模代理版本不兼容，请联系管理员",
  AGENT_TIMEOUT: "建模超时，请稍后重新发起建模",
  AGENT_INTERRUPTED: "建模被中断，请重新发起建模",
  PREFLIGHT_FAILED: "建模前检查未通过，请联系管理员检查服务端环境",
  INPUT_ADAPTER_FAILED: "图纸无法转换为建模输入，请确认文件完整后重新上传",
  SKILL_NOT_FOUND: "建模技能缺失，请联系管理员",
  SKILL_HASH_MISMATCH: "建模技能校验失败，请联系管理员",
  SOLIDWORKS_UNAVAILABLE: "SolidWorks 不可用，请联系管理员确认服务端已安装并可启动",
  SOLIDWORKS_VERSION_UNSUPPORTED: "SolidWorks 版本不受支持，请联系管理员",
  ARTIFACT_MANIFEST_INVALID: "建模结果无效，请重新发起建模",
  ARTIFACT_MISSING: "建模结果文件缺失，请重新发起建模",
  ARTIFACT_OUTSIDE_WORKSPACE: "建模结果无效，请重新发起建模",
  VALIDATION_REJECTED: "建模结果未通过校验，请补充信息后重新发起建模",
  CANCEL_CLEANUP_PENDING: "任务已取消，正在清理现场，请稍后查看",
  RECOVERY_UNSUPPORTED: "服务重启后该任务无法恢复，请重新发起建模",
  RECOVERY_FAILED: "服务重启后该任务恢复失败，请重新发起建模",
  CLARIFICATION_REQUIRED: "需要补充信息后重新发起建模"
};

const GENERIC_MESSAGE = "操作未能完成，请稍后重试；若问题持续，请联系管理员";
const HAS_CJK = /[㐀-鿿]/;
/** Old servers answered every business failure with this English sentence. */
const LEGACY_GENERIC = /^The requested business operation could not be completed$/;

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

/** Actionable Chinese message for the code alone (undefined when unknown). */
export function messageForErrorCode(code: string): string | undefined {
  return MESSAGES[code];
}

/**
 * Describes any thrown value for display. Known code -> mapped message; unknown
 * code -> the server message when it already reads as Chinese, else a generic
 * Chinese sentence. The code is returned separately as secondary information.
 */
export function describeError(error: unknown): DescribedError {
  const code = readString(error, "code");
  const raw = readString(error, "message") ?? (typeof error === "string" ? error : undefined);
  const mapped = code === undefined ? undefined : MESSAGES[code];
  if (mapped !== undefined) return { message: mapped, ...(code === undefined ? {} : { code }) };
  const message = raw !== undefined && HAS_CJK.test(raw) && !LEGACY_GENERIC.test(raw) ? raw : GENERIC_MESSAGE;
  return { message, ...(code === undefined ? {} : { code }) };
}
