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
const dbg = (...args) => { if (DEBUG) console.log("[Vercel Usage Badge]", ...args); };

const DEFAULT_STATE = {
  team: {
    id: null,
    slug: null,
    name: null,
  },
  meters: [], // [{ key, label, used, limit, unit, utilization }]
  credit: {
    includedUsd: null,
    usedUsd: null,
    remainingUsd: null,
    utilization: null,
  },
  onDemand: {
    enabled: null,
    status: null, // "on" | "off" | null
    usedUsd: null,
    limitUsd: null,
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
const BADGE_TEXT = "#FFFFFF";

// Icon brand accents — Vercel blue ring + black/white triangle system.
const ICON_BLUE = "#0070F3";
const ICON_MARK = "#FFFFFF";
const ICON_BG = "#000000";
const ICON_TRACK = "#2A2A2A";

function computeBadge(state) {
  const candidates = [];
  for (const m of state.meters || []) {
    if (m?.utilization != null) candidates.push(m.utilization);
  }
  if (state.credit?.utilization != null) candidates.push(state.credit.utilization);
  if (state.onDemand?.utilization != null) candidates.push(state.onDemand.utilization);

  const onDemand = state.onDemand || {};

  if (candidates.length === 0) {
    if (state.lastError) {
      return {
        text: "!",
        color: COLOR_GREY,
        title: `Vercel Usage Badge — ${state.lastError}`,
        fillPct: 0,
      };
    }
    return {
      text: "",
      color: COLOR_GREY,
      title: "Vercel Usage Badge — no data yet",
      fillPct: 0,
    };
  }

  const worst = Math.max(...candidates);
  const pct = displayPct(worst);
  const text = `${pct}%`;

  let color;
  if (onDemand.overLimit) color = COLOR_RED;
  else if (worst >= 90) color = COLOR_RED;
  else if (worst >= 70) color = COLOR_AMBER;
  else color = COLOR_GREEN;

  const parts = [];
  if (state.subscriptionTier) parts.push(`Plan: ${state.subscriptionTier}`);
  if (state.team?.slug) parts.push(state.team.slug);
  for (const m of state.meters || []) {
    if (m?.utilization != null) {
      parts.push(`${m.label}: ${displayPct(m.utilization)}%`);
    }
  }
  if (state.credit?.includedUsd != null && state.credit?.usedUsd != null) {
    parts.push(
      `Credit: $${state.credit.usedUsd.toFixed(2)} / $${state.credit.includedUsd.toFixed(2)}`
    );
  }
  if (onDemand.status === "on") {
    const label = onDemand.overLimit ? "On-demand budget: OVER" : "On-demand budget";
    if (onDemand.usedUsd != null && onDemand.limitUsd != null) {
      parts.push(
        `${label}: $${onDemand.usedUsd.toFixed(2)} / $${onDemand.limitUsd.toFixed(2)}` +
          (onDemand.utilization != null ? ` (${displayPct(onDemand.utilization)}%)` : "")
      );
    } else {
      parts.push(label);
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
    fillPct: Math.max(0, Math.min(100, worst)),
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

function paintIcon(ctx, size, fillPct) {
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
    ctx.strokeStyle = ICON_BLUE;
    ctx.lineWidth = ringW;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  paintTriangle(ctx, cx, cy + size * 0.02, size * 0.16);
  ctx.fillStyle = ICON_MARK;
  ctx.fill();
}

function drawIconBitmap(size, fillPct) {
  const scale = 4;
  const big = size * scale;
  const hi = new OffscreenCanvas(big, big);
  const hctx = hi.getContext("2d");
  hctx.imageSmoothingEnabled = true;
  hctx.imageSmoothingQuality = "high";
  paintIcon(hctx, big, fillPct);

  const lo = new OffscreenCanvas(size, size);
  const lctx = lo.getContext("2d");
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = "high";
  lctx.clearRect(0, 0, size, size);
  lctx.drawImage(hi, 0, 0, big, big, 0, 0, size, size);
  return lctx.getImageData(0, 0, size, size);
}

async function setProgressIcon(fillPct) {
  try {
    const images = {
      16: drawIconBitmap(16, fillPct),
      32: drawIconBitmap(32, fillPct),
    };
    await chrome.action.setIcon({ imageData: images });
  } catch (e) {
    dbg("setProgressIcon failed:", e);
  }
}

async function refreshBadge() {
  const { usageState } = await chrome.storage.local.get("usageState");
  const state = usageState || DEFAULT_STATE;
  const { text, color, title, fillPct } = computeBadge(state);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  try {
    await chrome.action.setBadgeTextColor({ color: BADGE_TEXT });
  } catch {
    // Older Chrome — auto text color is the graceful fallback.
  }
  await chrome.action.setTitle({ title });
  await setProgressIcon(fillPct ?? 0);
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
        meters: partial.meters != null ? partial.meters : prev.meters || [],
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

async function fetchSpendFromCharges(teamId, fromIso, toIso) {
  // 15-minute cache — the JSONL payload can be large.
  const throttle = await getThrottle();
  if (
    throttle.spendCache &&
    throttle.spendCache.teamId === teamId &&
    throttle.spendCache.fromIso === fromIso &&
    Date.now() - (throttle.spendCache.at || 0) < 15 * 60_000
  ) {
    return throttle.spendCache.value;
  }

  const q = new URLSearchParams({ teamId, from: fromIso, to: toIso });
  const text = await apiGetText(`/v1/billing/charges?${q}`);
  let totalEffective = 0;
  let seatsUsd = 0;
  let infrastructureUsd = 0;
  const byService = {};

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
    totalEffective += cost;
    const service = c.ServiceName || "Unknown";
    byService[service] = (byService[service] || 0) + cost;
    if (service === "Pro" || service === "Hobby" || /seat|license/i.test(service)) {
      seatsUsd += cost;
    } else {
      infrastructureUsd += cost;
    }
  }

  const value = {
    totalEffectiveUsd: totalEffective,
    seatsUsd,
    infrastructureUsd,
    byService,
  };
  await patchThrottle({
    spendCache: { teamId, fromIso, at: Date.now(), value },
  });
  return value;
}

async function fetchBudgets(teamId) {
  try {
    const data = await apiGet(`/v1/budgets?teamId=${encodeURIComponent(teamId)}`);
    const list = data?.data || [];
    const active = list.find((b) => b && b.isActive) || list[0] || null;
    return active;
  } catch (e) {
    dbg("budgets failed:", e);
    return null;
  }
}

function buildMeters(invoiceItems, requestTotals) {
  const meters = [];
  const edgeLimit = numOrNull(invoiceItems?.edgeRequest?.threshold);
  const fdtLimitGb = numOrNull(invoiceItems?.fastDataTransfer?.threshold);

  // Edge requests — prefer dedicated counters; fall back to hit+miss.
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
      label: "Edge Requests",
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

    const [requestTotals, budget, spend] = await Promise.all([
      fetchUsageTotals(team.id, fromIso, toIso, "requests").catch((e) => {
        dbg("usage requests failed:", e);
        return {};
      }),
      fetchBudgets(team.id),
      fetchSpendFromCharges(team.id, fromIso, toIso).catch((e) => {
        dbg("charges failed:", e);
        return null;
      }),
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
      subscriptionTier: normalizeTier(billing.plan),
      billingCycleStart: periodStart,
      billingCycleEnd: periodEnd,
      lastUpdated: Date.now(),
      lastError: null,
      errorCode: null,
    });
  } catch (err) {
    console.error("[Vercel Usage Badge] fetch error:", err);
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
        meters: (usageState && usageState.meters) || [],
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
    // Bust spend cache on manual refresh.
    patchThrottle({ spendCache: null }).finally(() => {
      fetchUsageAndUpdate(true)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
    });
    return true;
  }
});
