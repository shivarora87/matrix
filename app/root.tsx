import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError, isRouteErrorResponse } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

function Document({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <Document>
      <Outlet />
    </Document>
  );
}

// Without a root-level boundary, an uncaught error anywhere in the tree
// (including a failed hydration-mismatch recovery, which re-renders the
// whole app from the root) has nothing above it to catch it, and React
// unmounts everything — a permanent blank page instead of a visible error.
//
// IMPORTANT: thrown Responses must be delegated to boundary.error() —
// shopify-app-react-router throws a 200 Response whose body is an App
// Bridge "bounce page" (a script that fetches a fresh session token and
// reloads) as part of NORMAL auth flow. boundary.error() renders that
// HTML so the script executes; rendering a generic error message instead
// breaks authentication entirely.
export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) {
    return <Document>{boundary.error(error)}</Document>;
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return (
    <Document>
      <div style={{ padding: "24px", fontFamily: "sans-serif" }}>
        <h1 style={{ fontSize: "18px" }}>Something went wrong</h1>
        <p style={{ color: "#d82c0d" }}>{message}</p>
      </div>
    </Document>
  );
}
