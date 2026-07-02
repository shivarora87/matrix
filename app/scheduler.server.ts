import prisma from "./db.server";
import { runExportJob } from "./engine/export.server";

declare global {
  // eslint-disable-next-line no-var
  var __schedulerStarted: boolean | undefined;
}

export function ensureSchedulerStarted() {
  if (global.__schedulerStarted) return;
  global.__schedulerStarted = true;
  setInterval(tick, 60_000);
}

async function tick() {
  try {
    const now = new Date();
    const due = await prisma.schedule.findMany({
      where: { enabled: true, nextRunAt: { lte: now } },
    });
    for (const schedule of due) {
      runSchedule(schedule.id).catch(() => {});
    }
  } catch {
    // Non-fatal: scheduler tick failed
  }
}

async function runSchedule(scheduleId: string) {
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) return;

  const session = await prisma.session.findFirst({
    where: { shop: schedule.shop, isOnline: false },
  });
  if (!session) return;

  const job = await prisma.job.create({
    data: {
      shop: schedule.shop,
      type: "export",
      entity: schedule.entity,
      format: schedule.format,
      status: "pending",
    },
  });

  const filters = schedule.filters ? (JSON.parse(schedule.filters) as Record<string, unknown>) : undefined;
  await runExportJob(job.id, schedule.shop, session.accessToken, filters as Parameters<typeof runExportJob>[3]);

  await prisma.schedule.update({
    where: { id: scheduleId },
    data: {
      lastRunAt: new Date(),
      nextRunAt: calcNextRun(schedule),
    },
  });
}

interface ScheduleRow {
  interval: string;
  hour: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
}

export function calcNextRun(s: ScheduleRow): Date {
  const now = new Date();
  const next = new Date(now);

  switch (s.interval) {
    case "hourly":
      next.setHours(next.getHours() + 1, 0, 0, 0);
      break;

    case "daily":
      next.setDate(next.getDate() + 1);
      next.setHours(s.hour, 0, 0, 0);
      break;

    case "weekly": {
      const target = s.dayOfWeek ?? 1;
      const diff = (target - now.getDay() + 7) % 7 || 7;
      next.setDate(next.getDate() + diff);
      next.setHours(s.hour, 0, 0, 0);
      break;
    }

    case "monthly": {
      const target = s.dayOfMonth ?? 1;
      next.setMonth(next.getMonth() + 1, target);
      next.setHours(s.hour, 0, 0, 0);
      break;
    }

    default:
      next.setDate(next.getDate() + 1);
      next.setHours(s.hour, 0, 0, 0);
  }

  return next;
}
