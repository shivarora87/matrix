import { useEffect, useRef, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import path from "path";
import { useLoaderData, useRouteError, isRouteErrorResponse } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const job = await prisma.job.findFirst({
    where: { id: params.id, shop: session.shop },
  });
  if (!job) throw new Response("Job not found", { status: 404 });

  const downloadFilename =
    job.outputFileUrl && job.status === "finished"
      ? path.basename(job.outputFileUrl)
      : null;

  return { job, downloadFilename };
};

export default function JobDetailPage() {
  const { job: initialJob, downloadFilename } = useLoaderData<typeof loader>();
  const [job, setJob] = useState(initialJob);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isActive = job.status === "pending" || job.status === "processing";

  // Download via authenticated fetch → blob, opened in a brand-new browser
  // tab. Any click on an <a> inside this iframe — even a synthetic one —
  // gets caught by Shopify App Bridge's own click handling (it manages
  // in-app navigation for anchor clicks), which then tries to "navigate"
  // to the blob: URL and crashes the embedded app to a blank page.
  // window.open() is a JS API call, not a DOM click event, so App Bridge's
  // listener never sees it — it runs entirely outside the iframe's event
  // system. The tab must be opened synchronously (before any await) so the
  // browser still associates it with the click gesture and doesn't block it
  // as a popup; we point it at the real blob only once the fetch resolves.
  const handleDownload = async () => {
    if (!downloadFilename || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    const popup = window.open("", "_blank");
    try {
      const res = await fetch(`/api/download/${encodeURIComponent(downloadFilename)}`);
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ""}`);
      }
      const blob = await res.blob();
      // Wrap the blob in a File so Chrome names the download after the real
      // export filename instead of the object URL's UUID. Navigating the
      // popup to the object URL is the PROVEN download mechanism here —
      // do not replace it with anchor-click variants (they get interfered
      // with inside the embedded iframe).
      const file = new File([blob], downloadFilename, { type: blob.type });
      const url = URL.createObjectURL(file);
      if (popup) {
        popup.location.href = url;
        // The download starts immediately (the blob is local); close the
        // helper tab shortly after so the user isn't left with a blank tab.
        setTimeout(() => {
          try { popup.close(); } catch { /* already closed */ }
        }, 2000);
      } else {
        throw new Error("Your browser blocked the download tab — please allow pop-ups for this site and try again.");
      }
    } catch (err) {
      popup?.close();
      setDownloadError(err instanceof Error ? err.message : "Download failed (unknown error)");
    } finally {
      setDownloading(false);
    }
  };

  useEffect(() => {
    if (!isActive) return;

    intervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${job.id}/status`);
        if (res.ok) {
          const updated = await res.json();
          setJob(updated);
          if (updated.status !== "pending" && updated.status !== "processing") {
            clearInterval(intervalRef.current!);
          }
        }
      } catch {}
    }, 2000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isActive, job.id]);

  const formatDuration = (ms: number | null) => {
    if (!ms) return "—";
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.round(ms / 1000)} sec`;
    return `${Math.round(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} sec`;
  };

  const formatDate = (d: string | Date) =>
    new Date(d).toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      // Pinned so server (UTC container) and browser (user TZ) render the
      // SAME text — otherwise SSR/client output differs and React hydration
      // fails, blanking the page.
      timeZone: "Europe/London",
    });

  type BadgeTone = "info" | "success" | "critical" | "warning" | "neutral" | "caution";
  const statusColor: Record<string, BadgeTone> = {
    finished: "success",
    failed: "critical",
    processing: "warning",
    pending: "info",
  };

  const progressPct =
    job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;

  return (
    <s-page heading={`${capitalize(job.entity)} ${capitalize(job.type)} #${job.id.slice(-8)}`}>
      {/* Plain child, not a slotted one — Polaris's <s-page> restructures
          slot="primary-action" children into its shadow DOM once the custom
          element upgrades client-side, which can produce a DOM shape that
          doesn't match the flat server-rendered HTML and trigger a React
          hydration mismatch. */}
      <div style={{ marginBottom: "12px" }}>
        <a href="/app/jobs" style={{ textDecoration: "none", color: "#005bd3", fontSize: "14px" }}>
          ← All Jobs
        </a>
      </div>

      {/* Status Card */}
      <s-section heading="Status">
        <s-stack direction="block" gap="base">
          <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
            <s-badge tone={statusColor[job.status] ?? "info"} size="large">
              {job.status.toUpperCase()}
            </s-badge>
            <span style={{ fontSize: "13px", color: "#6d7175" }}>
              Started {formatDate(job.createdAt)}
            </span>
          </div>

          {isActive && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px", fontSize: "13px" }}>
                <span>Processing...</span>
                <span>{job.processed.toLocaleString()} records</span>
              </div>
              <div style={{ height: "8px", background: "#e1e3e5", borderRadius: "4px", overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${progressPct}%`,
                    background: "#005bd3",
                    borderRadius: "4px",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>
          )}

          {job.status === "failed" && job.errorMessage && (
            <div style={{ padding: "12px", background: "#FFF4F4", borderRadius: "6px", border: "1px solid #FEAD9A" }}>
              <s-paragraph>
                <strong>Error:</strong> {job.errorMessage}
              </s-paragraph>
            </div>
          )}
        </s-stack>
      </s-section>

      {/* Stats */}
      <s-section heading="Details">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "12px" }}>
          <Stat label="Entity" value={capitalize(job.entity)} />
          <Stat label="Type" value={capitalize(job.type)} />
          <Stat label="Format" value={job.format.toUpperCase()} />
          <Stat label="Duration" value={formatDuration(job.durationMs)} />
          {job.total > 0 && <Stat label="Total Records" value={job.total.toLocaleString()} />}
          {job.type === "export" && <Stat label="Exported" value={job.exported.toLocaleString()} highlight="success" />}
          {job.type === "import" && <Stat label="Updated" value={job.updated.toLocaleString()} highlight="success" />}
          {job.failed > 0 && <Stat label="Failed" value={job.failed.toLocaleString()} highlight="error" />}
        </div>
      </s-section>

      {/* Download */}
      {downloadFilename && job.status === "finished" && (
        <s-section heading="Output File">
          <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
            <span style={{ fontSize: "24px" }}>📊</span>
            <div>
              <s-paragraph>
                <strong>{job.type === "export" ? "Export file ready" : "Import result file ready"}</strong>
              </s-paragraph>
              <s-paragraph>
                {job.type === "import"
                  ? "Download the result file to see which rows were updated or failed."
                  : "Your exported data is ready for download."}
              </s-paragraph>
            </div>
            <button
              onClick={handleDownload}
              disabled={downloading}
              style={{
                display: "inline-block",
                padding: "8px 18px",
                background: "#005bd3",
                color: "#fff",
                border: "none",
                borderRadius: "6px",
                textDecoration: "none",
                fontSize: "14px",
                fontWeight: 600,
                cursor: downloading ? "wait" : "pointer",
                opacity: downloading ? 0.7 : 1,
              }}
            >
              {downloading ? "Downloading…" : "Download"}
            </button>
          </div>
          {downloadError && (
            <div style={{ marginTop: "12px", padding: "12px", background: "#FFF4F4",
              borderRadius: "6px", border: "1px solid #FEAD9A" }}>
              <s-paragraph>
                <strong>Download error:</strong> {downloadError}
              </s-paragraph>
            </div>
          )}
        </s-section>
      )}
    </s-page>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: "success" | "error";
}) {
  const color =
    highlight === "success" ? "#0a7040" : highlight === "error" ? "#d82c0d" : "#202223";
  return (
    <div
      style={{
        padding: "12px 14px",
        background: "#f6f6f7",
        borderRadius: "8px",
        border: "1px solid #e1e3e5",
      }}
    >
      <div style={{ fontSize: "11px", color: "#6d7175", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ fontSize: "18px", fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function capitalize(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Route-level boundary so a client-side crash here shows a message instead
// of unmounting to a blank page. Thrown Responses MUST be delegated to
// boundary.error() — shopify-app-react-router throws a 200 Response whose
// body is the App Bridge session-token "bounce page" as part of normal auth
// flow, and boundary.error() renders that HTML so its script can run.
export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) return boundary.error(error);
  const message = error instanceof Error ? error.message : "Unknown error";
  return (
    <s-page heading="Job">
      <s-section heading="Something went wrong">
        <div style={{ padding: "12px", background: "#FFF4F4", borderRadius: "6px", border: "1px solid #FEAD9A" }}>
          <s-paragraph>
            <strong>Error:</strong> {message}
          </s-paragraph>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
