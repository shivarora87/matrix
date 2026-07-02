import { useState, useEffect, useRef } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLANS, PLAN_LIMITS } from "../plans";
import prisma from "../db.server";
import { runExportJob, type ExportFilters } from "../engine/export.server";
import { runImportJob } from "../engine/import.server";

type BadgeTone = "info" | "success" | "critical" | "warning" | "neutral" | "caution";

const STATUS_TONE: Record<string, BadgeTone> = {
  finished: "success", failed: "critical", processing: "warning", pending: "info",
};

// ─── Entity definitions ────────────────────────────────────────────────────

const EXPORT_ENTITIES = [
  { value: "products",         label: "Products" },
  { value: "customers",        label: "Customers" },
  { value: "orders",           label: "Orders" },
  { value: "collections",      label: "Custom Collections" },
  { value: "smart_collections",label: "Smart Collections" },
  { value: "inventory",        label: "Inventory" },
  { value: "draft_orders",     label: "Draft Orders" },
  { value: "discounts",        label: "Discounts" },
  { value: "pages",            label: "Pages" },
  { value: "blog_posts",       label: "Blog Posts" },
  { value: "redirects",        label: "Redirects" },
  { value: "metafields",       label: "Product Metafields" },
];

const IMPORT_ENTITIES = [
  { value: "products",         label: "Products" },
  { value: "customers",        label: "Customers" },
  { value: "collections",      label: "Custom Collections" },
  { value: "smart_collections",label: "Smart Collections" },
  { value: "inventory",        label: "Inventory" },
  { value: "draft_orders",     label: "Draft Orders" },
  { value: "discounts",        label: "Discounts" },
  { value: "pages",            label: "Pages" },
  { value: "blog_posts",       label: "Blog Posts" },
  { value: "redirects",        label: "Redirects" },
  { value: "metafields",       label: "Product Metafields" },
  { value: "orders",           label: "Orders (tag updates only)" },
];

// ─── Loader ────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);

  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: [PLANS.BASIC, PLANS.BIG, PLANS.ENTERPRISE],
    isTest: true,
  }).catch(() => ({ hasActivePayment: false, appSubscriptions: [] as Array<{ name: string }> }));

  const currentPlan: string = hasActivePayment && appSubscriptions.length > 0
    ? appSubscriptions[0].name
    : PLANS.FREE;

  const recentJobs = await prisma.job.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  return { recentJobs, currentPlan, planLimits: PLAN_LIMITS[currentPlan] };
};

// ─── Action ────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const accessToken = session.accessToken!;

  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: [PLANS.BASIC, PLANS.BIG, PLANS.ENTERPRISE],
    isTest: true,
  }).catch(() => ({ hasActivePayment: false, appSubscriptions: [] as Array<{ name: string }> }));

  const currentPlan: string = hasActivePayment && appSubscriptions.length > 0
    ? appSubscriptions[0].name
    : PLANS.FREE;

  const contentType = request.headers.get("content-type") ?? "";

  // ── File upload import ──
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const entity = String(formData.get("entity") ?? "customers");

    if (!file || file.size === 0) return { error: "No file uploaded" };

    const buffer = Buffer.from(await file.arrayBuffer());
    const job = await prisma.job.create({
      data: {
        shop: session.shop, type: "import", entity, status: "pending",
        format: file.name.endsWith(".csv") ? "csv" : "excel",
        inputFileUrl: file.name,
      },
    });
    setImmediate(() => runImportJob(job.id, session.shop, accessToken, buffer, file.name).catch(console.error));
    return { jobId: job.id, type: "import" };
  }

  const body = (await request.json()) as {
    entity?: string;
    filters?: ExportFilters;
    url?: string;
    importEntity?: string;
  };

  // ── URL-based import ──
  if (body.url) {
    const importEntity = body.importEntity ?? "products";
    let buffer: Buffer;
    let filename: string;
    try {
      const r = await fetch(body.url);
      if (!r.ok) return { error: `Failed to fetch URL: ${r.status} ${r.statusText}` };
      buffer = Buffer.from(await r.arrayBuffer());
      filename = new URL(body.url).pathname.split("/").pop() ?? "import.xlsx";
    } catch (e) {
      return { error: `Could not fetch URL: ${e instanceof Error ? e.message : "Unknown error"}` };
    }

    const job = await prisma.job.create({
      data: {
        shop: session.shop, type: "import", entity: importEntity, status: "pending",
        format: filename.endsWith(".csv") ? "csv" : "excel",
        inputFileUrl: body.url,
      },
    });
    setImmediate(() => runImportJob(job.id, session.shop, accessToken, buffer, filename).catch(console.error));
    return { jobId: job.id, type: "import" };
  }

  // ── Export ──
  const entity = body.entity ?? "products";
  const filters = body.filters;

  const job = await prisma.job.create({
    data: {
      shop: session.shop, type: "export", entity, status: "pending", format: "excel",
      config: filters ? JSON.stringify({ filters }) : null,
    },
  });
  setImmediate(() => runExportJob(job.id, session.shop, accessToken, filters).catch(console.error));
  return { jobId: job.id, type: "export" };
};

// ─── Component ─────────────────────────────────────────────────────────────

export default function HomePage() {
  const { recentJobs, currentPlan, planLimits } = useLoaderData<typeof loader>();
  const exportFetcher = useFetcher<typeof action>();
  const importFetcher = useFetcher<typeof action>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedEntity, setSelectedEntity] = useState("products");
  const [importEntity, setImportEntity] = useState("products");
  const [showExportForm, setShowExportForm] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [importMode, setImportMode] = useState<"file" | "url">("file");
  const [importUrl, setImportUrl] = useState("");

  // Export filter state
  const [filterStatus, setFilterStatus] = useState("");
  const [filterVendor, setFilterVendor] = useState("");
  const [filterTags, setFilterTags] = useState("");
  const [filterUpdatedAfter, setFilterUpdatedAfter] = useState("");
  const [filterUpdatedBefore, setFilterUpdatedBefore] = useState("");
  const [filterQuery, setFilterQuery] = useState("");

  const isExporting = exportFetcher.state !== "idle";
  const isImporting = importFetcher.state !== "idle";

  useEffect(() => {
    const data = exportFetcher.data;
    if (data && "jobId" in data) {
      setShowExportForm(false);
      window.location.href = `/app/jobs/${data.jobId}`;
    }
  }, [exportFetcher.data]);

  useEffect(() => {
    const data = importFetcher.data;
    if (data && "jobId" in data) {
      window.location.href = `/app/jobs/${data.jobId}`;
    }
  }, [importFetcher.data]);

  const buildFilters = (): ExportFilters | undefined => {
    const f: ExportFilters = {};
    if (filterStatus) f.status = filterStatus;
    if (filterVendor) f.vendor = filterVendor;
    if (filterTags) f.tags = filterTags;
    if (filterUpdatedAfter) f.updatedAfter = filterUpdatedAfter;
    if (filterUpdatedBefore) f.updatedBefore = filterUpdatedBefore;
    if (filterQuery) f.query = filterQuery;
    return Object.keys(f).length > 0 ? f : undefined;
  };

  const startExport = () => {
    const exportPayload = { entity: selectedEntity, filters: buildFilters() ?? null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exportFetcher.submit(exportPayload as any, { method: "POST", encType: "application/json" });
  };

  const handleFileUpload = (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("entity", importEntity);
    importFetcher.submit(formData, { method: "POST", encType: "multipart/form-data" });
  };

  const handleUrlImport = () => {
    if (!importUrl.trim()) return;
    const urlPayload = { url: importUrl.trim(), importEntity };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    importFetcher.submit(urlPayload as any, { method: "POST", encType: "application/json" });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  };

  const formatDuration = (ms: number | null) => {
    if (!ms) return "";
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  };

  const formatDate = (d: string | Date) =>
    new Date(d).toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });

  const inputStyle = {
    padding: "7px 10px",
    border: "1px solid #c9cccf",
    borderRadius: "6px",
    fontSize: "13px",
  };

  const planLimitNote = planLimits[selectedEntity] < Infinity
    ? `Free plan: up to ${planLimits[selectedEntity]} rows per export. `
    : "";

  const showStatusFilter = ["products", "customers", "orders", "pages", "blog_posts", "discounts"].includes(selectedEntity);
  const showVendorFilter = selectedEntity === "products";

  return (
    <s-page heading="Excel Import / Export">

      {/* Plan banner */}
      {currentPlan === PLANS.FREE && (
        <div style={{ padding: "12px 16px", background: "#fff3cd", borderRadius: "8px",
          border: "1px solid #ffc107", marginBottom: "16px", display: "flex",
          justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
          <span style={{ fontSize: "13px" }}>
            <strong>Free plan</strong> — limited to 10 rows per job.
            Upgrade for full store exports.
          </span>
          <a href="/app/billing" style={{ fontSize: "13px", fontWeight: 600, color: "#005bd3",
            textDecoration: "none", whiteSpace: "nowrap" }}>
            View plans →
          </a>
        </div>
      )}

      {/* ── Export ── */}
      <s-section heading="Export">
        <s-paragraph>
          Select a data type to export your store data as an Excel file.
          {planLimitNote && <span style={{ color: "#916a00" }}> {planLimitNote}</span>}
        </s-paragraph>

        {showExportForm ? (
          <s-stack direction="block" gap="base">
            {/* Entity selector */}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "13px", fontWeight: 600 }}>Data to export</label>
              <select
                value={selectedEntity}
                onChange={(e) => setSelectedEntity(e.target.value)}
                style={{ ...inputStyle, minWidth: "240px" }}
              >
                {EXPORT_ENTITIES.map((e) => (
                  <option key={e.value} value={e.value}>{e.label}</option>
                ))}
              </select>
            </div>

            {/* Filter toggle */}
            <div>
              <button
                onClick={() => setShowFilters(!showFilters)}
                style={{ fontSize: "13px", color: "#005bd3", background: "none", border: "none",
                  cursor: "pointer", padding: 0, textDecoration: "underline" }}
              >
                {showFilters ? "▲ Hide filters" : "▼ Add filters (optional)"}
              </button>
            </div>

            {showFilters && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                gap: "12px", padding: "14px", background: "#f6f6f7", borderRadius: "8px",
                border: "1px solid #e1e3e5" }}>
                {showStatusFilter && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <label style={{ fontSize: "12px", fontWeight: 600 }}>Status</label>
                    <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={inputStyle}>
                      <option value="">Any</option>
                      <option value="active">Active</option>
                      <option value="draft">Draft</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>
                )}
                {showVendorFilter && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <label style={{ fontSize: "12px", fontWeight: 600 }}>Vendor</label>
                    <input type="text" value={filterVendor}
                      onChange={(e) => setFilterVendor(e.target.value)}
                      placeholder="e.g. Nike" style={inputStyle} />
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={{ fontSize: "12px", fontWeight: 600 }}>Tag</label>
                  <input type="text" value={filterTags}
                    onChange={(e) => setFilterTags(e.target.value)}
                    placeholder="e.g. sale" style={inputStyle} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={{ fontSize: "12px", fontWeight: 600 }}>Updated after</label>
                  <input type="date" value={filterUpdatedAfter}
                    onChange={(e) => setFilterUpdatedAfter(e.target.value)} style={inputStyle} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={{ fontSize: "12px", fontWeight: 600 }}>Updated before</label>
                  <input type="date" value={filterUpdatedBefore}
                    onChange={(e) => setFilterUpdatedBefore(e.target.value)} style={inputStyle} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
                  <label style={{ fontSize: "12px", fontWeight: 600 }}>Custom Shopify query</label>
                  <input type="text" value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    placeholder='e.g. tag:sale vendor:"Nike"' style={{ ...inputStyle, width: "100%" }} />
                </div>
              </div>
            )}

            <s-stack direction="inline" gap="base">
              <s-button onClick={startExport} {...(isExporting ? { loading: true } : {})}>
                {isExporting ? "Starting..." : "Start Export"}
              </s-button>
              <s-button variant="secondary" onClick={() => { setShowExportForm(false); setShowFilters(false); }}>
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        ) : (
          <s-button onClick={() => setShowExportForm(true)}>New Export</s-button>
        )}
      </s-section>

      {/* ── Import ── */}
      <s-section heading="Import">
        <s-paragraph>
          Upload an Excel (.xlsx) or CSV file — or paste a URL — to create or update store data.
        </s-paragraph>

        <s-stack direction="block" gap="base">
          {/* Entity selector */}
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <label style={{ fontSize: "13px", fontWeight: 600 }}>Import into</label>
            <select value={importEntity} onChange={(e) => setImportEntity(e.target.value)}
              style={{ ...inputStyle, width: "fit-content" }}>
              {IMPORT_ENTITIES.map((e) => (
                <option key={e.value} value={e.value}>{e.label}</option>
              ))}
            </select>
          </div>

          {/* Import mode toggle */}
          <div style={{ display: "flex", gap: "4px" }}>
            {(["file", "url"] as const).map((mode) => (
              <button key={mode} onClick={() => setImportMode(mode)}
                style={{ padding: "6px 14px", borderRadius: "20px", border: "1px solid #c9cccf",
                  background: importMode === mode ? "#005bd3" : "#fff",
                  color: importMode === mode ? "#fff" : "#202223",
                  cursor: "pointer", fontSize: "13px", fontWeight: importMode === mode ? 600 : 400 }}>
                {mode === "file" ? "📁 File upload" : "🔗 From URL"}
              </button>
            ))}
          </div>

          {/* File upload */}
          {importMode === "file" && (
            <div
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onClick={() => fileInputRef.current?.click()}
              style={{ border: `2px dashed ${dragOver ? "#005bd3" : "#c9cccf"}`,
                borderRadius: "8px", padding: "40px 24px", textAlign: "center",
                cursor: "pointer", background: dragOver ? "#f0f5ff" : "#fafafa", transition: "all 0.2s" }}
            >
              {isImporting ? (
                <s-paragraph>Uploading and processing...</s-paragraph>
              ) : (
                <>
                  <div style={{ fontSize: "32px", marginBottom: "8px" }}>📂</div>
                  <s-paragraph><strong>Drop a file here</strong> or click to browse</s-paragraph>
                  <s-paragraph>Supports .xlsx, .xls, .csv</s-paragraph>
                </>
              )}
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileUpload(file);
                  e.target.value = "";
                }} />
            </div>
          )}

          {/* URL import */}
          {importMode === "url" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "13px", fontWeight: 600 }}>File URL</label>
                <input
                  type="url"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="https://example.com/products.xlsx"
                  style={{ ...inputStyle, width: "100%", maxWidth: "480px" }}
                  onKeyDown={(e) => e.key === "Enter" && handleUrlImport()}
                />
                <span style={{ fontSize: "12px", color: "#6d7175" }}>
                  Must be a publicly accessible URL to an .xlsx, .xls, or .csv file
                </span>
              </div>
              <s-button
                onClick={handleUrlImport}
                {...(isImporting ? { loading: true } : {})}
                {...(!importUrl.trim() ? { disabled: true } : {})}
              >
                {isImporting ? "Fetching..." : "Import from URL"}
              </s-button>
            </div>
          )}

          {importFetcher.data && "error" in importFetcher.data && (
            <span style={{ color: "#d82c0d", fontSize: "14px" }}>
              {importFetcher.data.error as string}
            </span>
          )}
        </s-stack>
      </s-section>

      {/* ── Recent Jobs ── */}
      {recentJobs.length > 0 && (
        <s-section heading="Recent Jobs">
          <s-stack direction="block" gap="small-100">
            {recentJobs.map((job) => (
              <a key={job.id} href={`/app/jobs/${job.id}`}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "12px 16px", border: "1px solid #e1e3e5", borderRadius: "8px",
                  cursor: "pointer", background: "#fff", textDecoration: "none", color: "inherit" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <span style={{ fontSize: "20px" }}>{job.type === "export" ? "⬇️" : "⬆️"}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "14px", textTransform: "capitalize" }}>
                      {job.entity.replace("_", " ")} — {job.type}
                    </div>
                    <div style={{ fontSize: "12px", color: "#6d7175" }}>
                      {formatDate(job.createdAt)}
                      {job.durationMs ? ` · ${formatDuration(job.durationMs)}` : ""}
                      {job.total > 0 ? ` · ${job.total.toLocaleString()} rows` : ""}
                    </div>
                  </div>
                </div>
                <s-badge tone={STATUS_TONE[job.status] ?? "info"}>{job.status}</s-badge>
              </a>
            ))}
          </s-stack>
          <div style={{ marginTop: "12px" }}>
            <a href="/app/jobs" style={{ color: "#005bd3", textDecoration: "none", fontSize: "14px" }}>
              View all jobs →
            </a>
          </div>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
