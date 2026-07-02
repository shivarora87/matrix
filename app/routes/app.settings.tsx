import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const settings = await prisma.setting.findMany({ where: { shop: session.shop } });
  const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));

  return {
    shop: session.shop,
    autoEraseAfterDays: map["auto_erase_days"] ?? "30",
    emailNotifications: map["email_notifications"] ?? "false",
    notificationEmail: map["notification_email"] ?? "",
    allowExternalDownloads: map["allow_external_downloads"] ?? "false",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const body = (await request.json()) as Record<string, string>;

  const entries = [
    { key: "auto_erase_days", value: body.autoEraseAfterDays ?? "30" },
    { key: "email_notifications", value: body.emailNotifications ?? "false" },
    { key: "notification_email", value: body.notificationEmail ?? "" },
    { key: "allow_external_downloads", value: body.allowExternalDownloads ?? "false" },
  ];

  for (const { key, value } of entries) {
    await prisma.setting.upsert({
      where: { shop_key: { shop: session.shop, key } },
      create: { shop: session.shop, key, value },
      update: { value },
    });
  }

  return { saved: true };
};

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [autoEraseAfterDays, setAutoEraseAfterDays] = useState(data.autoEraseAfterDays);
  const [emailNotifications, setEmailNotifications] = useState(data.emailNotifications === "true");
  const [notificationEmail, setNotificationEmail] = useState(data.notificationEmail);
  const [allowExternalDownloads, setAllowExternalDownloads] = useState(
    data.allowExternalDownloads === "true",
  );

  const isSaving = fetcher.state !== "idle";
  const saved = fetcher.data?.saved;

  const saveSettings = () => {
    fetcher.submit(
      {
        autoEraseAfterDays,
        emailNotifications: String(emailNotifications),
        notificationEmail,
        allowExternalDownloads: String(allowExternalDownloads),
      },
      { method: "POST", encType: "application/json" },
    );
  };

  const inputStyle = {
    padding: "8px 12px",
    border: "1px solid #c9cccf",
    borderRadius: "6px",
    fontSize: "14px",
  };

  return (
    <s-page heading="Settings">
      {/* File Retention */}
      <s-section heading="File Retention">
        <s-paragraph>
          Automatically delete export and import files after a number of days to save storage.
        </s-paragraph>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "8px" }}>
          <label style={{ fontSize: "14px" }}>Delete files after</label>
          <select
            value={autoEraseAfterDays}
            onChange={(e) => setAutoEraseAfterDays(e.target.value)}
            style={inputStyle}
          >
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
            <option value="0">Never</option>
          </select>
        </div>
      </s-section>

      {/* Notifications */}
      <s-section heading="Email Notifications">
        <s-paragraph>
          Receive an email when an export or import job finishes.
        </s-paragraph>
        <s-stack direction="block" gap="base">
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <input
              type="checkbox"
              id="emailNotifications"
              checked={emailNotifications}
              onChange={(e) => setEmailNotifications(e.target.checked)}
              style={{ width: "16px", height: "16px", cursor: "pointer" }}
            />
            <label htmlFor="emailNotifications" style={{ fontSize: "14px", cursor: "pointer" }}>
              Send email notifications when jobs complete
            </label>
          </div>
          {emailNotifications && (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "13px", fontWeight: 600 }}>Notification email</label>
              <input
                type="email"
                value={notificationEmail}
                onChange={(e) => setNotificationEmail(e.target.value)}
                placeholder="your@email.com"
                style={{ ...inputStyle, maxWidth: "320px" }}
              />
            </div>
          )}
        </s-stack>
      </s-section>

      {/* Security */}
      <s-section heading="Security">
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <input
            type="checkbox"
            id="allowExternalDownloads"
            checked={allowExternalDownloads}
            onChange={(e) => setAllowExternalDownloads(e.target.checked)}
            style={{ width: "16px", height: "16px", cursor: "pointer" }}
          />
          <label htmlFor="allowExternalDownloads" style={{ fontSize: "14px", cursor: "pointer" }}>
            Allow downloading export files from external services (e.g. Zapier, Make)
          </label>
        </div>
      </s-section>

      {/* Save */}
      <s-section>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <s-button
            onClick={saveSettings}
            {...(isSaving ? { loading: true } : {})}
          >
            {isSaving ? "Saving..." : "Save Settings"}
          </s-button>
          {saved && !isSaving && (
            <span style={{ color: "#0a7040", fontSize: "14px" }}>✓ Settings saved</span>
          )}
        </div>
      </s-section>

      {/* About */}
      <s-section heading="About" slot="aside">
        <s-paragraph>
          <strong>Store:</strong> {data.shop}
        </s-paragraph>
        <s-paragraph>
          Excel Import / Export lets you bulk-manage your Shopify store data using Excel and CSV files.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
