import { EmptyState } from "@swpanel/ui";
import { Link } from "react-router-dom";

/** 404 page for unknown hash routes. */
export function NotFoundPage(): React.JSX.Element {
  return (
    <div className="page-content" data-route-id="not-found">
      <section className="page-header">
        <h1 className="page-header-title">页面不存在</h1>
        <p className="page-header-subtitle">请求的地址没有对应的页面，可能链接已过期或输入有误。</p>
      </section>
      <EmptyState
        title="找不到该页面"
        description="请返回工作台或图纸列表继续操作。"
        action={
          <span className="inline-actions">
            <Link to="/" className="btn btn-primary btn-sm">返回工作台</Link>{" "}
            <Link to="/drawings" className="btn btn-secondary btn-sm">前往图纸列表</Link>
          </span>
        }
      />
    </div>
  );
}

export default NotFoundPage;
