import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const PAGE_SIZE = 20;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const filter = url.searchParams.get("filter") ?? "all";
  const search = url.searchParams.get("q") ?? "";

  const where = {
    shop: session.shop,
    ...(filter !== "all" ? { type: filter } : {}),
    ...(search ? { entity: { contains: search.toLowerCase() } } : {}),
  };

  const [jobs, total] = await Promise.all([
    prisma.job.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
    prisma.job.count({ where }),
  ]);

  return { jobs, total, page, totalPages: Math.ceil(total / PAGE_SIZE), filter, search };
};

export default function AllJobsPage() {
  const { jobs, total, page, totalPages, filter, search } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  const formatDuration = (ms: number | null) => {
    if (!ms) return "—";
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  };

  const formatDate = (d: string | Date) =>
    new Date(d).toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });

  type BadgeTone = "info" | "success" | "critical" | "warning" | "neutral" | "caution";
  const statusColor: Record<string, BadgeTone> = {
    finished: "success",
    failed: "critical",
    processing: "warning",
    pending: "info",
  };

  const pageUrl = (p: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(p));
    return `/app/jobs?${params.toString()}`;
  };

  const filterUrl = (f: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("filter", f);
    params.set("page", "1");
    return `/app/jobs?${params.toString()}`;
  };

  return (
    <s-page heading={`All Jobs (${total})`}>
      {/* Filters */}
      <s-section>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {["all", "export", "import"].map((f) => (
            <a
              key={f}
              href={filterUrl(f)}
              style={{
                display: "inline-block",
                padding: "6px 14px",
                borderRadius: "20px",
                border: "1px solid #c9cccf",
                background: filter === f ? "#005bd3" : "#fff",
                color: filter === f ? "#fff" : "#202223",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: filter === f ? 600 : 400,
                textTransform: "capitalize",
                textDecoration: "none",
              }}
            >
              {f}
            </a>
          ))}
        </div>
      </s-section>

      {/* Jobs List */}
      <s-section>
        {jobs.length === 0 ? (
          <s-paragraph>No jobs found. Start an export or import from the home page.</s-paragraph>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {jobs.map((job) => (
              <a
                key={job.id}
                href={`/app/jobs/${job.id}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto auto",
                  gap: "16px",
                  alignItems: "center",
                  padding: "14px 16px",
                  border: "1px solid #e1e3e5",
                  borderRadius: "8px",
                  cursor: "pointer",
                  background: "#fff",
                  transition: "box-shadow 0.15s",
                  textDecoration: "none",
                  color: "inherit",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.boxShadow =
                    "0 1px 4px rgba(0,0,0,0.12)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.boxShadow = "none";
                }}
              >
                {/* Icon */}
                <span style={{ fontSize: "22px" }}>
                  {job.type === "export" ? "⬇️" : "⬆️"}
                </span>

                {/* Info */}
                <div>
                  <div style={{ fontWeight: 600, fontSize: "14px", textTransform: "capitalize" }}>
                    {job.entity} {job.type}
                  </div>
                  <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                    {formatDate(job.createdAt)} · Duration: {formatDuration(job.durationMs)}
                    {job.inputFileUrl ? ` · ${job.inputFileUrl}` : ""}
                  </div>
                </div>

                {/* Counts */}
                <div style={{ display: "flex", gap: "8px", fontSize: "12px" }}>
                  {job.total > 0 && (
                    <span style={{ color: "#6d7175" }}>{job.total.toLocaleString()} total</span>
                  )}
                  {job.type === "export" && job.exported > 0 && (
                    <span style={{ color: "#0a7040", fontWeight: 600 }}>
                      {job.exported.toLocaleString()} exported
                    </span>
                  )}
                  {job.type === "import" && job.updated > 0 && (
                    <span style={{ color: "#0a7040", fontWeight: 600 }}>
                      {job.updated.toLocaleString()} updated
                    </span>
                  )}
                  {job.failed > 0 && (
                    <span style={{ color: "#d82c0d", fontWeight: 600 }}>
                      {job.failed.toLocaleString()} failed
                    </span>
                  )}
                </div>

                {/* Status */}
                <s-badge tone={statusColor[job.status] ?? "info"}>
                  {job.status}
                </s-badge>
              </a>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            style={{ display: "flex", gap: "8px", justifyContent: "center", marginTop: "16px" }}
          >
            <a
              href={page > 1 ? pageUrl(page - 1) : undefined}
              style={{ padding: "6px 14px", borderRadius: "6px", border: "1px solid #c9cccf", textDecoration: "none", color: "inherit", opacity: page <= 1 ? 0.4 : 1, pointerEvents: page <= 1 ? "none" : "auto" }}
            >
              ← Prev
            </a>
            <span style={{ padding: "6px 10px", fontSize: "13px", color: "#6d7175" }}>
              Page {page} of {totalPages}
            </span>
            <a
              href={page < totalPages ? pageUrl(page + 1) : undefined}
              style={{ padding: "6px 14px", borderRadius: "6px", border: "1px solid #c9cccf", textDecoration: "none", color: "inherit", opacity: page >= totalPages ? 0.4 : 1, pointerEvents: page >= totalPages ? "none" : "auto" }}
            >
              Next →
            </a>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
