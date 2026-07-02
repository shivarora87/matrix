import type { LoaderFunctionArgs } from "react-router";
import path from "path";
import { authenticate } from "../shopify.server";
import { getDownloadResponse } from "../storage.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const safeFilename = path.basename(params.filename ?? "");
  if (!safeFilename) return new Response("Not found", { status: 404 });

  const response = await getDownloadResponse(safeFilename);
  if (!response) return new Response("File not found", { status: 404 });
  return response;
};
