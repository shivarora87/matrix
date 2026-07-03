import { useEffect, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { ensureSchedulerStarted } from "../scheduler.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  ensureSchedulerStarted();
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  // Render route content only after client mount. The Polaris web-component
  // and App Bridge scripts mutate the DOM while React is hydrating, which
  // repeatedly caused hydration mismatches (React #418/#425). When hydration
  // fails, React Router re-fetches all loaders client-side — racing ahead of
  // App Bridge's fetch patching — so those requests go out without a session
  // token, get answered with the auth bounce page, and the app crashes to a
  // bare "200" error screen. Gating the Outlet on mount makes the server and
  // first client render byte-identical (both empty), eliminating the entire
  // failure chain at the cost of a brief flash on first load.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/jobs">All Jobs</s-link>
        <s-link href="/app/schedules">Schedules</s-link>
        <s-link href="/app/billing">Billing</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      {mounted ? <Outlet /> : null}
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
