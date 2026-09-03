import { Card, CardBody, CardHeader, CardTitle, StatusBadge } from "@swpanel/ui";
import { useParams } from "react-router-dom";

import type { ProductRoute } from "../app/routes.js";

export interface RoutePlaceholderProps {
  readonly route: ProductRoute;
}

export function RoutePlaceholder({ route }: RoutePlaceholderProps): React.JSX.Element {
  const parameters = useParams();
  const parameterEntries = Object.entries(parameters);

  return (
    <div className="page-content" data-route-id={route.id}>
      <section className="page-header">
        <div className="placeholder-eyebrow">Phase 1 integration shell</div>
        <h1 className="page-header-title">{route.title}</h1>
        <p className="page-header-subtitle">{route.description}</p>
      </section>

      <div className="placeholder-grid">
        <Card>
          <CardHeader>
            <CardTitle>页面路由已接入</CardTitle>
            <StatusBadge variant="completed">可访问</StatusBadge>
          </CardHeader>
          <CardBody>
            <p className="placeholder-copy">
              当前阶段提供稳定的 Electron、Vite、React Router 与共享设计系统集成。
              具体页面视觉和业务交互将在后续实现中替换此占位内容。
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>路由上下文</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className="route-context">
              <div>
                <dt>Route ID</dt>
                <dd>{route.id}</dd>
              </div>
              <div>
                <dt>Pattern</dt>
                <dd>{route.path}</dd>
              </div>
              {parameterEntries.map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
