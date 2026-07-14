import { createServer } from "node:http";

const projects = [
  {
    id: "project-1",
    name: "商城平台",
    description: "电商业务主项目",
    children: [
      { id: "project-1-web", name: "商城 Web", description: "面向用户的 Web 前端" },
      { id: "project-1-api", name: "商城 API", description: "订单与商品服务" },
    ],
  },
  {
    id: "project-2",
    name: "运营后台",
    description: "内部运营与审核工具",
    children: [
      { id: "project-2-console", name: "管理控制台", description: "运营管理界面" },
      { id: "project-2-report", name: "数据报表", description: "业务指标与导出" },
    ],
  },
  {
    id: "project-3",
    name: "基础设施",
    description: "公共工程与发布设施",
    children: [
      { id: "project-3-ci", name: "持续集成", description: "测试与构建流水线" },
      { id: "project-3-observe", name: "可观测平台", description: "日志、指标与告警" },
    ],
  },
  { id: "project-4", name: "移动应用", description: "iOS 与 Android 客户端" },
  { id: "project-5", name: "客户门户", description: "客户自助服务门户" },
];

function matches(project, query) {
  if (!query) return true;
  const value = query.toLocaleLowerCase();
  return [project.id, project.name, project.description, ...(project.children ?? []).flatMap(child => [child.id, child.name, child.description])]
    .some(field => field?.toLocaleLowerCase().includes(value));
}

function integer(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function json(response, status, body) {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

const host = process.env.HOST ?? "127.0.0.1";
const port = integer(process.env.PORT, 3000, 65535);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-origin": "*",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/projects") {
    const query = (url.searchParams.get("q") ?? "").trim();
    const page = integer(url.searchParams.get("page"), 1);
    const limit = integer(url.searchParams.get("limit"), 2, 50);
    const filtered = projects.filter(project => matches(project, query));
    const start = (page - 1) * limit;
    json(response, 200, {
      payload: {
        rows: filtered.slice(start, start + limit),
        total: filtered.length,
      },
      meta: { page, limit, query },
    });
    return;
  }

  json(response, 404, { error: "Not found" });
});

server.listen(port, host, () => {
  console.log(`Mock project API listening at http://${host}:${port}`);
  console.log(`Projects endpoint: http://${host}:${port}/api/projects?page=1&limit=2`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
