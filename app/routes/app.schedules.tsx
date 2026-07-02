import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { calcNextRun } from "../scheduler.server";

const ENTITIES = [
  "products", "customers", "orders", "collections", "smart_collections",
  "inventory", "draft_orders", "discounts", "pages", "blog_posts", "redirects", "metafields",
];

const INTERVALS = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const schedules = await prisma.schedule.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });
  return { schedules };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const body = (await request.json()) as Record<string, unknown>;
  const { _action, id } = body;

  if (_action === "delete") {
    await prisma.schedule.delete({ where: { id: id as string, shop: session.shop } });
    return { ok: true };
  }

  if (_action === "toggle") {
    const schedule = await prisma.schedule.findUnique({ where: { id: id as string, shop: session.shop } });
    if (schedule) {
      await prisma.schedule.update({
        where: { id: id as string },
        data: { enabled: !schedule.enabled },
      });
    }
    return { ok: true };
  }

  // create
  const interval = body.interval as string;
  const hour = parseInt(body.hour as string, 10) || 0;
  const dayOfWeek = interval === "weekly" ? parseInt(body.dayOfWeek as string, 10) : null;
  const dayOfMonth = interval === "monthly" ? parseInt(body.dayOfMonth as string, 10) : null;

  const scheduleData = { interval, hour, dayOfWeek, dayOfMonth };
  const nextRunAt = calcNextRun({ ...scheduleData, dayOfWeek: dayOfWeek ?? null, dayOfMonth: dayOfMonth ?? null });

  await prisma.schedule.create({
    data: {
      shop: session.shop,
      entity: body.entity as string,
      format: "excel",
      interval,
      hour,
      dayOfWeek,
      dayOfMonth,
      nextRunAt,
      enabled: true,
    },
  });

  return { ok: true };
};

export default function SchedulesPage() {
  const { schedules } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [entity, setEntity] = useState("products");
  const [interval, setInterval] = useState("daily");
  const [hour, setHour] = useState("0");
  const [dayOfWeek, setDayOfWeek] = useState("1");
  const [dayOfMonth, setDayOfMonth] = useState("1");

  const submit = (data: Record<string, unknown>) =>
    fetcher.submit(data as never, { method: "POST", encType: "application/json" });

  const inputStyle = { padding: "7px 10px", border: "1px solid #c9cccf", borderRadius: "6px", fontSize: "13px" };
  const btnStyle = (color = "#005bd3") => ({
    padding: "6px 14px", background: color, color: "#fff", border: "none",
    borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: 600,
  });

  return (
    <s-page heading="Scheduled Exports">
      <s-section heading="Create a Schedule">
        <s-paragraph>
          Automatic exports run on a schedule and save the file. You need the <strong>email notifications</strong> (Settings page) enabled to be notified when each run completes.
        </s-paragraph>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "12px", marginTop: "12px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <label style={{ fontSize: "12px", fontWeight: 600 }}>Entity</label>
            <select value={entity} onChange={(e) => setEntity(e.target.value)} style={inputStyle}>
              {ENTITIES.map((e) => (
                <option key={e} value={e}>{e.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <label style={{ fontSize: "12px", fontWeight: 600 }}>Frequency</label>
            <select value={interval} onChange={(e) => setInterval(e.target.value)} style={inputStyle}>
              {INTERVALS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
            </select>
          </div>

          {interval !== "hourly" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <label style={{ fontSize: "12px", fontWeight: 600 }}>Hour (UTC)</label>
              <select value={hour} onChange={(e) => setHour(e.target.value)} style={inputStyle}>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{String(i).padStart(2, "0")}:00</option>
                ))}
              </select>
            </div>
          )}

          {interval === "weekly" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <label style={{ fontSize: "12px", fontWeight: 600 }}>Day of week</label>
              <select value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)} style={inputStyle}>
                {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
          )}

          {interval === "monthly" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <label style={{ fontSize: "12px", fontWeight: 600 }}>Day of month</label>
              <select value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} style={inputStyle}>
                {Array.from({ length: 28 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>{i + 1}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div style={{ marginTop: "16px" }}>
          <button
            style={btnStyle()}
            onClick={() => submit({ _action: "create", entity, interval, hour, dayOfWeek, dayOfMonth })}
            disabled={fetcher.state !== "idle"}
          >
            {fetcher.state !== "idle" ? "Saving…" : "Create Schedule"}
          </button>
        </div>
      </s-section>

      <s-section heading={`Active Schedules (${schedules.length})`}>
        {schedules.length === 0 ? (
          <s-paragraph>No schedules yet. Create one above.</s-paragraph>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {schedules.map((s) => (
              <div key={s.id} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "12px 16px", border: "1px solid #e1e3e5", borderRadius: "8px",
                background: s.enabled ? "#fff" : "#f6f6f7", opacity: s.enabled ? 1 : 0.7,
              }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "14px" }}>
                    {s.entity.replace(/_/g, " ")} — {INTERVALS.find(i => i.value === s.interval)?.label}
                    {s.interval !== "hourly" && ` at ${String(s.hour).padStart(2, "0")}:00 UTC`}
                    {s.interval === "weekly" && s.dayOfWeek != null && ` on ${DAY_NAMES[s.dayOfWeek]}`}
                    {s.interval === "monthly" && s.dayOfMonth != null && ` on day ${s.dayOfMonth}`}
                  </div>
                  <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                    {s.lastRunAt && `Last run: ${new Date(s.lastRunAt).toLocaleString()} · `}
                    {s.nextRunAt && `Next: ${new Date(s.nextRunAt).toLocaleString()}`}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    style={btnStyle(s.enabled ? "#6d7175" : "#0a7040")}
                    onClick={() => submit({ _action: "toggle", id: s.id })}
                  >
                    {s.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    style={btnStyle("#dc2626")}
                    onClick={() => submit({ _action: "delete", id: s.id })}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
