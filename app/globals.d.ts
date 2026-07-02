declare module "*.css";

// App Bridge navigation components (not covered by @shopify/polaris-types)
declare namespace React.JSX {
  interface IntrinsicElements {
    "s-app-nav": React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode };
  }
}
