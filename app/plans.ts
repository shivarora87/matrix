export const PLANS = {
  FREE: "Free",
  BASIC: "Basic",
  BIG: "Big",
  ENTERPRISE: "Enterprise",
} as const;

export type PlanName = (typeof PLANS)[keyof typeof PLANS];

export const PLAN_LIMITS: Record<string, Record<string, number>> = {
  [PLANS.FREE]:       { products: 10, customers: 10, orders: 10, collections: 10, smart_collections: 10, inventory: 10, draft_orders: 10, discounts: 10, pages: 10, blog_posts: 10, redirects: 10, metafields: 10 },
  [PLANS.BASIC]:      { products: 5000, customers: 2000, orders: 1000, collections: 1000, smart_collections: 1000, inventory: 5000, draft_orders: 500, discounts: 1000, pages: 500, blog_posts: 500, redirects: 2000, metafields: 5000 },
  [PLANS.BIG]:        { products: 50000, customers: 20000, orders: 10000, collections: 10000, smart_collections: 10000, inventory: 50000, draft_orders: 5000, discounts: 10000, pages: 5000, blog_posts: 5000, redirects: 20000, metafields: 50000 },
  [PLANS.ENTERPRISE]: { products: Infinity, customers: Infinity, orders: Infinity, collections: Infinity, smart_collections: Infinity, inventory: Infinity, draft_orders: Infinity, discounts: Infinity, pages: Infinity, blog_posts: Infinity, redirects: Infinity, metafields: Infinity },
};
