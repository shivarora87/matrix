import ExcelJS from "exceljs";
import { parse as csvParse } from "csv-parse/sync";
import prisma from "../db.server";
import { saveFile, deleteFile } from "../storage.server";
import { sendJobNotification } from "../email.server";

const SHOPIFY_API_VERSION = "2025-10";

// ─── Rate-limited GraphQL client ────────────────────────────────────────────

type GraphQLFn = (query: string, variables?: Record<string, unknown>) => Promise<Response>;

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

// ─── Generic mutation helper (throws on userErrors) ─────────────────────────

async function gql(
  graphql: GraphQLFn,
  query: string,
  variables: Record<string, unknown>,
  mutationKey: string,
): Promise<Record<string, unknown>> {
  const res = await graphql(query, variables);
  const json = (await res.json()) as Record<string, unknown>;
  const data = (json.data as Record<string, unknown>) ?? {};
  const result = data[mutationKey] as Record<string, unknown> | undefined;
  const userErrors = (result?.userErrors as Array<{ message: string }>) ?? [];
  if (userErrors.length > 0) throw new Error(userErrors.map((e) => e.message).join(", "));
  return data;
}

// ─── File auto-erasure ───────────────────────────────────────────────────────

async function eraseOldFiles(shop: string) {
  try {
    const setting = await prisma.setting.findFirst({
      where: { shop, key: "auto_erase_days" },
    });
    const days = parseInt(setting?.value ?? "30", 10);
    if (days === 0) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const expired = await prisma.job.findMany({
      where: { shop, outputFileUrl: { not: null }, createdAt: { lt: cutoff } },
      select: { id: true, outputFileUrl: true },
    });

    for (const job of expired) {
      if (job.outputFileUrl) {
        const filename = job.outputFileUrl.split("/").pop() ?? "";
        await deleteFile(filename);
      }
      await prisma.job.update({ where: { id: job.id }, data: { outputFileUrl: null } });
    }
  } catch {
    // Non-fatal: erasure is best-effort
  }
}

// ─── Command helpers ─────────────────────────────────────────────────────────

function resolveCommand(raw: string | undefined): string {
  const cmd = (raw ?? "MERGE").trim().toUpperCase();
  return cmd || "MERGE";
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runImportJob(
  jobId: string,
  shop: string,
  accessToken: string,
  fileBuffer: Buffer,
  filename: string,
) {
  await prisma.job.update({ where: { id: jobId }, data: { status: "processing" } });
  const startTime = Date.now();

  // Run erasure asynchronously in the background (don't block job)
  eraseOldFiles(shop).catch(() => {});

  try {
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    const graphql = makeGraphQL(shop, accessToken);
    const rows = await parseFile(fileBuffer, filename);

    let updated = 0, failed = 0, skipped = 0;
    const resultRows: Array<Record<string, string>> = [];

    if (job.entity === "products") {
      const groups = groupProductRows(rows);
      await prisma.job.update({ where: { id: jobId }, data: { total: groups.length } });

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        try {
          const action = await importProductGroup(group, graphql);
          if (action === "skipped") skipped++;
          else updated++;
          resultRows.push(...group.rows.map((r, ri) => ({
            ...r,
            "Import Result": ri === 0 ? (action === "skipped" ? "Skipped" : capitalize(action)) : "",
            "Import Error": "",
          })));
        } catch (err) {
          failed++;
          resultRows.push(...group.rows.map((r, ri) => ({
            ...r,
            "Import Result": ri === 0 ? "Failed" : "",
            "Import Error": ri === 0 ? (err instanceof Error ? err.message : "Unknown error") : "",
          })));
        }
        if (i % 10 === 0 || i === groups.length - 1) {
          await prisma.job.update({ where: { id: jobId }, data: { processed: i + 1, updated, failed, skipped } });
        }
      }
    } else {
      await prisma.job.update({ where: { id: jobId }, data: { total: rows.length } });

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const command = resolveCommand(row["Command"]);

        if (command === "IGNORE") {
          skipped++;
          resultRows.push({ ...row, "Import Result": "Skipped", "Import Error": "" });
        } else {
          try {
            await importRow(job.entity, row, graphql, command);
            updated++;
            resultRows.push({ ...row, "Import Result": "Updated", "Import Error": "" });
          } catch (err) {
            failed++;
            resultRows.push({
              ...row,
              "Import Result": "Failed",
              "Import Error": err instanceof Error ? err.message : "Unknown error",
            });
          }
        }
        if (i % 20 === 0 || i === rows.length - 1) {
          await prisma.job.update({ where: { id: jobId }, data: { processed: i + 1, updated, failed, skipped } });
        }
      }
    }

    const resultFilename = `Import_Result_${Date.now()}.xlsx`;
    const outputFileUrl = await writeResultFile(resultRows, resultFilename);

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "finished", updated, failed, skipped,
        processed: resultRows.length,
        durationMs: Date.now() - startTime,
        outputFileUrl,
      },
    });
    const job2 = await prisma.job.findUnique({ where: { id: jobId } });
    sendJobNotification(shop, "import", job2?.entity ?? "", updated + skipped).catch(() => {});
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
    sendJobNotification(shop, "import", "", 0, msg).catch(() => {});
  }
}

// ─── Product grouping ────────────────────────────────────────────────────────

interface ProductGroup {
  handle: string;
  command: string;
  rows: Array<Record<string, string>>;
}

function groupProductRows(rows: Array<Record<string, string>>): ProductGroup[] {
  const groups: ProductGroup[] = [];
  let current: ProductGroup | null = null;
  for (const row of rows) {
    const handle = (row["Handle"] ?? "").trim();
    if (handle) {
      current = { handle, command: resolveCommand(row["Command"]), rows: [row] };
      groups.push(current);
    } else if (current) {
      current.rows.push(row);
    }
  }
  return groups;
}

// ─── Product import ──────────────────────────────────────────────────────────

async function importProductGroup(
  group: ProductGroup,
  graphql: GraphQLFn,
): Promise<"created" | "updated" | "deleted" | "skipped"> {
  const { handle, command, rows } = group;
  if (command === "IGNORE") return "skipped";

  const firstRow = rows[0];
  const optionNames: string[] = [];
  if ((firstRow["Option1 Name"] ?? "").trim()) optionNames.push(firstRow["Option1 Name"].trim());
  if ((firstRow["Option2 Name"] ?? "").trim()) optionNames.push(firstRow["Option2 Name"].trim());
  if ((firstRow["Option3 Name"] ?? "").trim()) optionNames.push(firstRow["Option3 Name"].trim());

  const variantInputs: Array<Record<string, unknown>> = rows
    .filter((r) => (r["Variant SKU"] ?? r["Variant Price"] ?? r["Option1 Value"] ?? "").trim())
    .map((r) => {
      const optVals: string[] = [];
      if ((r["Option1 Value"] ?? "").trim()) optVals.push(r["Option1 Value"].trim());
      if ((r["Option2 Value"] ?? "").trim()) optVals.push(r["Option2 Value"].trim());
      if ((r["Option3 Value"] ?? "").trim()) optVals.push(r["Option3 Value"].trim());
      const w = parseFloat(r["Variant Weight"] ?? "");
      return {
        sku: (r["Variant SKU"] ?? "").trim(),
        price: (r["Variant Price"] ?? "0.00").trim(),
        compareAtPrice: (r["Variant Compare At Price"] ?? "").trim() || null,
        weight: isNaN(w) ? undefined : w,
        weightUnit: (r["Variant Weight Unit"] ?? "KILOGRAMS").trim().toUpperCase(),
        barcode: (r["Variant Barcode"] ?? "").trim() || null,
        requiresShipping: (r["Variant Requires Shipping"] ?? "true").toLowerCase() !== "false",
        taxable: (r["Variant Taxable"] ?? "true").toLowerCase() !== "false",
        ...(optVals.length > 0 ? { options: optVals } : {}),
      };
    });

  const imageSrcs = (firstRow["Image Src"] ?? "").split(";").map((s) => s.trim()).filter(Boolean);

  const productFields: Record<string, unknown> = {
    handle,
    title: (firstRow["Title"] ?? "").trim(),
    bodyHtml: (firstRow["Body HTML"] ?? "").trim(),
    vendor: (firstRow["Vendor"] ?? "").trim(),
    productType: (firstRow["Type"] ?? "").trim(),
    tags: (firstRow["Tags"] ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    status: (firstRow["Status"] ?? "ACTIVE").trim().toUpperCase(),
    ...(optionNames.length > 0 ? { options: optionNames } : {}),
    ...(variantInputs.length > 0 ? { variants: variantInputs } : {}),
    seo: {
      title: (firstRow["SEO Title"] ?? "").trim(),
      description: (firstRow["SEO Description"] ?? "").trim(),
    },
  };

  // Look up existing product by handle
  const lookupRes = await graphql(
    `query FindProduct($query: String!) {
      products(first: 5, query: $query) {
        edges {
          node {
            id handle
            variants(first: 100) { edges { node { id sku } } }
          }
        }
      }
    }`,
    { query: `handle:${handle}` },
  );
  const lookupJson = (await lookupRes.json()) as Record<string, unknown>;
  const lookupEdges = (
    ((lookupJson.data as Record<string, unknown>)?.products as Record<string, unknown>)
      ?.edges as Array<{ node: { id: string; handle: string; variants: { edges: Array<{ node: { id: string; sku: string } }> } } }>
  ) ?? [];
  const existing = lookupEdges.find((e) => e.node.handle === handle)?.node ?? null;

  if (command === "DELETE") {
    if (!existing) throw new Error(`Product "${handle}" not found`);
    await gql(graphql,
      `mutation ProductDelete($input: ProductDeleteInput!) {
        productDelete(input: $input) { userErrors { field message } }
      }`,
      { input: { id: existing.id } }, "productDelete");
    return "deleted";
  }
  if (command === "NEW" && existing) throw new Error(`Product "${handle}" already exists — use MERGE to update`);
  if (command === "UPDATE" && !existing) throw new Error(`Product "${handle}" not found — use MERGE to create`);

  if (command === "REPLACE" && existing) {
    await gql(graphql,
      `mutation ProductDelete($input: ProductDeleteInput!) {
        productDelete(input: $input) { userErrors { field message } }
      }`,
      { input: { id: existing.id } }, "productDelete");
  }

  if (!existing || command === "REPLACE") {
    const createData = await gql(graphql,
      `mutation ProductCreate($input: ProductInput!) {
        productCreate(input: $input) { product { id } userErrors { field message } }
      }`,
      { input: productFields }, "productCreate");
    const productId = ((createData.productCreate as Record<string, unknown>)?.product as Record<string, string>)?.id;
    if (productId && imageSrcs.length > 0) await createProductMedia(productId, imageSrcs, graphql);
    return "created";
  }

  // Update
  const updateData = await gql(graphql,
    `mutation ProductUpdate($input: ProductInput!) {
      productUpdate(input: $input) { product { id } userErrors { field message } }
    }`,
    { input: { ...productFields, id: existing.id } }, "productUpdate");
  const updatedId = ((updateData.productUpdate as Record<string, unknown>)?.product as Record<string, string>)?.id;

  if (variantInputs.length > 0 && updatedId) {
    const existingVariants = existing.variants.edges.map((e) => e.node);
    const toUpdate: Array<Record<string, unknown>> = [];
    const toCreate: Array<Record<string, unknown>> = [];
    for (const v of variantInputs) {
      const match = existingVariants.find((ev) => ev.sku === (v.sku as string));
      if (match) toUpdate.push({ ...v, id: match.id });
      else toCreate.push(v);
    }
    if (toUpdate.length > 0) {
      await gql(graphql,
        `mutation BulkUpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id } userErrors { field message }
          }
        }`,
        { productId: updatedId, variants: toUpdate }, "productVariantsBulkUpdate");
    }
    if (toCreate.length > 0) {
      await gql(graphql,
        `mutation BulkCreateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants { id } userErrors { field message }
          }
        }`,
        { productId: updatedId, variants: toCreate }, "productVariantsBulkCreate");
    }
  }

  if (updatedId && imageSrcs.length > 0) await createProductMedia(updatedId, imageSrcs, graphql);
  return "updated";
}

async function createProductMedia(productId: string, srcs: string[], graphql: GraphQLFn) {
  await graphql(
    `mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id } userErrors { field message }
      }
    }`,
    { productId, media: srcs.map((src) => ({ originalSource: src, mediaContentType: "IMAGE" })) },
  );
}

// ─── Row-level dispatch ───────────────────────────────────────────────────────

async function importRow(entity: string, row: Record<string, string>, graphql: GraphQLFn, command: string) {
  switch (entity) {
    case "customers":        return importCustomer(row, graphql, command);
    case "orders":           return importOrder(row, graphql);
    case "collections":      return importCollection(row, graphql, command);
    case "smart_collections":return importSmartCollection(row, graphql, command);
    case "inventory":        return importInventory(row, graphql);
    case "draft_orders":     return importDraftOrder(row, graphql, command);
    case "discounts":        return importDiscount(row, graphql, command);
    case "pages":            return importPage(row, graphql, command);
    case "blog_posts":       return importBlogPost(row, graphql, command);
    case "redirects":        return importRedirect(row, graphql, command);
    case "metafields":       return importMetafield(row, graphql, command);
    default: throw new Error(`Import not supported for entity: ${entity}`);
  }
}

// ─── Customers ───────────────────────────────────────────────────────────────

async function importCustomer(row: Record<string, string>, graphql: GraphQLFn, command: string) {
  const email = (row["Email"] ?? row["email"] ?? "").trim();
  if (!email) throw new Error("Email is required");

  const tags = (row["Tags"] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const input: Record<string, unknown> = {
    email,
    firstName: (row["First Name"] ?? "").trim(),
    lastName: (row["Last Name"] ?? "").trim(),
    tags,
  };
  const phone = (row["Phone"] ?? "").trim();
  if (phone) input.phone = phone;

  const lookupRes = await graphql(
    `query FindCustomer($query: String!) {
      customers(first: 1, query: $query) { edges { node { id } } }
    }`,
    { query: `email:${email}` },
  );
  const lookupJson = (await lookupRes.json()) as Record<string, unknown>;
  const existingId = (
    ((lookupJson.data as Record<string, unknown>)?.customers as Record<string, unknown>)
      ?.edges as Array<{ node: { id: string } }>
  )?.[0]?.node?.id;

  if (command === "DELETE") {
    if (!existingId) throw new Error(`Customer "${email}" not found`);
    await gql(graphql,
      `mutation CustomerDelete($input: CustomerDeleteInput!) {
        customerDelete(input: $input) { userErrors { field message } }
      }`,
      { input: { id: existingId } }, "customerDelete");
    return;
  }
  if (command === "NEW" && existingId) throw new Error(`Customer "${email}" already exists`);
  if (command === "UPDATE" && !existingId) throw new Error(`Customer "${email}" not found`);

  if (existingId) {
    await gql(graphql,
      `mutation CustomerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) { customer { id } userErrors { field message } }
      }`,
      { input: { ...input, id: existingId } }, "customerUpdate");
  } else {
    await gql(graphql,
      `mutation CustomerCreate($input: CustomerInput!) {
        customerCreate(input: $input) { customer { id } userErrors { field message } }
      }`,
      { input }, "customerCreate");
  }
}

// ─── Orders ──────────────────────────────────────────────────────────────────

async function importOrder(row: Record<string, string>, graphql: GraphQLFn) {
  const orderName = (row["Name"] ?? "").trim();
  if (!orderName) throw new Error("Order Name (e.g. #1001) is required");
  const tags = (row["Tags"] ?? "").split(",").map((t) => t.trim()).filter(Boolean);

  const searchRes = await graphql(
    `query FindOrder($query: String!) {
      orders(first: 1, query: $query) { edges { node { id } } }
    }`,
    { query: `name:${orderName}` },
  );
  const searchJson = (await searchRes.json()) as Record<string, unknown>;
  const orderId = (
    ((searchJson.data as Record<string, unknown>)?.orders as Record<string, unknown>)
      ?.edges as Array<{ node: { id: string } }>
  )?.[0]?.node?.id;
  if (!orderId) throw new Error(`Order ${orderName} not found`);

  await gql(graphql,
    `mutation OrderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) { order { id } userErrors { field message } }
    }`,
    { input: { id: orderId, tags } }, "orderUpdate");
}

// ─── Custom Collections ───────────────────────────────────────────────────────

async function importCollection(row: Record<string, string>, graphql: GraphQLFn, command: string) {
  const title = (row["Title"] ?? "").trim();
  if (!title) throw new Error("Title is required");
  const handle = (row["Handle"] ?? "").trim();
  const descriptionHtml = (row["Description"] ?? "").trim();

  let existingId: string | undefined;
  if (handle) {
    const lr = await graphql(
      `query FindCollection($handle: String!) {
        collectionByHandle(handle: $handle) { id }
      }`,
      { handle },
    );
    existingId = ((await lr.json() as Record<string, unknown>).data as Record<string, unknown>)
      ?.collectionByHandle as string | undefined;
    if (existingId && typeof existingId === "object") {
      existingId = (existingId as Record<string, string>).id;
    }
  }

  if (command === "DELETE") {
    if (!existingId) throw new Error(`Collection "${handle}" not found`);
    await gql(graphql,
      `mutation CollectionDelete($input: CollectionDeleteInput!) {
        collectionDelete(input: $input) { userErrors { field message } }
      }`,
      { input: { id: existingId } }, "collectionDelete");
    return;
  }
  if (command === "NEW" && existingId) throw new Error(`Collection "${handle}" already exists`);
  if (command === "UPDATE" && !existingId) throw new Error(`Collection "${handle}" not found`);

  if (existingId) {
    await gql(graphql,
      `mutation CollectionUpdate($input: CollectionInput!) {
        collectionUpdate(input: $input) { collection { id } userErrors { field message } }
      }`,
      { input: { id: existingId, title, descriptionHtml } }, "collectionUpdate");
  } else {
    await gql(graphql,
      `mutation CollectionCreate($input: CollectionInput!) {
        collectionCreate(input: $input) { collection { id } userErrors { field message } }
      }`,
      { input: { title, descriptionHtml } }, "collectionCreate");
  }
}

// ─── Smart Collections ────────────────────────────────────────────────────────

async function importSmartCollection(row: Record<string, string>, graphql: GraphQLFn, command: string) {
  const title = (row["Title"] ?? "").trim();
  if (!title) throw new Error("Title is required");
  const handle = (row["Handle"] ?? "").trim();
  const descriptionHtml = (row["Description"] ?? "").trim();
  const disjunctive = (row["Disjunctive"] ?? "false").toLowerCase() === "true";

  const rules: Array<{ column: string; relation: string; condition: string }> = [];
  for (let i = 1; i <= 3; i++) {
    const col = (row[`Rule${i} Column`] ?? "").trim();
    const rel = (row[`Rule${i} Relation`] ?? "").trim();
    const cond = (row[`Rule${i} Condition`] ?? "").trim();
    if (col && rel && cond) rules.push({ column: col, relation: rel, condition: cond });
  }

  const collectionInput: Record<string, unknown> = {
    title, descriptionHtml,
    ruleSet: { appliedDisjunctively: disjunctive, rules },
  };

  let existingId: string | undefined;
  if (handle) {
    const lr = await graphql(
      `query FindCollection($handle: String!) {
        collectionByHandle(handle: $handle) { id }
      }`,
      { handle },
    );
    const lrj = (await lr.json() as Record<string, unknown>).data as Record<string, unknown>;
    const col = lrj?.collectionByHandle as Record<string, string> | null;
    existingId = col?.id;
  }

  if (command === "DELETE") {
    if (!existingId) throw new Error(`Smart collection "${handle}" not found`);
    await gql(graphql,
      `mutation CollectionDelete($input: CollectionDeleteInput!) {
        collectionDelete(input: $input) { userErrors { field message } }
      }`,
      { input: { id: existingId } }, "collectionDelete");
    return;
  }
  if (command === "NEW" && existingId) throw new Error(`Smart collection "${handle}" already exists`);
  if (command === "UPDATE" && !existingId) throw new Error(`Smart collection "${handle}" not found`);

  if (existingId) {
    await gql(graphql,
      `mutation CollectionUpdate($input: CollectionInput!) {
        collectionUpdate(input: $input) { collection { id } userErrors { field message } }
      }`,
      { input: { id: existingId, ...collectionInput } }, "collectionUpdate");
  } else {
    await gql(graphql,
      `mutation CollectionCreate($input: CollectionInput!) {
        collectionCreate(input: $input) { collection { id } userErrors { field message } }
      }`,
      { input: collectionInput }, "collectionCreate");
  }
}

// ─── Inventory ────────────────────────────────────────────────────────────────

async function importInventory(row: Record<string, string>, graphql: GraphQLFn) {
  const sku = (row["Variant SKU"] ?? row["SKU"] ?? "").trim();
  const locationName = (row["Location"] ?? "").trim();
  const availableRaw = row["Available"] ?? "";
  const adjustRaw = row["Inventory Adjust"] ?? "";

  if (!sku) throw new Error("Variant SKU is required");
  if (!locationName) throw new Error("Location is required");
  if (!availableRaw && !adjustRaw) throw new Error("Either Available or Inventory Adjust is required");

  const variantRes = await graphql(
    `query FindVariant($query: String!) {
      productVariants(first: 1, query: $query) {
        edges { node { inventoryItem { id } } }
      }
    }`,
    { query: `sku:${sku}` },
  );
  const inventoryItemId = (
    ((await variantRes.json() as Record<string, unknown>).data as Record<string, unknown>)
      ?.productVariants as Record<string, unknown>
  )?.edges as Array<{ node: { inventoryItem: { id: string } } }>;
  const itemId = inventoryItemId?.[0]?.node?.inventoryItem?.id;
  if (!itemId) throw new Error(`Variant with SKU "${sku}" not found`);

  const locationRes = await graphql(
    `query FindLocation($query: String!) {
      locations(first: 1, query: $query) { edges { node { id } } }
    }`,
    { query: `name:${locationName}` },
  );
  const locationId = (
    ((await locationRes.json() as Record<string, unknown>).data as Record<string, unknown>)
      ?.locations as Record<string, unknown>
  )?.edges as Array<{ node: { id: string } }>;
  const locId = locationId?.[0]?.node?.id;
  if (!locId) throw new Error(`Location "${locationName}" not found`);

  // Decide between absolute set vs delta adjust
  if (adjustRaw.trim() !== "") {
    const delta = parseInt(adjustRaw, 10);
    if (isNaN(delta)) throw new Error("Inventory Adjust must be an integer");
    await gql(graphql,
      `mutation InventoryAdjust($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          inventoryAdjustmentGroup { id } userErrors { field message }
        }
      }`,
      {
        input: {
          name: "available",
          reason: "correction",
          changes: [{ inventoryItemId: itemId, locationId: locId, delta }],
        },
      }, "inventoryAdjustQuantities");
  } else {
    const qty = parseInt(availableRaw, 10);
    if (isNaN(qty)) throw new Error("Available must be a number");
    await gql(graphql,
      `mutation InventorySet($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          inventoryAdjustmentGroup { id } userErrors { field message }
        }
      }`,
      {
        input: {
          name: "available",
          reason: "correction",
          quantities: [{ inventoryItemId: itemId, locationId: locId, quantity: qty }],
        },
      }, "inventorySetQuantities");
  }
}

// ─── Draft Orders ─────────────────────────────────────────────────────────────

async function importDraftOrder(row: Record<string, string>, graphql: GraphQLFn, command: string) {
  const email = (row["Email"] ?? "").trim();
  const note = (row["Note"] ?? "").trim();
  const tags = (row["Tags"] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const lineItemsRaw = (row["Line Items"] ?? "").trim();

  // Parse line items: "handle|sku xQty @ Price; ..."
  const lineItems: Array<Record<string, unknown>> = [];
  for (const segment of lineItemsRaw.split(";").map((s) => s.trim()).filter(Boolean)) {
    const match = segment.match(/^(.+?)\s+x(\d+)\s+@\s+([\d.]+)$/);
    if (!match) continue;
    const [, ref, qtyStr, price] = match;
    const quantity = parseInt(qtyStr, 10);
    const parts = ref.trim().split("|");
    const sku = parts[1]?.trim() ?? "";
    if (sku) {
      const vRes = await graphql(
        `query FindVariant($query: String!) {
          productVariants(first: 1, query: $query) { edges { node { id } } }
        }`,
        { query: `sku:${sku}` },
      );
      const vJson = (await vRes.json() as Record<string, unknown>).data as Record<string, unknown>;
      const variantId = ((vJson?.productVariants as Record<string, unknown>)
        ?.edges as Array<{ node: { id: string } }>)?.[0]?.node?.id;
      if (variantId) {
        lineItems.push({ variantId, quantity, appliedDiscount: null,
          originalUnitPrice: price });
      } else {
        lineItems.push({ title: parts[0]?.trim() ?? "Custom item", quantity,
          originalUnitPrice: price, requiresShipping: false, taxable: false });
      }
    } else {
      lineItems.push({ title: parts[0]?.trim() ?? "Custom item", quantity,
        originalUnitPrice: price, requiresShipping: false, taxable: false });
    }
  }

  // Look up by name if provided
  const name = (row["Name"] ?? "").trim();
  let existingId: string | undefined;
  if (name) {
    const sr = await graphql(
      `query FindDraftOrder($query: String!) {
        draftOrders(first: 1, query: $query) { edges { node { id } } }
      }`,
      { query: `name:${name}` },
    );
    existingId = (
      ((await sr.json() as Record<string, unknown>).data as Record<string, unknown>)
        ?.draftOrders as Record<string, unknown>
    )?.edges as unknown as string;
    if (Array.isArray(existingId)) {
      existingId = (existingId as Array<{ node: { id: string } }>)[0]?.node?.id;
    }
  }

  const input: Record<string, unknown> = {
    ...(email ? { email } : {}),
    note,
    tags,
    ...(lineItems.length > 0 ? { lineItems } : {}),
  };

  if (command === "DELETE") {
    if (!existingId) throw new Error(`Draft order "${name}" not found`);
    await gql(graphql,
      `mutation DraftOrderDelete($input: DraftOrderDeleteInput!) {
        draftOrderDelete(input: $input) { userErrors { field message } }
      }`,
      { input: { id: existingId } }, "draftOrderDelete");
    return;
  }

  if (existingId && command !== "NEW") {
    await gql(graphql,
      `mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
        draftOrderUpdate(id: $id, input: $input) { draftOrder { id } userErrors { field message } }
      }`,
      { id: existingId, input }, "draftOrderUpdate");
  } else {
    await gql(graphql,
      `mutation DraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) { draftOrder { id } userErrors { field message } }
      }`,
      { input }, "draftOrderCreate");
  }
}

// ─── Discounts ────────────────────────────────────────────────────────────────

async function importDiscount(row: Record<string, string>, graphql: GraphQLFn, command: string) {
  const title = (row["Title"] ?? "").trim();
  const code = (row["Code"] ?? "").trim();
  const type = (row["Type"] ?? "percentage").trim().toLowerCase();
  const value = parseFloat(row["Value"] ?? "0");
  const usageLimitRaw = (row["Usage Limit"] ?? "").trim();
  const usageLimit = usageLimitRaw ? parseInt(usageLimitRaw, 10) : null;
  const startsAt = (row["Starts At"] ?? "").trim() || null;
  const endsAt = (row["Ends At"] ?? "").trim() || null;

  if (!title) throw new Error("Title is required");
  if (!code) throw new Error("Code is required");

  if (command === "DELETE") {
    // Look up by code
    const sr = await graphql(
      `query FindDiscount($query: String!) {
        codeDiscountNodes(first: 1, query: $query) { edges { node { id } } }
      }`,
      { query: `code:${code}` },
    );
    const discountId = (
      ((await sr.json() as Record<string, unknown>).data as Record<string, unknown>)
        ?.codeDiscountNodes as Record<string, unknown>
    )?.edges as Array<{ node: { id: string } }>;
    const dId = discountId?.[0]?.node?.id;
    if (!dId) throw new Error(`Discount code "${code}" not found`);
    await gql(graphql,
      `mutation DiscountDelete($id: ID!) {
        discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { field message } }
      }`,
      { id: dId }, "discountCodeDelete");
    return;
  }

  const baseInput: Record<string, unknown> = {
    title,
    code,
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    ...(usageLimit !== null ? { usageLimit } : {}),
    appliesOncePerCustomer: false,
    customerSelection: { all: true },
    customerGets: {
      value: type === "percentage"
        ? { percentage: isNaN(value) ? 0 : value / 100 }
        : { discountAmount: { amount: String(isNaN(value) ? 0 : value), appliesOnEachItem: false } },
      items: { all: true },
    },
  };

  if (type === "free_shipping") {
    await gql(graphql,
      `mutation DiscountFreeShipping($input: DiscountCodeFreeShippingInput!) {
        discountCodeFreeShippingCreate(freeShippingCodeDiscount: $input) {
          codeDiscountNode { id } userErrors { field message }
        }
      }`,
      { input: { title, code, ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}),
        ...(usageLimit !== null ? { usageLimit } : {}), customerSelection: { all: true },
        minimumRequirement: { subTotal: { greaterThanOrEqualToSubtotal: "0" } } } },
      "discountCodeFreeShippingCreate");
  } else if (type === "percentage") {
    await gql(graphql,
      `mutation DiscountPercentage($input: DiscountCodePercentageInput!) {
        discountCodePercentageCreate(basicCodeDiscount: $input) {
          codeDiscountNode { id } userErrors { field message }
        }
      }`,
      { input: baseInput }, "discountCodePercentageCreate");
  } else {
    // fixed amount
    await gql(graphql,
      `mutation DiscountBasic($input: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $input) {
          codeDiscountNode { id } userErrors { field message }
        }
      }`,
      { input: baseInput }, "discountCodeBasicCreate");
  }
}

// ─── Pages ────────────────────────────────────────────────────────────────────

async function importPage(row: Record<string, string>, graphql: GraphQLFn, command: string) {
  const title = (row["Title"] ?? "").trim();
  if (!title) throw new Error("Title is required");
  const handle = (row["Handle"] ?? "").trim();
  const body = (row["Body HTML"] ?? "").trim();
  const isPublished = (row["Published"] ?? "true").toLowerCase() !== "false";

  let existingId: string | undefined;
  if (handle) {
    const lr = await graphql(
      `query FindPage($query: String!) {
        pages(first: 1, query: $query) { edges { node { id } } }
      }`,
      { query: `handle:${handle}` },
    );
    existingId = (
      ((await lr.json() as Record<string, unknown>).data as Record<string, unknown>)
        ?.pages as Record<string, unknown>
    )?.edges as unknown as string;
    if (Array.isArray(existingId)) {
      existingId = (existingId as Array<{ node: { id: string } }>)[0]?.node?.id;
    }
  }

  if (command === "DELETE") {
    if (!existingId) throw new Error(`Page "${handle}" not found`);
    await gql(graphql,
      `mutation PageDelete($id: ID!) {
        pageDelete(id: $id) { userErrors { field message } }
      }`,
      { id: existingId }, "pageDelete");
    return;
  }
  if (command === "NEW" && existingId) throw new Error(`Page "${handle}" already exists`);
  if (command === "UPDATE" && !existingId) throw new Error(`Page "${handle}" not found`);

  if (existingId) {
    await gql(graphql,
      `mutation PageUpdate($id: ID!, $page: PageUpdateInput!) {
        pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } }
      }`,
      { id: existingId, page: { title, body, isPublished } }, "pageUpdate");
  } else {
    await gql(graphql,
      `mutation PageCreate($page: PageCreateInput!) {
        pageCreate(page: $page) { page { id } userErrors { field message } }
      }`,
      { page: { title, handle, body, isPublished } }, "pageCreate");
  }
}

// ─── Blog Posts ───────────────────────────────────────────────────────────────

async function importBlogPost(row: Record<string, string>, graphql: GraphQLFn, command: string) {
  const blogHandle = (row["Blog Handle"] ?? "").trim();
  const title = (row["Title"] ?? "").trim();
  if (!title) throw new Error("Title is required");
  if (!blogHandle) throw new Error("Blog Handle is required");

  const contentHtml = (row["Content HTML"] ?? "").trim();
  const authorName = (row["Author"] ?? "").trim();
  const tags = (row["Tags"] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const isPublished = (row["Published"] ?? "true").toLowerCase() !== "false";
  const articleHandle = (row["Handle"] ?? "").trim();

  // Find the blog by handle
  const blogRes = await graphql(
    `query FindBlog($handle: String!) {
      blogByHandle(handle: $handle) { id }
    }`,
    { handle: blogHandle },
  );
  const blogJson = (await blogRes.json() as Record<string, unknown>).data as Record<string, unknown>;
  const blogId = (blogJson?.blogByHandle as Record<string, string>)?.id;
  if (!blogId) throw new Error(`Blog "${blogHandle}" not found`);

  // Look up existing article by handle within this blog
  let existingId: string | undefined;
  if (articleHandle) {
    const ar = await graphql(
      `query FindArticle($query: String!) {
        articles(first: 1, query: $query) { edges { node { id } } }
      }`,
      { query: `handle:${articleHandle} blog_id:${blogId.replace("gid://shopify/Blog/", "")}` },
    );
    const arJson = (await ar.json() as Record<string, unknown>).data as Record<string, unknown>;
    existingId = ((arJson?.articles as Record<string, unknown>)
      ?.edges as Array<{ node: { id: string } }>)?.[0]?.node?.id;
  }

  if (command === "DELETE") {
    if (!existingId) throw new Error(`Article "${articleHandle}" not found`);
    await gql(graphql,
      `mutation ArticleDelete($id: ID!) {
        articleDelete(id: $id) { userErrors { field message } }
      }`,
      { id: existingId }, "articleDelete");
    return;
  }
  if (command === "NEW" && existingId) throw new Error(`Article "${articleHandle}" already exists`);
  if (command === "UPDATE" && !existingId) throw new Error(`Article "${articleHandle}" not found`);

  const articleInput: Record<string, unknown> = {
    title, contentHtml, isPublished, tags,
    ...(authorName ? { author: { name: authorName } } : {}),
  };

  if (existingId) {
    await gql(graphql,
      `mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
        articleUpdate(id: $id, article: $article) { article { id } userErrors { field message } }
      }`,
      { id: existingId, article: articleInput }, "articleUpdate");
  } else {
    await gql(graphql,
      `mutation ArticleCreate($article: ArticleCreateInput!) {
        articleCreate(article: $article) { article { id } userErrors { field message } }
      }`,
      { article: { ...articleInput, blog: { id: blogId },
        ...(articleHandle ? { handle: articleHandle } : {}) } }, "articleCreate");
  }
}

// ─── Redirects ────────────────────────────────────────────────────────────────

async function importRedirect(row: Record<string, string>, graphql: GraphQLFn, command: string) {
  const redirectPath = (row["Path"] ?? "").trim();
  const target = (row["Target"] ?? "").trim();
  if (!redirectPath) throw new Error("Path is required");

  // Look up existing by path
  const lr = await graphql(
    `query FindRedirect($query: String!) {
      urlRedirects(first: 1, query: $query) { edges { node { id } } }
    }`,
    { query: `path:${redirectPath}` },
  );
  const lrj = (await lr.json() as Record<string, unknown>).data as Record<string, unknown>;
  const existingId = ((lrj?.urlRedirects as Record<string, unknown>)
    ?.edges as Array<{ node: { id: string } }>)?.[0]?.node?.id;

  if (command === "DELETE") {
    if (!existingId) throw new Error(`Redirect "${redirectPath}" not found`);
    await gql(graphql,
      `mutation RedirectDelete($id: ID!) {
        urlRedirectDelete(id: $id) { userErrors { field message } }
      }`,
      { id: existingId }, "urlRedirectDelete");
    return;
  }

  if (existingId) {
    await gql(graphql,
      `mutation RedirectUpdate($id: ID!, $urlRedirect: UrlRedirectInput!) {
        urlRedirectUpdate(id: $id, urlRedirect: $urlRedirect) {
          urlRedirect { id } userErrors { field message }
        }
      }`,
      { id: existingId, urlRedirect: { path: redirectPath, target } }, "urlRedirectUpdate");
  } else {
    await gql(graphql,
      `mutation RedirectCreate($urlRedirect: UrlRedirectInput!) {
        urlRedirectCreate(urlRedirect: $urlRedirect) {
          urlRedirect { id } userErrors { field message }
        }
      }`,
      { urlRedirect: { path: redirectPath, target } }, "urlRedirectCreate");
  }
}

// ─── Product Metafields ───────────────────────────────────────────────────────

async function importMetafield(row: Record<string, string>, graphql: GraphQLFn, command: string) {
  const productHandle = (row["Product Handle"] ?? "").trim();
  const namespace = (row["Namespace"] ?? "").trim();
  const key = (row["Key"] ?? "").trim();
  const type = (row["Type"] ?? "single_line_text_field").trim();
  const value = (row["Value"] ?? "").trim();

  if (!productHandle) throw new Error("Product Handle is required");
  if (!namespace) throw new Error("Namespace is required");
  if (!key) throw new Error("Key is required");

  // Resolve product GID
  const lr = await graphql(
    `query FindProduct($query: String!) {
      products(first: 1, query: $query) { edges { node { id } } }
    }`,
    { query: `handle:${productHandle}` },
  );
  const lrj = (await lr.json() as Record<string, unknown>).data as Record<string, unknown>;
  const productId = ((lrj?.products as Record<string, unknown>)
    ?.edges as Array<{ node: { id: string } }>)?.[0]?.node?.id;
  if (!productId) throw new Error(`Product "${productHandle}" not found`);

  if (command === "DELETE") {
    // Find the metafield ID first
    const mfRes = await graphql(
      `query FindMetafield($id: ID!, $namespace: String!, $key: String!) {
        product(id: $id) { metafield(namespace: $namespace, key: $key) { id } }
      }`,
      { id: productId, namespace, key },
    );
    const mfJson = (await mfRes.json() as Record<string, unknown>).data as Record<string, unknown>;
    const mfId = ((mfJson?.product as Record<string, unknown>)?.metafield as Record<string, string>)?.id;
    if (!mfId) throw new Error(`Metafield ${namespace}.${key} not found on product "${productHandle}"`);
    await gql(graphql,
      `mutation MetafieldDelete($input: MetafieldDeleteInput!) {
        metafieldDelete(input: $input) { deletedId userErrors { field message } }
      }`,
      { input: { id: mfId } }, "metafieldDelete");
    return;
  }

  await gql(graphql,
    `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
    }`,
    { metafields: [{ ownerId: productId, namespace, key, type, value }] }, "metafieldsSet");
}

// ─── File parsing ─────────────────────────────────────────────────────────────

async function parseFile(buffer: Buffer, filename: string): Promise<Array<Record<string, string>>> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return parseExcel(buffer);
  if (lower.endsWith(".csv")) return parseCSV(buffer);
  throw new Error("Unsupported format — use .xlsx, .xls, or .csv");
}

async function parseExcel(buffer: Buffer): Promise<Array<Record<string, string>>> {
  const workbook = new ExcelJS.Workbook();
  // @ts-ignore — Node.js 22 Buffer<T> vs ExcelJS Buffer type mismatch
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("No worksheet found");

  const rows: Array<Record<string, string>> = [];
  let headers: string[] = [];

  sheet.eachRow((row, rowNumber) => {
    const values = (row.values as unknown[]).slice(1);
    if (rowNumber === 1) {
      headers = values.map((v) => String(v ?? "").trim());
    } else {
      const record: Record<string, string> = {};
      headers.forEach((h, i) => { record[h] = String(values[i] ?? "").trim(); });
      if (Object.values(record).some((v) => v !== "")) rows.push(record);
    }
  });
  return rows;
}

function parseCSV(buffer: Buffer): Array<Record<string, string>> {
  return csvParse(buffer.toString("utf8"), {
    columns: true, skip_empty_lines: true, trim: true,
  }) as Array<Record<string, string>>;
}

// ─── Result file ──────────────────────────────────────────────────────────────

async function writeResultFile(rows: Array<Record<string, string>>, filename: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Import Results");

  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    sheet.addRow(headers);
    const hr = sheet.getRow(1);
    hr.font = { bold: true };
    hr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };

    rows.forEach((row) => sheet.addRow(headers.map((h) => row[h] ?? "")));

    const resultColIndex = headers.indexOf("Import Result") + 1;
    if (resultColIndex > 0) {
      sheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const cell = row.getCell(resultColIndex);
        const v = cell.value as string;
        if (v === "Updated" || v === "Created") {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD1FAE5" } };
        } else if (v === "Failed") {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEE2E2" } };
        } else if (v === "Skipped") {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3CD" } };
        } else if (v === "Deleted") {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE8E6" } };
        }
      });
    }
    sheet.columns.forEach((col) => { col.width = 22; });
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return saveFile(buffer, filename, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
