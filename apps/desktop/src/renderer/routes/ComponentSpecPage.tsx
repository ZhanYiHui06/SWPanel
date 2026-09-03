import { Button, Card, CardBody, CardHeader, CardTitle, InlineNotice, StatusBadge } from "@swpanel/ui";

export function ComponentSpecPage(): React.JSX.Element {
  return (
    <div className="page-content" data-route-id="component-spec">
      <section className="page-header">
        <div className="placeholder-eyebrow">Development only</div>
        <h1 className="page-header-title">组件规范</h1>
        <p className="page-header-subtitle">共享组件快速检查页，不属于生产产品路由。</p>
      </section>
      <Card>
        <CardHeader>
          <CardTitle>基础组件</CardTitle>
          <StatusBadge variant="running">DEV</StatusBadge>
        </CardHeader>
        <CardBody>
          <div className="component-row">
            <Button variant="primary">主要操作</Button>
            <Button>次要操作</Button>
            <StatusBadge variant="completed">已完成</StatusBadge>
            <StatusBadge variant="failed">失败</StatusBadge>
          </div>
          <InlineNotice tone="info" title="开发路由">
            生产构建不会注册 /component-spec。
          </InlineNotice>
        </CardBody>
      </Card>
    </div>
  );
}
