import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLANS, PLAN_LIMITS } from "../plans";

const PLAN_DESCRIPTIONS: Record<string, { price: string; desc: string; colour: string }> = {
  [PLANS.FREE]:       { price: "Free",      colour: "#6d7175", desc: "Try it out — up to 10 rows per job" },
  [PLANS.BASIC]:      { price: "$20/month",  colour: "#005bd3", desc: "Up to 5K products, 2K customers, 1K orders" },
  [PLANS.BIG]:        { price: "$50/month",  colour: "#7c3aed", desc: "Up to 50K products, 20K customers, 10K orders" },
  [PLANS.ENTERPRISE]: { price: "$200/month", colour: "#0a7040", desc: "Unlimited — all entities, no row cap" },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing } = await authenticate.admin(request);
  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: [PLANS.BASIC, PLANS.BIG, PLANS.ENTERPRISE],
    isTest: true,
  });
  const currentPlan = hasActivePayment && appSubscriptions.length > 0
    ? appSubscriptions[0].name
    : PLANS.FREE;
  return { currentPlan };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const body = (await request.json()) as { plan: string };
  const plan = body.plan as typeof PLANS[keyof typeof PLANS];

  if (plan === PLANS.FREE) {
    // Cancel any active subscription
    const { appSubscriptions } = await billing.check({
      plans: [PLANS.BASIC, PLANS.BIG, PLANS.ENTERPRISE],
      isTest: true,
    });
    if (appSubscriptions.length > 0) {
      await billing.cancel({
        subscriptionId: appSubscriptions[0].id,
        isTest: true,
        prorate: true,
      });
    }
    return { cancelled: true };
  }

  await billing.request({
    plan,
    isTest: true,
    returnUrl: `${process.env.SHOPIFY_APP_URL}/app/billing`,
  });
  return null;
};

export default function BillingPage() {
  const { currentPlan } = useLoaderData<typeof loader>();

  const upgrade = (plan: string) => {
    fetch("/app/billing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    }).then((r) => {
      if (r.redirected) window.top!.location.href = r.url;
    });
  };

  return (
    <s-page heading="Plans & Billing">
      <s-paragraph>
        Choose a plan that fits your store size. You can upgrade or downgrade at any time.
      </s-paragraph>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "16px", marginTop: "16px" }}>
        {Object.entries(PLAN_DESCRIPTIONS).map(([name, { price, desc, colour }]) => {
          const isCurrent = name === currentPlan;
          const limits = PLAN_LIMITS[name];
          return (
            <div
              key={name}
              style={{
                border: isCurrent ? `2px solid ${colour}` : "1px solid #e1e3e5",
                borderRadius: "10px",
                padding: "20px",
                background: isCurrent ? "#f0f5ff" : "#fff",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: "16px", color: colour }}>{name}</div>
              <div style={{ fontSize: "22px", fontWeight: 700 }}>{price}</div>
              <div style={{ fontSize: "13px", color: "#6d7175" }}>{desc}</div>
              <ul style={{ margin: "4px 0 0", paddingLeft: "16px", fontSize: "12px", color: "#444", lineHeight: 1.7 }}>
                <li>Products: {limits.products === Infinity ? "Unlimited" : limits.products.toLocaleString()}</li>
                <li>Customers: {limits.customers === Infinity ? "Unlimited" : limits.customers.toLocaleString()}</li>
                <li>Orders: {limits.orders === Infinity ? "Unlimited" : limits.orders.toLocaleString()}</li>
                <li>All {Object.keys(limits).length} entity types</li>
              </ul>
              {isCurrent ? (
                <div style={{ padding: "8px 16px", background: colour, color: "#fff", borderRadius: "6px",
                  textAlign: "center", fontWeight: 600, fontSize: "13px" }}>
                  Current plan
                </div>
              ) : (
                <button
                  onClick={() => upgrade(name)}
                  style={{ padding: "8px 16px", background: colour, color: "#fff", border: "none",
                    borderRadius: "6px", cursor: "pointer", fontWeight: 600, fontSize: "13px" }}
                >
                  {name === PLANS.FREE ? "Downgrade to Free" : `Upgrade to ${name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: "24px", padding: "16px", background: "#f6f6f7", borderRadius: "8px", fontSize: "13px", color: "#6d7175" }}>
        All plans include: Export + Import for Products, Customers, Orders, Collections, Smart Collections,
        Inventory, Draft Orders, Discounts, Pages, Blog Posts, Redirects, and Product Metafields.
        Row limits apply per individual job. Billing is handled securely by Shopify.
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
