import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const job = await prisma.job.findFirst({
    where: { id: params.id, shop: session.shop },
    select: {
      id: true,
      status: true,
      processed: true,
      total: true,
      exported: true,
      updated: true,
      failed: true,
      durationMs: true,
      outputFileUrl: true,
      errorMessage: true,
    },
  });

  if (!job) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(job), {
    headers: { "Content-Type": "application/json" },
  });
};
