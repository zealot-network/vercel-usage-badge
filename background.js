// background.js — MV3 service worker
// Single source of truth for Vercel usage state; drives the badge.
//
// Reads the same cookie-authenticated dashboard APIs that power
// vercel.com/{team}/~/usage and ~/settings/billing:
//   GET /api/www/user
//   GET /api/teams
//   GET /api/v1/budgets
//   GET /api/v2/usage?type=…
//   GET /api/v1/billing/charges (JSONL, cached — spend totals)

const DEBUG = false;
const dbg = (...args) => { if (DEBUG) console.log("[Vercel Usage Tracker & Badge]", ...args); };

const DEFAULT_STATE = {
  team: {
    id: null,
    slug: null,
    name: null,
  },
  meters: [], // [{ key, label, used, limit, unit, utilization }]
  lineItems: [], // [{ label, amountUsd }] — cycle spend breakdown
  credit: {
    includedUsd: null,
    usedUsd: null, // amount of included credit consumed (capped at included)
    remainingUsd: null,
    utilization: null, // infra / included (may exceed 100)
  },
  onDemand: {
    enabled: null,
    status: null, // "on" | "off" | null — budget configured
    usedUsd: null, // on-demand charges this cycle (infra beyond credit)
    limitUsd: null, // spend-management budget, if any
    remainingUsd: null,
    utilization: null,
    overLimit: null,
  },
  spend: {
    infrastructureUsd: null,
    seatsUsd: null,
    totalEffectiveUsd: null,
    upcomingInvoiceUsd: null,
  },
  aiGateway: {
    balanceUsd: null,
  },
  subscriptionTier: null,
  billingCycleStart: null,
  billingCycleEnd: null,
  lastUpdated: null,
  lastErrorAt: null,
  lastError: null,
  errorCode: null, // 'no_session' | 'auth' | 'network' | 'unknown'
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function toEpoch(v) {
  if (!v) return null;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    return Number.isFinite(ms) ? ms : null;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function normalizeTier(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "enterprise" || s.includes("enterprise")) return "enterprise";
  if (s === "pro" || s.includes("pro")) return "pro";
  if (s === "hobby" || s === "free" || s.includes("hobby") || s.includes("free")) {
    return "hobby";
  }
  return s;
}

// Match Vercel dashboard display rounding: fractional <0.5% still shows 1%.
function displayPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct <= 0) return 0;
  const rounded = Math.round(pct);
  return rounded === 0 ? 1 : Math.min(999, rounded);
}

function utilization(used, limit) {
  if (used == null || limit == null || !(limit > 0)) return null;
  return (used / limit) * 100;
}

// ─── Badge rendering ────────────────────────────────────────────────────────

const COLOR_GREEN = "#15803D";
const COLOR_AMBER = "#B45309";
const COLOR_RED = "#B91C1C";
const COLOR_GREY = "#3F3F46";
const COLOR_PURPLE = "#8B5CF6";
const BADGE_TEXT = "#FFFFFF";

// Icon brand accents — Vercel blue ring + black/white triangle system.
const ICON_BLUE = "#0070F3";
const ICON_MARK = "#FFFFFF";
const ICON_BG = "#000000";
const ICON_TRACK = "#2A2A2A";

function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return (
    "#" +
    [r, g, b]
      .map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Blend two hex colors; t=0 → a, t=1 → b. */
function blendHex(a, b, t) {
  const u = Math.max(0, Math.min(1, t));
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex({
    r: Math.round(A.r + (B.r - A.r) * u),
    g: Math.round(A.g + (B.g - A.g) * u),
    b: Math.round(A.b + (B.b - A.b) * u),
  });
}

function trafficLightColor(util) {
  if (util >= 90) return COLOR_RED;
  if (util >= 70) return COLOR_AMBER;
  return COLOR_GREEN;
}

/** On-demand budget fill: Vercel blue → violet as budget burns. Over budget → red. */
function onDemandColor(util, overLimit) {
  if (overLimit) return COLOR_RED;
  const t = Math.max(0, Math.min(1, (util ?? 0) / 100));
  return blendHex(ICON_BLUE, COLOR_PURPLE, t);
}

function computeBadge(state) {
  const onDemand = state.onDemand || {};
  const credit = state.credit || {};
  const inOnDemand = onDemand.usedUsd != null && onDemand.usedUsd > 0;

  // Hobby meters are hard limits (usage pauses when they run out). On paid
  // plans they are Flat Rate CDN capacity: going over costs nothing this cycle
  // and only moves the team up a tier next cycle, so they must not turn the
  // badge red. They still show in the popup and tooltip.
  const metersAreLimits = state.subscriptionTier === "hobby";
  const meterUtils = [];
  for (const m of state.meters || []) {
    if (metersAreLimits && m?.utilization != null) meterUtils.push(m.utilization);
  }

  let text = "";
  let color = COLOR_GREY;
  let fillPct = 0;
  let ringColor = ICON_BLUE;
  let hasSignal = false;

  if (inOnDemand) {
    // Past included credit: badge tracks on-demand budget burn (not 200%+ credit util).
    hasSignal = true;
    if (onDemand.utilization != null) {
      const pct = displayPct(onDemand.utilization);
      text = `${pct}%`;
      fillPct = Math.max(0, Math.min(100, onDemand.utilization));
      color = onDemandColor(onDemand.utilization, onDemand.overLimit);
      ringColor = color;
    } else {
      // On-demand charges with no Spend Management budget configured.
      text = "OD";
      fillPct = 100;
      color = COLOR_PURPLE;
      ringColor = COLOR_PURPLE;
    }
  } else {
    // Within included credit: traffic-light on credit burn (and included meters).
    const candidates = [];
    if (credit.utilization != null) candidates.push(credit.utilization);
    candidates.push(...meterUtils);

    if (candidates.length > 0) {
      hasSignal = true;
      const worst = Math.max(...candidates);
      const pct = displayPct(worst);
      text = `${pct}%`;
      fillPct = Math.max(0, Math.min(100, worst));
      color = trafficLightColor(worst);
      ringColor = ICON_BLUE;
    }
  }

  if (!hasSignal) {
    if (state.lastError) {
      return {
        text: "!",
        color: COLOR_GREY,
        title: `Vercel Usage Tracker & Badge — ${state.lastError}`,
        fillPct: 0,
        ringColor: ICON_BLUE,
      };
    }
    return {
      text: "",
      color: COLOR_GREY,
      title: "Vercel Usage Tracker & Badge — no data yet",
      fillPct: 0,
      ringColor: ICON_BLUE,
    };
  }

  const parts = [];
  if (state.subscriptionTier) parts.push(`Plan: ${state.subscriptionTier}`);
  if (state.team?.slug) parts.push(state.team.slug);
  if (inOnDemand) {
    parts.push("On-demand");
    if (onDemand.usedUsd != null && onDemand.limitUsd != null) {
      const label = onDemand.overLimit ? "Budget: OVER" : "Budget";
      parts.push(
        `${label}: $${onDemand.usedUsd.toFixed(2)} / $${onDemand.limitUsd.toFixed(2)}` +
          (onDemand.utilization != null ? ` (${displayPct(onDemand.utilization)}%)` : "")
      );
    } else if (onDemand.usedUsd != null) {
      parts.push(`On-demand charges: $${onDemand.usedUsd.toFixed(2)}`);
    }
  }
  if (credit.includedUsd != null && credit.usedUsd != null) {
    parts.push(`Credit: $${credit.usedUsd.toFixed(2)} / $${credit.includedUsd.toFixed(2)}`);
  }
  for (const m of state.meters || []) {
    if (m?.utilization != null) {
      parts.push(`${m.label}: ${displayPct(m.utilization)}%`);
    }
  }
  if (state.billingCycleEnd) {
    const diff = state.billingCycleEnd - Date.now();
    if (diff > 0) {
      const days = Math.ceil(diff / 86400000);
      if (days >= 2) parts.push(`Resets in ${days}d`);
      else {
        const mins = Math.max(0, Math.round(diff / 60000));
        const hrs = Math.floor(mins / 60);
        const rm = mins % 60;
        parts.push(rm > 0 ? `Resets in ${hrs}h ${rm}m` : `Resets in ${hrs}h`);
      }
    }
  }
  if (state.lastError) parts.push(`Last refresh failed: ${state.lastError}`);

  return {
    text,
    color,
    title: parts.join(" · "),
    fillPct,
    ringColor,
  };
}

// ─── Dynamic toolbar icon (filled triangle + progress ring) ─────────────────

function paintTriangle(ctx, cx, cy, r) {
  // Point-up equilateral triangle (Vercel mark).
  const h = r * Math.sqrt(3);
  ctx.beginPath();
  ctx.moveTo(cx, cy - (2 / 3) * h);
  ctx.lineTo(cx + r, cy + (1 / 3) * h);
  ctx.lineTo(cx - r, cy + (1 / 3) * h);
  ctx.closePath();
}

function paintIcon(ctx, size, fillPct, ringColor) {
  const cx = size / 2;
  const cy = size / 2;
  ctx.clearRect(0, 0, size, size);

  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.48, 0, Math.PI * 2);
  ctx.fillStyle = ICON_BG;
  ctx.fill();

  const ringR = size * 0.38;
  const ringW = Math.max(2, size * 0.1);

  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = ICON_TRACK;
  ctx.lineWidth = ringW;
  ctx.lineCap = "round";
  ctx.stroke();

  const pct = Math.max(0, Math.min(100, fillPct || 0));
  if (pct > 0) {
    const start = -Math.PI / 2;
    const sweep = Math.max((pct / 100) * Math.PI * 2, 0.14);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, start, start + sweep);
    ctx.strokeStyle = ringColor || ICON_BLUE;
    ctx.lineWidth = ringW;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  paintTriangle(ctx, cx, cy + size * 0.02, size * 0.16);
  ctx.fillStyle = ICON_MARK;
  ctx.fill();
}

function drawIconBitmap(size, fillPct, ringColor) {
  const scale = 4;
  const big = size * scale;
  const hi = new OffscreenCanvas(big, big);
  const hctx = hi.getContext("2d");
  hctx.imageSmoothingEnabled = true;
  hctx.imageSmoothingQuality = "high";
  paintIcon(hctx, big, fillPct, ringColor);

  const lo = new OffscreenCanvas(size, size);
  const lctx = lo.getContext("2d");
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = "high";
  lctx.clearRect(0, 0, size, size);
  lctx.drawImage(hi, 0, 0, big, big, 0, 0, size, size);
  return lctx.getImageData(0, 0, size, size);
}

async function setProgressIcon(fillPct, ringColor) {
  try {
    const images = {
      16: drawIconBitmap(16, fillPct, ringColor),
      32: drawIconBitmap(32, fillPct, ringColor),
    };
    await chrome.action.setIcon({ imageData: images });
  } catch (e) {
    dbg("setProgressIcon failed:", e);
  }
}

async function refreshBadge() {
  const { usageState } = await chrome.storage.local.get("usageState");
  const state = usageState || DEFAULT_STATE;
  const { text, color, title, fillPct, ringColor } = computeBadge(state);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  try {
    await chrome.action.setBadgeTextColor({ color: BADGE_TEXT });
  } catch {
    // Older Chrome — auto text color is the graceful fallback.
  }
  await chrome.action.setTitle({ title });
  await setProgressIcon(fillPct ?? 0, ringColor || ICON_BLUE);
}

// ─── State writes (serialized) ──────────────────────────────────────────────

let writeQueue = Promise.resolve();

function mergeState(partial) {
  writeQueue = writeQueue
    .then(async () => {
      const { usageState } = await chrome.storage.local.get("usageState");
      const prev = usageState || DEFAULT_STATE;
      const next = {
        ...prev,
        ...partial,
        team: { ...DEFAULT_STATE.team, ...(prev.team || {}), ...(partial.team || {}) },
        credit: {
          ...DEFAULT_STATE.credit,
          ...(prev.credit || {}),
          ...(partial.credit || {}),
        },
        onDemand: {
          ...DEFAULT_STATE.onDemand,
          ...(prev.onDemand || {}),
          ...(partial.onDemand || {}),
        },
        spend: {
          ...DEFAULT_STATE.spend,
          ...(prev.spend || {}),
          ...(partial.spend || {}),
        },
        aiGateway: {
          ...DEFAULT_STATE.aiGateway,
          ...(prev.aiGateway || {}),
          ...(partial.aiGateway || {}),
        },
        meters: partial.meters != null ? partial.meters : prev.meters || [],
        lineItems: partial.lineItems != null ? partial.lineItems : prev.lineItems || [],
      };
      await chrome.storage.local.set({ usageState: next });
      await refreshBadge();
    })
    .catch((e) => dbg("mergeState error:", e));
  return writeQueue;
}

// ─── Auth / API ─────────────────────────────────────────────────────────────

async function hasSessionCookie() {
  try {
    const cookie = await chrome.cookies.get({
      name: "_v-session",
      url: "https://vercel.com",
    });
    if (cookie?.value) return true;
    // Fallback: isLoggedIn flag cookie.
    const flag = await chrome.cookies.get({
      name: "isLoggedIn",
      url: "https://vercel.com",
    });
    return !!(flag && flag.value);
  } catch {
    return false;
  }
}

class ApiError extends Error {
  constructor(status, endpoint) {
    super(`API ${status}: ${endpoint}`);
    this.name = "ApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

async function apiGet(endpoint) {
  const resp = await fetch(`https://vercel.com/api${endpoint}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new ApiError(resp.status, endpoint);
  try {
    return await resp.json();
  } catch {
    throw new ApiError(0, endpoint);
  }
}

async function apiGetText(endpoint) {
  const resp = await fetch(`https://vercel.com/api${endpoint}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new ApiError(resp.status, endpoint);
  return resp.text();
}

// ─── Throttle ───────────────────────────────────────────────────────────────

async function getThrottle() {
  try {
    const { throttle } = await chrome.storage.session.get("throttle");
    return throttle || {};
  } catch {
    return {};
  }
}

async function patchThrottle(partial) {
  try {
    const prev = await getThrottle();
    await chrome.storage.session.set({ throttle: { ...prev, ...partial } });
  } catch {
    // best-effort
  }
}

// ─── Usage parsing ──────────────────────────────────────────────────────────

function isoFromEpoch(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function sumUsageFields(rows) {
  const totals = {};
  for (const row of rows || []) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        totals[k] = (totals[k] || 0) + v;
      }
    }
  }
  return totals;
}

function pickField(totals, ...names) {
  for (const n of names) {
    if (typeof totals[n] === "number" && Number.isFinite(totals[n])) return totals[n];
  }
  return null;
}

async function fetchUsageTotals(teamId, fromIso, toIso, type) {
  const q = new URLSearchParams({
    teamId,
    type,
    from: fromIso,
    to: toIso,
  });
  const data = await apiGet(`/v2/usage?${q}`);
  return sumUsageFields(data?.data || []);
}

// ─── Charges (FOCUS JSONL) ──────────────────────────────────────────────────

const CHARGES_CACHE_KEY = "chargesCache";
const CHARGES_CACHE_VERSION = 2;
const CHARGES_FULL_REBUILD_MS = 6 * 60 * 60_000;
const DAY_MS = 86400000;

/**
 * Seats, the plan platform fee, and paid add-ons (Observability Plus, SAML, …)
 * are billed monthly. They never draw down the included credit and are not
 * part of the on-demand budget, so they must stay out of infrastructure spend.
 */
function isSubscriptionCharge(name, category) {
  if (/subscription|license/i.test(category || "")) return true;
  return /^(Pro|Hobby|Enterprise)$/i.test(name || "") || /seat|license/i.test(name || "");
}

/** Add one JSONL payload into a { service: { cost, category } } map. */
function accumulateCharges(text, into) {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let c;
    try {
      c = JSON.parse(line);
    } catch {
      continue;
    }
    const cost = Number(c.EffectiveCost || 0);
    if (!Number.isFinite(cost)) continue;
    const service = c.ServiceName || "Unknown";
    const row = into[service] || (into[service] = { cost: 0, category: null });
    row.cost += cost;
    if (!row.category && c.ServiceCategory) row.category = c.ServiceCategory;
  }
  return into;
}

function mergeCharges(a, b) {
  const out = {};
  for (const src of [a, b]) {
    for (const [name, row] of Object.entries(src || {})) {
      const dst = out[name] || (out[name] = { cost: 0, category: null });
      dst.cost += Number(row?.cost) || 0;
      if (!dst.category && row?.category) dst.category = row.category;
    }
  }
  return out;
}

function summarizeCharges(services) {
  let totalEffective = 0;
  let seatsUsd = 0;
  let infrastructureUsd = 0;
  const byService = {};
  const lineItems = [];

  for (const [name, row] of Object.entries(services)) {
    const cost = Number(row.cost) || 0;
    totalEffective += cost;
    byService[name] = cost;
    if (isSubscriptionCharge(name, row.category)) {
      seatsUsd += cost;
    } else {
      infrastructureUsd += cost;
      if (cost > 0.004) lineItems.push({ label: name, amountUsd: cost });
    }
  }
  lineItems.sort((a, b) => b.amountUsd - a.amountUsd);

  return {
    totalEffectiveUsd: totalEffective,
    seatsUsd, // plan fee + seats + monthly add-ons
    infrastructureUsd,
    byService,
    lineItems,
  };
}

async function fetchChargesWindow(teamId, fromIso, toIso) {
  const q = new URLSearchParams({ teamId, from: fromIso, to: toIso });
  const text = await apiGetText(`/v1/billing/charges?${q}`);
  return accumulateCharges(text, {});
}

/**
 * Service totals for the two slow-moving parts of the cycle:
 *   settled  [from, closedTo)   days that ended more than 24h ago
 *   future   [nearEnd, to)      days that have not started yet
 * Vercel returns charge rows for every day of the cycle, including future
 * ones (zero-usage rows plus the pre-billed plan fee and seats), so a busy
 * team's cycle is tens of MB. Both parts are kept in storage and rebuilt only
 * every few hours, when the day changes, or on manual refresh. Everything in
 * between is the small "open" window the caller fetches on each refresh.
 */
async function loadCycleCache(teamId, fromIso, toIso, closedToMs, nearEndMs) {
  let cache = null;
  try {
    cache = (await chrome.storage.local.get(CHARGES_CACHE_KEY))[CHARGES_CACHE_KEY] || null;
  } catch {
    cache = null;
  }
  if (
    cache &&
    cache.v === CHARGES_CACHE_VERSION &&
    cache.teamId === teamId &&
    cache.fromIso === fromIso &&
    cache.toIso === toIso &&
    cache.closedToMs === closedToMs &&
    cache.nearEndMs === nearEndMs &&
    Date.now() - (cache.builtAt || 0) < CHARGES_FULL_REBUILD_MS
  ) {
    return { settled: cache.settled || {}, future: cache.future || {} };
  }

  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  const iso = (ms) => new Date(ms).toISOString();
  const [settled, future] = await Promise.all([
    closedToMs > fromMs ? fetchChargesWindow(teamId, fromIso, iso(closedToMs)) : {},
    nearEndMs < toMs ? fetchChargesWindow(teamId, iso(nearEndMs), toIso) : {},
  ]);

  try {
    await chrome.storage.local.set({
      [CHARGES_CACHE_KEY]: {
        v: CHARGES_CACHE_VERSION,
        teamId,
        fromIso,
        toIso,
        closedToMs,
        nearEndMs,
        builtAt: Date.now(),
        settled,
        future,
      },
    });
  } catch {
    // best-effort
  }
  return { settled, future };
}

async function fetchSpendFromCharges(teamId, fromIso, toIso) {
  // 15-minute cache of the finished summary.
  const throttle = await getThrottle();
  if (
    throttle.spendCache &&
    throttle.spendCache.teamId === teamId &&
    throttle.spendCache.fromIso === fromIso &&
    Date.now() - (throttle.spendCache.at || 0) < 15 * 60_000
  ) {
    return throttle.spendCache.value;
  }

  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  let services;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    services = await fetchChargesWindow(teamId, fromIso, toIso);
  } else {
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    // Open window: yesterday through the end of tomorrow (UTC), clamped to the cycle.
    const closedToMs = Math.min(Math.max(today - DAY_MS, fromMs), toMs);
    const nearEndMs = Math.max(Math.min(today + 2 * DAY_MS, toMs), closedToMs);
    const [{ settled, future }, open] = await Promise.all([
      loadCycleCache(teamId, fromIso, toIso, closedToMs, nearEndMs),
      nearEndMs > closedToMs
        ? fetchChargesWindow(
            teamId,
            new Date(closedToMs).toISOString(),
            new Date(nearEndMs).toISOString()
          )
        : {},
    ]);
    services = mergeCharges(mergeCharges(settled, future), open);
  }

  const value = summarizeCharges(services);
  await patchThrottle({
    spendCache: { teamId, fromIso, at: Date.now(), value },
  });
  return value;
}

/**
 * Vercel has shipped two budget shapes:
 *   legacy  { isActive: true, fixedBudget: 200 }
 *   current { status: "active", amount: "200", scope: "team", thresholds: [...] }
 * Normalize both to { isActive, fixedBudget, scope }.
 */
function normalizeBudget(b) {
  const rawAmount = b.fixedBudget ?? b.amount;
  const amount = typeof rawAmount === "string" ? Number(rawAmount) : rawAmount;
  const isActive =
    typeof b.isActive === "boolean"
      ? b.isActive
      : typeof b.status === "string"
        ? b.status.toLowerCase() === "active"
        : false;
  return {
    isActive,
    fixedBudget: numOrNull(amount),
    scope: typeof b.scope === "string" ? b.scope.toLowerCase() : null,
  };
}

async function fetchBudgets(teamId) {
  try {
    const data = await apiGet(`/v1/budgets?teamId=${encodeURIComponent(teamId)}`);
    const list = (data?.data || []).filter(Boolean).map(normalizeBudget);
    // Prefer the active team-wide budget; project-scoped budgets are not the
    // team's on-demand cap.
    const teamWide = list.filter((b) => !b.scope || b.scope === "team");
    const pool = teamWide.length ? teamWide : list;
    return pool.find((b) => b.isActive) || pool[0] || null;
  } catch (e) {
    dbg("budgets failed:", e);
    return null;
  }
}

async function fetchAiGatewayBalance(teamId) {
  try {
    const data = await apiGet(
      `/ai/ai-credits-balance?teamId=${encodeURIComponent(teamId)}`
    );
    const raw = data?.cumulativeBalance;
    const n = typeof raw === "string" ? Number(raw) : numOrNull(raw);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    dbg("ai gateway balance failed:", e);
    return null;
  }
}

function buildMeters(invoiceItems, requestTotals) {
  const meters = [];
  const edgeLimit = numOrNull(invoiceItems?.edgeRequest?.threshold);
  const fdtLimitGb = numOrNull(invoiceItems?.fastDataTransfer?.threshold);

  // CDN requests (formerly "Edge Requests") — prefer dedicated counters; fall back to hit+miss.
  const edgeUsed =
    pickField(
      requestTotals,
      "edge_request_count",
      "edge_requests",
      "request_count"
    ) ??
    (() => {
      const hit = pickField(requestTotals, "request_hit_count") || 0;
      const miss = pickField(requestTotals, "request_miss_count") || 0;
      const sum = hit + miss;
      return sum > 0 ? sum : null;
    })();

  if (edgeLimit != null && edgeLimit > 0 && edgeUsed != null) {
    meters.push({
      key: "edgeRequest",
      label: "CDN Requests",
      used: edgeUsed,
      limit: edgeLimit,
      unit: "requests",
      utilization: utilization(edgeUsed, edgeLimit),
    });
  }

  // Fast Data Transfer — outgoing bandwidth in bytes → GB vs threshold in GB.
  const bytes = pickField(
    requestTotals,
    "bandwidth_outgoing_bytes",
    "fast_data_transfer_bytes",
    "bandwidth_bytes"
  );
  if (fdtLimitGb != null && fdtLimitGb > 0 && bytes != null) {
    const usedGb = bytes / 1e9;
    meters.push({
      key: "fastDataTransfer",
      label: "Fast Data Transfer",
      used: usedGb,
      limit: fdtLimitGb,
      unit: "GB",
      utilization: utilization(usedGb, fdtLimitGb),
    });
  }

  return meters;
}

function pickTeam(teamsPayload, userPayload) {
  const teams = teamsPayload?.teams || [];
  if (!teams.length) return null;
  const defaultId = userPayload?.user?.defaultTeamId || null;
  if (defaultId) {
    const match = teams.find((t) => t.id === defaultId);
    if (match) return match;
  }
  // Prefer a team with an active paid plan.
  const paid = teams.find((t) => {
    const plan = t?.billing?.plan;
    return plan && plan !== "hobby" && plan !== "free";
  });
  return paid || teams[0];
}

// ─── Main fetch cycle ───────────────────────────────────────────────────────

let inFlight = null;

function fetchUsageAndUpdate(force = false) {
  if (inFlight) return inFlight;
  inFlight = doFetchUsage(force).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doFetchUsage(force = false) {
  if (!force) {
    const { backoffUntil = 0 } = await getThrottle();
    if (Date.now() < backoffUntil) return;
  }

  try {
    const signedIn = await hasSessionCookie();
    if (!signedIn) {
      await mergeState({
        lastError: "Not signed in to Vercel.",
        errorCode: "no_session",
        lastErrorAt: Date.now(),
      });
      return;
    }

    const [userPayload, teamsPayload] = await Promise.all([
      apiGet("/www/user"),
      apiGet("/teams?flags=true&permissions=true&entitlements=true"),
    ]);

    const team = pickTeam(teamsPayload, userPayload);
    if (!team) {
      await mergeState({
        lastError: "No Vercel team found for this session.",
        errorCode: "unknown",
        lastErrorAt: Date.now(),
      });
      return;
    }

    const billing = team.billing || {};
    const periodStart = toEpoch(billing.period?.start);
    const periodEnd = toEpoch(billing.period?.end);
    const fromIso = isoFromEpoch(periodStart) || new Date(Date.now() - 30 * 86400000).toISOString();
    const toIso = isoFromEpoch(periodEnd) || new Date().toISOString();

    const includedUsd = numOrNull(billing.invoiceItems?.includedAllocationUsd?.quantity);

    const [requestTotals, budget, spend, aiBalance] = await Promise.all([
      fetchUsageTotals(team.id, fromIso, toIso, "requests").catch((e) => {
        dbg("usage requests failed:", e);
        return {};
      }),
      fetchBudgets(team.id),
      fetchSpendFromCharges(team.id, fromIso, toIso).catch((e) => {
        dbg("charges failed:", e);
        return null;
      }),
      fetchAiGatewayBalance(team.id),
    ]);

    const meters = buildMeters(billing.invoiceItems || {}, requestTotals);

    const infraUsd = numOrNull(spend?.infrastructureUsd);
    const creditUsed = infraUsd != null ? Math.min(infraUsd, includedUsd ?? infraUsd) : null;
    const creditUtil = utilization(infraUsd, includedUsd);

    const budgetLimit = numOrNull(budget?.fixedBudget);
    const budgetActive = !!(budget && budget.isActive && budgetLimit != null && budgetLimit > 0);
    const onDemandUsed =
      infraUsd != null && includedUsd != null
        ? Math.max(0, infraUsd - includedUsd)
        : infraUsd != null && includedUsd == null
          ? infraUsd
          : null;
    const onDemandUtil = budgetActive ? utilization(onDemandUsed, budgetLimit) : null;
    const overLimit =
      budgetActive && onDemandUsed != null && onDemandUsed > budgetLimit;

    const upcoming =
      infraUsd != null && includedUsd != null
        ? Math.max(0, infraUsd - includedUsd) + (numOrNull(spend?.seatsUsd) || 0)
        : numOrNull(spend?.totalEffectiveUsd);

    await patchThrottle({ backoffUntil: 0 });
    await mergeState({
      team: {
        id: team.id || null,
        slug: team.slug || null,
        name: team.name || null,
      },
      meters,
      lineItems: spend?.lineItems || [],
      credit: {
        includedUsd,
        usedUsd: creditUsed,
        remainingUsd:
          includedUsd != null && infraUsd != null
            ? Math.max(0, includedUsd - infraUsd)
            : null,
        utilization: creditUtil,
      },
      onDemand: {
        enabled: budgetActive,
        status: budgetActive ? "on" : budget ? "off" : null,
        usedUsd: onDemandUsed,
        limitUsd: budgetActive ? budgetLimit : null,
        remainingUsd:
          budgetActive && onDemandUsed != null
            ? Math.max(0, budgetLimit - onDemandUsed)
            : null,
        utilization: onDemandUtil,
        overLimit,
      },
      spend: {
        infrastructureUsd: infraUsd,
        seatsUsd: numOrNull(spend?.seatsUsd),
        totalEffectiveUsd: numOrNull(spend?.totalEffectiveUsd),
        upcomingInvoiceUsd: upcoming,
      },
      aiGateway: {
        balanceUsd: aiBalance,
      },
      subscriptionTier: normalizeTier(billing.plan),
      billingCycleStart: periodStart,
      billingCycleEnd: periodEnd,
      lastUpdated: Date.now(),
      lastError: null,
      errorCode: null,
    });
  } catch (err) {
    console.error("[Vercel Usage Tracker & Badge] fetch error:", err);
    let errorCode = "unknown";
    let lastError = err.message || "Failed to fetch usage";
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403) {
        errorCode = "auth";
        lastError = "Vercel session expired or unauthorized.";
      } else if (err.status === 404) {
        errorCode = "unknown";
        lastError = "Vercel usage API not found — the API may have changed.";
      } else if (err.status === 429) {
        errorCode = "network";
        lastError = "Rate limited by vercel.com — backing off.";
        await patchThrottle({ backoffUntil: Date.now() + 5 * 60_000 });
      } else if (err.status === 0) {
        errorCode = "network";
        lastError = "Unexpected non-JSON response from vercel.com.";
      } else {
        errorCode = "network";
      }
    } else if (err instanceof TypeError) {
      errorCode = "network";
      lastError = "Network error reaching vercel.com.";
    }
    await mergeState({ lastError, errorCode, lastErrorAt: Date.now() });
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.local.set({ usageState: DEFAULT_STATE });
  } else {
    const { usageState } = await chrome.storage.local.get("usageState");
    await chrome.storage.local.set({
      usageState: {
        ...DEFAULT_STATE,
        ...(usageState || {}),
        team: { ...DEFAULT_STATE.team, ...((usageState && usageState.team) || {}) },
        credit: {
          ...DEFAULT_STATE.credit,
          ...((usageState && usageState.credit) || {}),
        },
        onDemand: {
          ...DEFAULT_STATE.onDemand,
          ...((usageState && usageState.onDemand) || {}),
        },
        spend: {
          ...DEFAULT_STATE.spend,
          ...((usageState && usageState.spend) || {}),
        },
        aiGateway: {
          ...DEFAULT_STATE.aiGateway,
          ...((usageState && usageState.aiGateway) || {}),
        },
        meters: (usageState && usageState.meters) || [],
        lineItems: (usageState && usageState.lineItems) || [],
      },
    });
  }
  await refreshBadge();
  fetchUsageAndUpdate();
});

refreshBadge().catch(() => {});

chrome.alarms.get("refreshUsage").then((existing) => {
  if (!existing) chrome.alarms.create("refreshUsage", { periodInMinutes: 3 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshUsage") fetchUsageAndUpdate();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GET_USAGE_STATE") {
    chrome.storage.local
      .get("usageState")
      .then(({ usageState }) => sendResponse(usageState || DEFAULT_STATE))
      .catch(() => sendResponse(DEFAULT_STATE));
    return true;
  }
  if (msg?.type === "FORCE_REFRESH" || msg?.type === "VERCEL_USAGE_UPDATE") {
    // Bust spend caches on manual refresh (forces a full charges rebuild).
    Promise.allSettled([
      patchThrottle({ spendCache: null }),
      chrome.storage.local.remove(CHARGES_CACHE_KEY),
    ]).finally(() => {
      fetchUsageAndUpdate(true)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
    });
    return true;
  }
});
