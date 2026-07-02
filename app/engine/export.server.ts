import ExcelJS from "exceljs";
import prisma from "../db.server";
import { saveFile } from "../storage.server";
import { sendJobNotification } from "../email.server";

const SHOPIFY_API_VERSION = "2025-10";

// ─── Types ─────────────────────────────────────────────────────────────────

type GraphQLFn = (query: string, variables?: Record<string, unknown>) => Promise<Response>;

export type ExportFilters = {
  updatedAfter?: string;
  updatedBefore?: string;
  status?: string;
  vendor?: string;
  tags?: string;
  query?: string;
};

// ─── Rate-limited GraphQL client ────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function makeGraphQL(shop: string, accessToken: string): GraphQLFn {
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  return async (query, variables) => {
    let delay = 1000;
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get("Retry-After") ?? "2") * 1000;
        await sleep(retryAfter);
        delay = Math.min(retryAfter * 1.5, 20000);
        continue;
      }

      const text = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return new Response(text, { status: res.status });
      }

      const errors = json.errors as Array<Record<string, unknown>> | undefined;
      if (errors?.some((e) => (e.extensions as Record<string, unknown>)?.code === "THROTTLED")) {
        await sleep(delay);
        delay = Math.min(delay * 2, 20000);
        continue;
      }

      return new Response(JSON.stringify(json), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("Shopify API rate limit: max retries exceeded");
  };
}

// ─── Query builder ──────────────────────────────────────────────────────────

function buildShopifyQuery(filters?: ExportFilters): string {
  const parts: string[] = [];
  if (filters?.query) parts.push(filters.query);
  if (filters?.status) parts.push(`status:${filters.status}`);
  if (filters?.vendor) parts.push(`vendor:"${filters.vendor}"`);
  if (filters?.tags) parts.push(`tag:${filters.tags}`);
  if (filters?.updatedAfter) parts.push(`updated_at:>${filters.updatedAfter}`);
  if (filters?.updatedBefore) parts.push(`updated_at:<${filters.updatedBefore}`);
  return parts.join(" ").trim() || undefined as unknown as string;
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function runExportJob(
  jobId: string,
  shop: string,
  accessToken: string,
  filters?: ExportFilters,
) {
  await prisma.job.update({ where: { id: jobId }, data: { status: "processing" } });
  const startTime = Date.now();

  try {
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    const graphql = makeGraphQL(shop, accessToken);
    const shopifyQuery = buildShopifyQuery(filters) as string | undefined;

    const onProgress = async (count: number) => {
      await prisma.job.update({ where: { id: jobId }, data: { processed: count } });
    };

    const { rows, headers } = await fetchEntity(job.entity, graphql, onProgress, shopifyQuery);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(capitalize(job.entity));
    sheet.addRow(headers);
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
    rows.forEach((row) => sheet.addRow(row));
    sheet.columns.forEach((col) => { col.width = 22; });

    const filename = `Export_${job.entity}_${Date.now()}.xlsx`;
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const outputFileUrl = await saveFile(
      buffer,
      filename,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "finished",
        exported: rows.length,
        total: rows.length,
        processed: rows.length,
        durationMs: Date.now() - startTime,
        outputFileUrl,
      },
    });
    sendJobNotification(shop, "export", job.entity, rows.length).catch(() => {});
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "failed",
        errorMessage: msg,
        durationMs: Date.now() - startTime,
      },
    });
    sendJobNotification(shop, "export", "", 0, msg).catch(() => {});
  }
}

function capitalize(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

async function fetchEntity(
  entity: string,
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
  shopifyQuery?: string,
): Promise<{ headers: string[]; rows: unknown[][] }> {
  switch (entity) {
    case "products":         return fetchProducts(graphql, onProgress, shopifyQuery);
    case "customers":        return fetchCustomers(graphql, onProgress, shopifyQuery);
    case "orders":           return fetchOrders(graphql, onProgress, shopifyQuery);
    case "collections":      return fetchCollections(graphql, onProgress);
    case "smart_collections":return fetchSmartCollections(graphql, onProgress);
    case "inventory":        return fetchInventory(graphql, onProgress);
    case "draft_orders":     return fetchDraftOrders(graphql, onProgress);
    case "discounts":        return fetchDiscounts(graphql, onProgress);
    case "pages":            return fetchPages(graphql, onProgress, shopifyQuery);
    case "blog_posts":       return fetchBlogPosts(graphql, onProgress);
    case "redirects":        return fetchRedirects(graphql, onProgress);
    case "metafields":       return fetchMetafields(graphql, onProgress);
    default:
      throw new Error(`Unsupported entity: ${entity}`);
  }
}

// ─── Helper: paginate ───────────────────────────────────────────────────────

async function paginate<T>(
  graphql: GraphQLFn,
  query: string,
  dataKey: string,
  variables: Record<string, unknown>,
  onPage: (edges: T[], hasNextPage: boolean, cursor: string | null) => void,
) {
  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const res = await graphql(query, { ...variables, cursor });
    const json = (await res.json()) as Record<string, unknown>;
    const conn = (json.data as Record<string, unknown>)?.[dataKey] as Record<string, unknown>;
    const edges = (conn?.edges ?? []) as Array<T & { cursor: string }>;
    const lastCursor = edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null;
    hasNextPage = !!((conn?.pageInfo as Record<string, unknown>)?.hasNextPage);
    onPage(edges, hasNextPage, lastCursor);
    cursor = lastCursor;
  }
}

// ─── Products ───────────────────────────────────────────────────────────────

async function fetchProducts(
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
  shopifyQuery?: string,
) {
  const headers = [
    "Command",
    "Handle", "Title", "Body HTML", "Vendor", "Type", "Tags", "Status", "Published",
    "SEO Title", "SEO Description",
    "Option1 Name", "Option1 Value",
    "Option2 Name", "Option2 Value",
    "Option3 Name", "Option3 Value",
    "Variant SKU", "Variant Price", "Variant Compare At Price",
    "Variant Weight", "Variant Weight Unit",
    "Variant Inventory Qty",
    "Variant Barcode", "Variant Requires Shipping", "Variant Taxable",
    "Variant Fulfillment Service",
    "Image Src", "Image Alt Text",
  ];
  const rows: unknown[][] = [];
  let count = 0;

  await paginate<{ node: Record<string, unknown>; cursor: string }>(
    graphql,
    `query GetProducts($cursor: String, $query: String) {
      products(first: 50, after: $cursor, query: $query) {
        edges {
          node {
            handle title descriptionHtml vendor productType status publishedAt tags
            seo { title description }
            options { name values }
            variants(first: 100) {
              edges {
                node {
                  sku price compareAtPrice barcode weight weightUnit
                  requiresShipping taxable inventoryQuantity
                  fulfillmentService { handle }
                  selectedOptions { name value }
                }
              }
            }
            images(first: 20) { edges { node { url altText } } }
          }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`,
    "products",
    { query: shopifyQuery ?? null },
    (edges) => {
      for (const { node: p } of edges) {
        count++;
        const seo = (p.seo as Record<string, string>) ?? {};
        const options = (p.options ?? []) as Array<{ name: string; values: string[] }>;
        const variants = ((p.variants as Record<string, unknown>)?.edges ?? []) as Array<{ node: Record<string, unknown> }>;
        const images = ((p.images as Record<string, unknown>)?.edges ?? []) as Array<{ node: Record<string, unknown> }>;
        const imgSrcs = images.map(({ node: i }) => String(i.url ?? "")).filter(Boolean);
        const imgAlts = images.map(({ node: i }) => String(i.altText ?? ""));
        const tagsStr = Array.isArray(p.tags) ? (p.tags as string[]).join(", ") : "";

        if (variants.length === 0) {
          rows.push(["MERGE", p.handle, p.title, p.descriptionHtml, p.vendor, p.productType,
            tagsStr, p.status, p.publishedAt ? "true" : "false",
            seo.title ?? "", seo.description ?? "",
            options[0]?.name ?? "", "", options[1]?.name ?? "", "", options[2]?.name ?? "", "",
            "", "", "", "", "", "", "", "", "", "", imgSrcs.join("; "), imgAlts[0] ?? ""]);
        } else {
          variants.forEach(({ node: v }, i) => {
            const opts = (v.selectedOptions ?? []) as Array<{ name: string; value: string }>;
            const fulfillment = ((v.fulfillmentService as Record<string, string>)?.handle) ?? "manual";
            if (i === 0) {
              rows.push(["MERGE", p.handle, p.title, p.descriptionHtml, p.vendor, p.productType,
                tagsStr, p.status, p.publishedAt ? "true" : "false",
                seo.title ?? "", seo.description ?? "",
                options[0]?.name ?? "", opts[0]?.value ?? "",
                options[1]?.name ?? "", opts[1]?.value ?? "",
                options[2]?.name ?? "", opts[2]?.value ?? "",
                v.sku ?? "", v.price ?? "", v.compareAtPrice ?? "",
                v.weight ?? "", v.weightUnit ?? "KILOGRAMS", v.inventoryQuantity ?? 0,
                v.barcode ?? "", v.requiresShipping ?? true, v.taxable ?? true, fulfillment,
                imgSrcs.join("; "), imgAlts[0] ?? ""]);
            } else {
              rows.push(["", "", "", "", "", "", "", "", "", "", "",
                "", opts[0]?.value ?? "", "", opts[1]?.value ?? "", "", opts[2]?.value ?? "",
                v.sku ?? "", v.price ?? "", v.compareAtPrice ?? "",
                v.weight ?? "", v.weightUnit ?? "KILOGRAMS", v.inventoryQuantity ?? 0,
                v.barcode ?? "", v.requiresShipping ?? true, v.taxable ?? true, fulfillment, "", ""]);
            }
          });
        }
      }
    },
  );
  await onProgress(count);
  return { headers, rows };
}

// ─── Customers ──────────────────────────────────────────────────────────────

async function fetchCustomers(
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
  shopifyQuery?: string,
) {
  const headers = ["Command", "ID", "First Name", "Last Name", "Email", "Phone", "Tags",
    "Orders Count", "Total Spent", "Currency", "Created At"];
  const rows: unknown[][] = [];

  await paginate<{ node: Record<string, unknown>; cursor: string }>(
    graphql,
    `query GetCustomers($cursor: String, $query: String) {
      customers(first: 250, after: $cursor, query: $query) {
        edges {
          node { id firstName lastName email phone tags numberOfOrders
            amountSpent { amount currencyCode } createdAt }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`,
    "customers",
    { query: shopifyQuery ?? null },
    (edges) => {
      for (const { node: c } of edges) {
        const spent = c.amountSpent as Record<string, string> | null;
        rows.push(["MERGE",
          String(c.id ?? "").replace("gid://shopify/Customer/", ""),
          c.firstName ?? "", c.lastName ?? "", c.email ?? "", c.phone ?? "",
          Array.isArray(c.tags) ? (c.tags as string[]).join(", ") : "",
          c.numberOfOrders ?? 0, spent?.amount ?? "0", spent?.currencyCode ?? "", c.createdAt ?? ""]);
      }
    },
  );
  await onProgress(rows.length);
  return { headers, rows };
}

// ─── Orders ─────────────────────────────────────────────────────────────────

async function fetchOrders(
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
  shopifyQuery?: string,
) {
  const headers = ["Command", "Name", "Email", "Financial Status", "Fulfillment Status",
    "Currency", "Total Price", "Subtotal Price", "Total Tax", "Line Items", "Tags", "Created At"];
  const rows: unknown[][] = [];

  await paginate<{ node: Record<string, unknown>; cursor: string }>(
    graphql,
    `query GetOrders($cursor: String, $query: String) {
      orders(first: 250, after: $cursor, query: $query) {
        edges {
          node {
            name email financialStatus fulfillmentStatus currencyCode tags createdAt
            totalPriceSet { shopMoney { amount } }
            subtotalPriceSet { shopMoney { amount } }
            totalTaxSet { shopMoney { amount } }
            lineItems(first: 50) {
              edges { node { title quantity originalUnitPriceSet { shopMoney { amount } } } }
            }
          }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`,
    "orders",
    { query: shopifyQuery ?? null },
    (edges) => {
      for (const { node: o } of edges) {
        const lis = ((o.lineItems as Record<string, unknown>)?.edges ?? []) as Array<{ node: Record<string, unknown> }>;
        const lineStr = lis.map(({ node: li }) => {
          const price = ((li.originalUnitPriceSet as Record<string, unknown>)?.shopMoney as Record<string, string>)?.amount ?? "0";
          return `${li.title} x${li.quantity} @ ${price}`;
        }).join("; ");
        const total = ((o.totalPriceSet as Record<string, unknown>)?.shopMoney as Record<string, string>)?.amount ?? "0";
        const sub = ((o.subtotalPriceSet as Record<string, unknown>)?.shopMoney as Record<string, string>)?.amount ?? "0";
        const tax = ((o.totalTaxSet as Record<string, unknown>)?.shopMoney as Record<string, string>)?.amount ?? "0";
        rows.push(["MERGE", o.name, o.email, o.financialStatus, o.fulfillmentStatus,
          o.currencyCode, total, sub, tax, lineStr,
          Array.isArray(o.tags) ? (o.tags as string[]).join(", ") : "", o.createdAt]);
      }
    },
  );
  await onProgress(rows.length);
  return { headers, rows };
}

// ─── Custom Collections ─────────────────────────────────────────────────────

async function fetchCollections(
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
) {
  const headers = ["Command", "Handle", "Title", "Description", "Sort Order", "Updated At"];
  const rows: unknown[][] = [];

  await paginate<{ node: Record<string, unknown>; cursor: string }>(
    graphql,
    `query GetCollections($cursor: String) {
      collections(first: 250, after: $cursor, query: "collection_type:custom") {
        edges {
          node { handle title description sortOrder updatedAt }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`,
    "collections",
    {},
    (edges) => {
      for (const { node: c } of edges) {
        rows.push(["MERGE", c.handle, c.title, c.description, c.sortOrder, c.updatedAt]);
      }
    },
  );
  await onProgress(rows.length);
  return { headers, rows };
}

// ─── Smart Collections ───────────────────────────────────────────────────────

async function fetchSmartCollections(
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
) {
  const headers = [
    "Command", "Handle", "Title", "Description", "Sort Order", "Disjunctive",
    "Rule1 Column", "Rule1 Relation", "Rule1 Condition",
    "Rule2 Column", "Rule2 Relation", "Rule2 Condition",
    "Rule3 Column", "Rule3 Relation", "Rule3 Condition",
  ];
  const rows: unknown[][] = [];

  await paginate<{ node: Record<string, unknown>; cursor: string }>(
    graphql,
    `query GetSmartCollections($cursor: String) {
      collections(first: 250, after: $cursor, query: "collection_type:smart") {
        edges {
          node {
            handle title description sortOrder
            ruleSet {
              appliedDisjunctively
              rules { column relation condition }
            }
          }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`,
    "collections",
    {},
    (edges) => {
      for (const { node: c } of edges) {
        const rs = c.ruleSet as { appliedDisjunctively: boolean; rules: Array<Record<string, string>> } | null;
        const rules = rs?.rules ?? [];
        rows.push([
          "MERGE", c.handle, c.title, c.description, c.sortOrder,
          rs?.appliedDisjunctively ? "true" : "false",
          rules[0]?.column ?? "", rules[0]?.relation ?? "", rules[0]?.condition ?? "",
          rules[1]?.column ?? "", rules[1]?.relation ?? "", rules[1]?.condition ?? "",
          rules[2]?.column ?? "", rules[2]?.relation ?? "", rules[2]?.condition ?? "",
        ]);
      }
    },
  );
  await onProgress(rows.length);
  return { headers, rows };
}

// ─── Inventory ───────────────────────────────────────────────────────────────

async function fetchInventory(
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
) {
  const headers = ["Command", "Product Handle", "Variant SKU", "Variant Title", "Location", "Available", "Inventory Adjust"];
  const rows: unknown[][] = [];

  await paginate<{ node: Record<string, unknown>; cursor: string }>(
    graphql,
    `query GetInventory($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        edges {
          node {
            sku title
            product { handle }
            inventoryItem {
              inventoryLevels(first: 10) {
                edges {
                  node {
                    quantities(names: ["available"]) { name quantity }
                    location { name }
                  }
                }
              }
            }
          }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`,
    "productVariants",
    {},
    (edges) => {
      for (const { node: v } of edges) {
        const productHandle = ((v.product as Record<string, unknown>)?.handle) ?? "";
        const levels = (((v.inventoryItem as Record<string, unknown>)?.inventoryLevels as Record<string, unknown>)?.edges ?? []) as Array<{ node: Record<string, unknown> }>;
        if (levels.length === 0) {
          rows.push(["MERGE", productHandle, v.sku ?? "", v.title ?? "", "", "", ""]);
        } else {
          for (const { node: level } of levels) {
            const locationName = ((level.location as Record<string, unknown>)?.name) ?? "";
            const quantities = (level.quantities ?? []) as Array<Record<string, unknown>>;
            const available = quantities.find((q) => q.name === "available")?.quantity ?? 0;
            rows.push(["MERGE", productHandle, v.sku ?? "", v.title ?? "", locationName, available, ""]);
          }
        }
      }
    },
  );
  await onProgress(rows.length);
  return { headers, rows };
}

// ─── Draft Orders ────────────────────────────────────────────────────────────

async function fetchDraftOrders(
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
) {
  const headers = ["Command", "Name", "Status", "Email", "Note", "Tags", "Total Price", "Line Items", "Created At"];
  const rows: unknown[][] = [];

  await paginate<{ node: Record<string, unknown>; cursor: string }>(
    graphql,
    `query GetDraftOrders($cursor: String) {
      draftOrders(first: 250, after: $cursor) {
        edges {
          node {
            name status email note tags totalPrice createdAt
            lineItems(first: 50) {
              edges {
                node {
                  title quantity
                  originalUnitPrice { amount }
                  variant { sku product { handle } }
                }
              }
            }
          }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`,
    "draftOrders",
    {},
    (edges) => {
      for (const { node: d } of edges) {
        const lis = ((d.lineItems as Record<string, unknown>)?.edges ?? []) as Array<{ node: Record<string, unknown> }>;
        const lineStr = lis.map(({ node: li }) => {
          const price = ((li.originalUnitPrice as Record<string, string>)?.amount) ?? "0";
          const variant = li.variant as Record<string, unknown> | null;
          const sku = variant?.sku ?? "";
          const handle = ((variant?.product as Record<string, unknown>)?.handle) ?? "";
          return `${handle}|${sku} x${li.quantity} @ ${price}`;
        }).join("; ");
        rows.push(["MERGE", d.name, d.status, d.email ?? "", d.note ?? "",
          Array.isArray(d.tags) ? (d.tags as string[]).join(", ") : "",
          d.totalPrice ?? "", lineStr, d.createdAt]);
      }
    },
  );
  await onProgress(rows.length);
  return { headers, rows };
}

// ─── Discounts ───────────────────────────────────────────────────────────────

async function fetchDiscounts(
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
) {
  const headers = ["Command", "Title", "Code", "Type", "Value", "Usage Limit", "Starts At", "Ends At", "Status"];
  const rows: unknown[][] = [];

  await paginate<{ node: Record<string, unknown>; cursor: string }>(
    graphql,
    `query GetDiscounts($cursor: String) {
      codeDiscountNodes(first: 250, after: $cursor) {
        edges {
          node {
            id
            codeDiscount {
              __typename
              ... on DiscountCodeBasic {
                title status startsAt endsAt usageLimit
                codes(first: 1) { edges { node { code } } }
                customerGets {
                  value {
                    __typename
                    ... on DiscountAmount { amount { amount } appliesOnEachItem }
                    ... on DiscountPercentage { percentage }
                  }
                }
              }
              ... on DiscountCodePercentage {
                title status startsAt endsAt usageLimit
                codes(first: 1) { edges { node { code } } }
                customerGets { value { ... on DiscountPercentage { percentage } } }
              }
              ... on DiscountCodeFreeShipping {
                title status startsAt endsAt usageLimit
                codes(first: 1) { edges { node { code } } }
              }
            }
          }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`,
    "codeDiscountNodes",
    {},
    (edges) => {
      for (const { node: n } of edges) {
        const d = n.codeDiscount as Record<string, unknown> | null;
        if (!d) continue;
        const typeName = String(d.__typename ?? "");
        const code = (((d.codes as Record<string, unknown>)?.edges as Array<{ node: { code: string } }>)?.[0]?.node?.code) ?? "";
        const cg = d.customerGets as Record<string, unknown> | null;
        const val = (cg?.value as Record<string, unknown>) ?? {};
        let type = "free_shipping";
        let value = "";
        if (typeName === "DiscountCodeBasic") {
          if (val.__typename === "DiscountAmount") {
            type = "fixed";
            value = String((val.amount as Record<string, string>)?.amount ?? "");
          } else if (val.__typename === "DiscountPercentage") {
            type = "percentage";
            value = String((val.percentage ?? "") as string);
          }
        } else if (typeName === "DiscountCodePercentage") {
          type = "percentage";
          value = String((val.percentage ?? "") as string);
        }
        rows.push(["MERGE", d.title, code, type, value,
          d.usageLimit ?? "", d.startsAt ?? "", d.endsAt ?? "", d.status ?? ""]);
      }
    },
  );
  await onProgress(rows.length);
  return { headers, rows };
}

// ─── Pages ───────────────────────────────────────────────────────────────────

async function fetchPages(
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
  shopifyQuery?: string,
) {
  const headers = ["Command", "Handle", "Title", "Body HTML", "Published", "Created At", "Updated At"];
  const rows: unknown[][] = [];

  await paginate<{ node: Record<string, unknown>; cursor: string }>(
    graphql,
    `query GetPages($cursor: String, $query: String) {
      pages(first: 250, after: $cursor, query: $query) {
        edges {
          node { handle title body isPublished createdAt updatedAt }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`,
    "pages",
    { query: shopifyQuery ?? null },
    (edges) => {
      for (const { node: p } of edges) {
        rows.push(["MERGE", p.handle, p.title, p.body ?? "", p.isPublished ? "true" : "false",
          p.createdAt, p.updatedAt]);
      }
    },
  );
  await onProgress(rows.length);
  return { headers, rows };
}

// ─── Blog Posts ──────────────────────────────────────────────────────────────

async function fetchBlogPosts(
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
) {
  const headers = ["Command", "Blog Handle", "Blog Title", "Handle", "Title",
    "Content HTML", "Author", "Tags", "Published", "Published At"];
  const rows: unknown[][] = [];

  // Blogs don't paginate deeply - fetch all blogs with their articles
  await paginate<{ node: Record<string, unknown>; cursor: string }>(
    graphql,
    `query GetBlogs($cursor: String) {
      blogs(first: 10, after: $cursor) {
        edges {
          node {
            handle title
            articles(first: 250) {
              edges {
                node {
                  handle title contentHtml isPublished publishedAt
                  author { name }
                  tags
                }
              }
            }
          }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`,
    "blogs",
    {},
    (edges) => {
      for (const { node: blog } of edges) {
        const articles = ((blog.articles as Record<string, unknown>)?.edges ?? []) as Array<{ node: Record<string, unknown> }>;
        for (const { node: a } of articles) {
          const authorName = ((a.author as Record<string, string>)?.name) ?? "";
          rows.push(["MERGE", blog.handle, blog.title, a.handle, a.title,
            a.contentHtml ?? "", authorName,
            Array.isArray(a.tags) ? (a.tags as string[]).join(", ") : "",
            a.isPublished ? "true" : "false", a.publishedAt ?? ""]);
        }
      }
    },
  );
  await onProgress(rows.length);
  return { headers, rows };
}

// ─── Redirects ───────────────────────────────────────────────────────────────

async function fetchRedirects(
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
) {
  const headers = ["Command", "Path", "Target"];
  const rows: unknown[][] = [];

  await paginate<{ node: Record<string, unknown>; cursor: string }>(
    graphql,
    `query GetRedirects($cursor: String) {
      urlRedirects(first: 250, after: $cursor) {
        edges {
          node { id path target }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`,
    "urlRedirects",
    {},
    (edges) => {
      for (const { node: r } of edges) {
        rows.push(["MERGE", r.path, r.target]);
      }
    },
  );
  await onProgress(rows.length);
  return { headers, rows };
}

// ─── Product Metafields ──────────────────────────────────────────────────────

async function fetchMetafields(
  graphql: GraphQLFn,
  onProgress: (count: number) => Promise<void>,
) {
  const headers = ["Command", "Product Handle", "Namespace", "Key", "Type", "Value"];
  const rows: unknown[][] = [];
  let count = 0;

  await paginate<{ node: Record<string, unknown>; cursor: string }>(
    graphql,
    `query GetProductMetafields($cursor: String) {
      products(first: 50, after: $cursor) {
        edges {
          node {
            handle
            metafields(first: 50) {
              edges { node { namespace key type value } }
            }
          }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`,
    "products",
    {},
    (edges) => {
      for (const { node: p } of edges) {
        count++;
        const mfs = ((p.metafields as Record<string, unknown>)?.edges ?? []) as Array<{ node: Record<string, unknown> }>;
        for (const { node: mf } of mfs) {
          rows.push(["MERGE", p.handle, mf.namespace, mf.key, mf.type, mf.value]);
        }
      }
    },
  );
  await onProgress(count);
  return { headers, rows };
}
