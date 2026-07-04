import { useEffect, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { ensureSchedulerStarted } from "../scheduler.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  ensureSchedulerStarted();
  const { session } = await authenticate.admin(request);
  const storeSlug = session.shop.replace(".myshopify.com", "");
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    // Base admin URL for top-frame navigation — admin always re-frames the
    // app with a fresh id_token, so document loads via this URL are the one
    // navigation path that reliably authenticates.
    adminBase: `https://admin.shopify.com/store/${storeSlug}/apps/excel-import-export`,
  };
};

export default function App() {
  const { apiKey, adminBase } = useLoaderData<typeof loader>();

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

  // Guarantee every same-origin /app and /api fetch carries a session token.
  // App Bridge is supposed to patch window.fetch itself, but its patching is
  // conditional on frame-registration internals and demonstrably was not
  // engaging here — React Router's loader-data fetches went out without an
  // Authorization header, the server answered them with the auth bounce
  // page, and the app crashed to a bare "200" error screen on every
  // client-side navigation. shopify.idToken() is App Bridge's documented
  // public API for fetching a fresh session token; wrapping fetch with it
  // makes authentication deterministic instead of dependent on App Bridge's
  // ambient behavior. If App Bridge's own patch also runs, it sees the
  // Authorization header already present and skips — no conflict.
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const urlStr =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(urlStr, window.location.origin);
        const needsAuth =
          url.origin === window.location.origin &&
          (url.pathname.startsWith("/app") || url.pathname.startsWith("/api"));
        const shopifyGlobal = (window as unknown as { shopify?: { idToken?: () => Promise<string> } }).shopify;
        if (needsAuth && shopifyGlobal?.idToken) {
          const token = await shopifyGlobal.idToken();
          const headers = new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined),
          );
          if (!headers.has("Authorization")) {
            headers.set("Authorization", `Bearer ${token}`);
          }
          init = { ...init, headers };
        }
      } catch {
        // fall through to the unmodified request
      }
      return original(input, init);
    };
    return () => {
      window.fetch = original;
    };
  }, []);

  // Route ALL in-app navigation through the TOP admin frame instead of SPA
  // navigation. App Bridge intercepts link clicks and fires shopify:navigate;
  // the SDK's AppProvider turns that into a React Router SPA navigation whose
  // loader-data fetch depends on App Bridge attaching a session token — which
  // demonstrably does not happen in this app, yielding the auth-bounce "200"
  // crash on every internal link. Navigating window.top to the admin URL
  // instead makes Shopify re-frame the app with a fresh id_token — the one
  // navigation path that has always authenticated reliably. Capture phase +
  // stopImmediatePropagation preempts the SDK's own bubble-phase handler.
  useEffect(() => {
    // Expose for other routes (e.g. post-export redirect in app._index).
    (window as unknown as { __adminNavigate?: (path: string) => void }).__adminNavigate = (
      path: string,
    ) => {
      window.open(`${adminBase}${path}`, "_top");
    };

    const navHandler = (event: Event) => {
      const href = (event.target as HTMLElement | null)?.getAttribute?.("href");
      if (!href || !href.startsWith("/")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.open(`${adminBase}${href}`, "_top");
    };

    const clickHandler = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.("a[href^='/app']");
      const href = anchor?.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.open(`${adminBase}${href}`, "_top");
    };

    document.addEventListener("shopify:navigate", navHandler, true);
    document.addEventListener("click", clickHandler, true);
    return () => {
      document.removeEventListener("shopify:navigate", navHandler, true);
      document.removeEventListener("click", clickHandler, true);
    };
  }, [adminBase]);

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
