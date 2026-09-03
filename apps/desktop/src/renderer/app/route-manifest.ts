export interface ProductRoute {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly section: "primary" | "drawing" | "cost";
  readonly samplePath: string;
}

export const PRODUCT_ROUTES = [
  { id: "workbench", path: "/", title: "工作台", description: "任务导向首页，聚合进行中的建模任务、待处理事项与最近图纸。", section: "primary", samplePath: "/" },
  { id: "drawings", path: "/drawings", title: "图纸库", description: "搜索、筛选和管理工程图及其版本入口。", section: "primary", samplePath: "/drawings" },
  { id: "drawing-overview", path: "/drawings/:drawingId/revisions/:revisionId/overview", title: "Drawing Workspace · 概览", description: "查看当前图纸版本摘要、最近建模状态与正式模型。", section: "drawing", samplePath: "/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/overview" },
  { id: "drawing-runs", path: "/drawings/:drawingId/revisions/:revisionId/runs", title: "Drawing Workspace · 建模记录", description: "查看当前版本的全部 Modeling Run 历史。", section: "drawing", samplePath: "/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/runs" },
  { id: "drawing-models", path: "/drawings/:drawingId/revisions/:revisionId/models", title: "Drawing Workspace · 模型", description: "查看当前版本生成的历史模型及审核状态。", section: "drawing", samplePath: "/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/models" },
  { id: "model-detail", path: "/drawings/:drawingId/revisions/:revisionId/models/:modelId", title: "Model Detail", description: "查看模型预览、验证结果、审核动作与技术产物。", section: "drawing", samplePath: "/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/models/model-main-m03" },
  { id: "drawing-costs", path: "/drawings/:drawingId/revisions/:revisionId/costs", title: "Drawing Workspace · 成本测算", description: "查看当前版本的历史成本测算报告。", section: "cost", samplePath: "/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/costs" },
  { id: "cost-params", path: "/drawings/:drawingId/revisions/:revisionId/costs/new", title: "成本测算参数确认", description: "确认数量、材料与毛坯参数后创建确定性测算。", section: "cost", samplePath: "/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/costs/new" },
  { id: "cost-report", path: "/drawings/:drawingId/revisions/:revisionId/costs/:reportId", title: "成本测算报告详情", description: "查看版本化成本测算报告及其输入快照。", section: "cost", samplePath: "/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/costs/report-q03" },
  { id: "drawing-memory", path: "/drawings/:drawingId/revisions/:revisionId/memory", title: "Drawing Workspace · 版本记忆", description: "维护当前版本事实与建模反馈。", section: "drawing", samplePath: "/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/memory" },
  { id: "runs", path: "/runs", title: "建模任务", description: "跨图纸查看建模任务、队列与结果状态。", section: "primary", samplePath: "/runs" },
  { id: "run-detail", path: "/runs/:runId", title: "Run Detail · Clarification", description: "查看单次建模执行进度、事件与补充信息表单。", section: "primary", samplePath: "/runs/run-r05" },
  { id: "cost-data", path: "/cost-data", title: "成本数据", description: "管理材料、余量与固定成本的版本化定义。", section: "primary", samplePath: "/cost-data" },
  { id: "settings", path: "/settings", title: "设置", description: "配置本机应用、Agent 连接与运行环境。", section: "primary", samplePath: "/settings" }
] as const satisfies readonly ProductRoute[];

export const DEVELOPMENT_ROUTE = Object.freeze({
  id: "component-spec",
  path: "/component-spec",
  title: "组件规范"
});
