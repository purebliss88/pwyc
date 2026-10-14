/**
 * Pay What You Can - shared logic (you never need to edit this file).
 *
 * Settings come from Netlify > Site configuration > Environment variables:
 *   SQUARESPACE_API_KEY  (secret)   Squarespace Developer API key with Discounts read/write
 *   FULL_PRICE           e.g. 250   must match the course price in Squarespace
 *   MIN_PRICE            e.g. 5
 *   SUGGESTED_PRICE      e.g. 28    where the slider starts
 *   CURRENCY             e.g. USD
 *   ALLOWED_ORIGIN       e.g. https://themagickmechanic.com
 *   PRODUCT_ID           optional - locks every code to your course only
 *   ADMIN_TOKEN          optional - any long password; enables the product ID lookup page
 *   CODE_PREFIX          optional, default PWYC
 *   CODE_VALID_HOURS     optional, default 24
 */

const API_BASE = "https://api.squarespace.com/v1/commerce/discounts";
const USER_AGENT = "PWYC-Course-Widget/1.1";

export async function handleRequest(request, env) {
  const cfg = readConfig(env);
  const origin = request.headers.get("Origin") || "";
  const cors = corsHeaders(cfg, origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (origin && !isAllowedOrigin(cfg, origin)) {
    return json({ error: "Not allowed." }, 403, cors);
  }

  if (request.method === "GET") {
    const url = new URL(request.url);
    if (url.searchParams.has("admin")) {
      return adminLookup(cfg, url.searchParams.get("admin"));
    }
    return json(
      {
        fullPrice: cfg.fullPrice,
        minPrice: cfg.minPrice,
        suggestedPrice: cfg.suggestedPrice,
        currency: cfg.currency,
      },
      200,
      cors
    );
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405, cors);
  }

  if (!cfg.apiKey) {
    return json({ error: "Server is missing its Squarespace API key." }, 500, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Please enter an amount." }, 400, cors);
  }

  const amount = toCents(body && body.amount);
  if (amount === null) {
    return json({ error: "Please enter a valid amount." }, 400, cors);
  }

  const full = toCents(cfg.fullPrice);
  const min = toCents(cfg.minPrice);

  if (amount < min) {
    return json({ error: `The minimum is ${formatMoney(min, cfg.currency)}.` }, 400, cors);
  }

  if (amount >= full) {
    return json({ code: null, payAmount: full / 100, discount: 0 }, 200, cors);
  }

  const discountCents = full - amount;

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = `${cfg.prefix}-${randomCode(8)}`;
    const result = await createDiscount(cfg, code, discountCents);

    if (result.ok) {
      return json(
        {
          code,
          payAmount: amount / 100,
          discount: discountCents / 100,
          expiresInHours: cfg.validHours,
        },
        200,
        cors
      );
    }

    if (result.status !== 409) {
      console.log("Squarespace error", result.status, result.text);
      return json(
        { error: "Couldn't create your code right now. Please try again in a minute." },
        502,
        cors
      );
    }
  }

  return json({ error: "Please try again." }, 502, cors);
}

/* ---------- Squarespace calls ---------- */

async function createDiscount(cfg, code, discountCents) {
  const now = new Date();
  const expires = new Date(now.getTime() + cfg.validHours * 60 * 60 * 1000);

  const criteria = cfg.productId
    ? { type: "PRODUCT", productId: cfg.productId }
    : { type: "ANY_ORDER" };

  const payload = {
    name: `${cfg.prefix} ${formatMoney(discountCents, cfg.currency)} off`,
    criteria,
    template: {
      type: "FIXED_AMOUNT",
      discountAmount: { currency: cfg.currency, value: discountCents / 100 },
    },
    trigger: { type: "CODE", promoCode: code },
    isLimitedUses: true,
    maxUsesAllowed: 1,
    isOncePerCustomer: true,
    validFrom: now.toISOString(),
    validTo: expires.toISOString(),
  };

  const res = await fetch(API_BASE, {
    method: "POST",
    headers: sqspHeaders(cfg),
    body: JSON.stringify(payload),
  });

  return { ok: res.ok, status: res.status, text: res.ok ? "" : await res.text() };
}

// Visit  .../pwyc?admin=YOUR_ADMIN_TOKEN  in a browser to see your existing
// discounts and the product IDs they're tied to.
async function adminLookup(cfg, token) {
  const plain = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (!cfg.adminToken || token !== cfg.adminToken) {
    return new Response(JSON.stringify({ error: "Not allowed." }), { status: 403, headers: plain });
  }
  if (!cfg.apiKey) {
    return new Response(JSON.stringify({ error: "Missing Squarespace API key." }), { status: 500, headers: plain });
  }
  const res = await fetch(`${API_BASE}?status=ACTIVE&limit=100`, { headers: sqspHeaders(cfg) });
  const text = await res.text();
  if (!res.ok) {
    return new Response(JSON.stringify({ squarespaceStatus: res.status, squarespaceSays: text }, null, 2), { status: 502, headers: plain });
  }
  const data = JSON.parse(text);
  const summary = (data.discounts || [])
    .filter((d) => !(d.trigger && String(d.trigger.promoCode || "").startsWith(`${cfg.prefix}-`)))
    .map((d) => ({
      name: d.name,
      promoCode: d.trigger && d.trigger.promoCode,
      appliesTo: d.criteria,
    }));
  return new Response(
    JSON.stringify(
      {
        howToUse:
          "Find the test discount you tied to your course. Copy the productId under appliesTo into the PRODUCT_ID environment variable.",
        discounts: summary,
      },
      null,
      2
    ),
    { status: 200, headers: plain }
  );
}

export async function cleanupExpired(env) {
  const cfg = readConfig(env);
  if (!cfg.apiKey) return 0;
  const url = `${API_BASE}?status=EXPIRED&search=${encodeURIComponent(cfg.prefix)}&limit=200`;
  const res = await fetch(url, { headers: sqspHeaders(cfg) });
  if (!res.ok) {
    console.log("Cleanup list failed", res.status, await res.text());
    return 0;
  }
  const data = await res.json();
  const mine = (data.discounts || []).filter(
    (d) => d.trigger && String(d.trigger.promoCode || "").startsWith(`${cfg.prefix}-`)
  );
  for (const d of mine) {
    await fetch(`${API_BASE}/${d.id}`, { method: "DELETE", headers: sqspHeaders(cfg) });
  }
  console.log(`Cleanup removed ${mine.length} expired codes`);
  return mine.length;
}

function sqspHeaders(cfg) {
  return {
    Authorization: `Bearer ${cfg.apiKey}`,
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
  };
}

/* ---------- helpers ---------- */

function readConfig(env) {
  const get = (k) => (env[k] == null ? "" : String(env[k]).trim());
  const full = Number(get("FULL_PRICE") || 0);
  const min = Number(get("MIN_PRICE") || 0);
  const suggested = Number(get("SUGGESTED_PRICE") || full);
  return {
    apiKey: get("SQUARESPACE_API_KEY"),
    fullPrice: full,
    minPrice: min,
    suggestedPrice: Math.min(Math.max(suggested, min), full),
    currency: (get("CURRENCY") || "USD").toUpperCase(),
    allowedOrigin: get("ALLOWED_ORIGIN").replace(/\/+$/, ""),
    productId: get("PRODUCT_ID"),
    adminToken: get("ADMIN_TOKEN"),
    prefix: (get("CODE_PREFIX") || "PWYC").replace(/[^A-Za-z0-9_]/g, "").toUpperCase() || "PWYC",
    validHours: Number(get("CODE_VALID_HOURS") || 24),
  };
}

function isAllowedOrigin(cfg, origin) {
  if (!cfg.allowedOrigin) return true;
  const allowed = cfg.allowedOrigin.split(",").map((s) => s.trim().replace(/\/+$/, ""));
  const variants = allowed.flatMap((a) => [a, a.replace("://", "://www."), a.replace("://www.", "://")]);
  return variants.includes(origin);
}

function corsHeaders(cfg, origin) {
  const allow = origin && isAllowedOrigin(cfg, origin) ? origin : cfg.allowedOrigin || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function toCents(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000000) return null;
  return Math.round(n * 100);
}

function formatMoney(cents, currency) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function randomCode(len) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
