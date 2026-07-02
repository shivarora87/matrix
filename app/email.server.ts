import { Resend } from "resend";
import prisma from "./db.server";

const FROM = process.env.RESEND_FROM ?? "notifications@excel-import-export.app";

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function sendJobNotification(
  shop: string,
  type: "export" | "import",
  entity: string,
  count: number,
  error?: string,
): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const [enabledSetting, emailSetting] = await Promise.all([
    prisma.setting.findUnique({ where: { shop_key: { shop, key: "email_notifications" } } }),
    prisma.setting.findUnique({ where: { shop_key: { shop, key: "notification_email" } } }),
  ]);

  if (enabledSetting?.value !== "true") return;
  const to = emailSetting?.value?.trim();
  if (!to) return;

  const success = !error;
  const entityLabel = entity.replace(/_/g, " ");
  const subject = success
    ? `${capitalize(type)} complete — ${count.toLocaleString()} ${entityLabel}`
    : `${capitalize(type)} failed — ${entityLabel}`;

  const body = success
    ? `<p>Your <strong>${entityLabel}</strong> ${type} finished successfully.</p><p><strong>${count.toLocaleString()}</strong> rows processed from <strong>${shop}</strong>.</p>`
    : `<p>Your <strong>${entityLabel}</strong> ${type} encountered an error on <strong>${shop}</strong>.</p><blockquote style="border-left:3px solid #dc2626;padding-left:12px;color:#dc2626">${error}</blockquote>`;

  await resend.emails.send({
    from: FROM,
    to,
    subject,
    html: `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;color:#333">${body}<p style="margin-top:32px;font-size:12px;color:#999">Sent by Excel Import/Export for ${shop}</p></body></html>`,
  }).catch(() => { /* non-fatal */ });
}
