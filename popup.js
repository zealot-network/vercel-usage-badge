// popup.js — Reads UsageState from storage and renders the Vercel-styled popup.

const DEFAULT_STATE = {
  team: { id: null, slug: null, name: null },
  meters: [],
  lineItems: [],
  credit: {
    includedUsd: null,
    usedUsd: null,
    remainingUsd: null,
    utilization: null,
  },
  onDemand: {
    enabled: null,
    status: null,
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
  aiGateway: { balanceUsd: null },
  subscriptionTier: null,
  billingCycleStart: null,
  billingCycleEnd: null,
  lastUpdated: null,
  lastErrorAt: null,
  lastError: null,
  errorCode: null,
};

function usageUrl(state) {
  const slug = state?.team?.slug;
  return slug ? `https://vercel.com/${slug}/~/usage` : "https://vercel.com/dashboard";
}

function billingUrl(state) {
  const slug = state?.team?.slug;
  return slug
    ? `https://vercel.com/${slug}/~/settings/billing`
    : "https://vercel.com/dashboard";
}

const ERROR_COPY = {
  no_session: {
    title: "Sign in to Vercel",
    body:
      "We couldn't find a Vercel session. To load your usage data:<ol>" +
      "<li>Open <strong>vercel.com/dashboard</strong> and sign in</li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
  auth: {
    title: "Vercel session expired",
    body:
      "Your Vercel session has expired or isn't authorized. To reconnect:<ol>" +
      "<li>Open <strong>vercel.com/dashboard</strong> and sign in if prompted</li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
  network: {
    title: "Can't reach vercel.com",
    body:
      "We hit a network error fetching your usage. To retry:<ol>" +
      "<li>Open <strong>vercel.com/dashboard</strong> to confirm you're online</li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
  unknown: {
    title: "Couldn't load usage",
    body:
      "Something went wrong reading your usage. To retry:<ol>" +
      "<li>Open your team's <strong>Usage</strong> page on vercel.com</li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
};

function barColor(pct) {
  if (pct >= 90) return "var(--red)";
  if (pct >= 70) return "var(--amber)";
  return "var(--green)";
}

// Capacity is not a spend limit, so it never goes red: blue, then amber past 100%.
function capacityColor(pct) {
  return pct >= 100 ? "var(--amber)" : "var(--blue)";
}

function displayPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct <= 0) return 0;
  const rounded = Math.round(pct);
  return rounded === 0 ? 1 : Math.min(999, rounded);
}

function formatPct(pct) {
  const n = displayPct(pct);
  if (n == null) return "—";
  return `${n}%`;
}

function formatMoney(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return "$0.00"; // never "$-0.00"
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

function formatResetTime(ts) {
  if (!ts) return "";
  const diff = ts - Date.now();
  if (diff <= 0) return "Resets soon";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `Resets in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) {
    const rm = mins % 60;
    return rm > 0 ? `Resets in ${hrs}h ${rm}m` : `Resets in ${hrs}h`;
  }
  const days = Math.max(1, Math.ceil(diff / 86400000));
  return `Resets in ${days}d`;
}

function formatCycleDate(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return "";
  }
}

function formatLastUpdated(ts) {
  if (!ts) return "No data yet";
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins <= 0) return "Just now";
  if (mins === 1) return "1m ago";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function formatTier(tier) {
  if (!tier) return "—";
  const map = {
    hobby: "Hobby",
    free: "Hobby",
    pro: "Pro",
    enterprise: "Enterprise",
  };
  return map[tier] || tier;
}

function formatCompact(n, unit) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (unit === "GB") {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} TB`;
    if (n >= 10) return `${Math.round(n)} GB`;
    if (n >= 1) return `${n.toFixed(1)} GB`;
    return `${(n * 1024).toFixed(0)} MB`;
  }
  if (unit === "requests") {
    const trim = (v) => v.replace(/\.?0+$/, "");
    if (n >= 1e6) return `${trim((n / 1e6).toFixed(n >= 1e7 ? 1 : 2))}M`;
    if (n >= 1e3) return `${n >= 1e5 ? (n / 1e3).toFixed(0) : trim((n / 1e3).toFixed(2))}K`;
    return `${Math.round(n)}`;
  }
  return String(Math.round(n * 100) / 100);
}

function hasUsageData(state) {
  return !!(
    (state.meters && state.meters.length) ||
    (state.lineItems && state.lineItems.length) ||
    state.credit?.includedUsd != null ||
    state.onDemand?.usedUsd != null ||
    state.spend?.infrastructureUsd != null ||
    state.aiGateway?.balanceUsd != null
  );
}

function render(state) {
  const $ = (id) => document.getElementById(id);

  const showPrompt = !!state.errorCode && !hasUsageData(state);
  const promptEl = $("error-prompt");
  const mainEl = $("main");

  if (showPrompt) {
    const copy = ERROR_COPY[state.errorCode] || ERROR_COPY.unknown;
    $("error-prompt-title").textContent = copy.title;
    $("error-prompt-body").innerHTML = copy.body;
    promptEl.style.display = "";
    mainEl.style.display = "none";
  } else {
    promptEl.style.display = "none";
    mainEl.style.display = hasUsageData(state) ? "" : "none";
  }

  const errorEl = $("error-label");
  if (state.lastError && !showPrompt) {
    errorEl.textContent = `Last refresh failed: ${state.lastError}`;
    errorEl.style.display = "block";
  } else {
    errorEl.style.display = "none";
  }

  $("tier-pill").textContent = formatTier(state.subscriptionTier);

  // Keep our "Resets in Nd" language (dashboard says "N days remaining in cycle").
  const cycleEl = $("cycle-label");
  const cycleSub = $("cycle-sub");
  if (state.billingCycleEnd) {
    cycleEl.textContent = formatResetTime(state.billingCycleEnd);
    cycleEl.style.display = "";
    const dateStr = formatCycleDate(state.billingCycleEnd);
    if (dateStr) {
      cycleSub.textContent = `Cycle ends ${dateStr}`;
      cycleSub.style.display = "";
    } else {
      cycleSub.style.display = "none";
    }
  } else {
    cycleEl.style.display = "none";
    cycleSub.style.display = "none";
  }

  // Hero: Included Credit + On-Demand Charges + split bar
  const credit = state.credit || {};
  const od = state.onDemand || {};
  const infra = state.spend?.infrastructureUsd;
  const included = credit.includedUsd;
  const creditUsed =
    credit.usedUsd != null
      ? credit.usedUsd
      : infra != null && included != null
        ? Math.min(infra, included)
        : null;
  const onDemandCharges =
    od.usedUsd != null
      ? od.usedUsd
      : infra != null && included != null
        ? Math.max(0, infra - included)
        : null;

  if (included != null && creditUsed != null) {
    $("credit-value").innerHTML =
      `${formatMoney(creditUsed)} <span class="muted">/ ${formatMoney(included)}</span>`;
  } else if (included != null) {
    $("credit-value").textContent = formatMoney(included);
  } else {
    $("credit-value").textContent = "—";
  }

  $("ondemand-value").textContent =
    onDemandCharges != null ? formatMoney(onDemandCharges) : "—";

  const totalForSplit =
    (creditUsed || 0) + (onDemandCharges || 0) ||
    (included != null ? included : 0);
  let creditPct = 0;
  let odPct = 0;
  if (totalForSplit > 0) {
    creditPct = ((creditUsed || 0) / totalForSplit) * 100;
    odPct = ((onDemandCharges || 0) / totalForSplit) * 100;
  } else if (included != null) {
    creditPct = 100;
  }
  $("split-credit").style.width = `${Math.max(0, Math.min(100, creditPct))}%`;
  $("split-ondemand").style.width = `${Math.max(0, Math.min(100, odPct))}%`;

  const metaParts = [];
  if (od.status === "on" && od.limitUsd != null) {
    const budgetPct = od.utilization != null ? ` (${formatPct(od.utilization)})` : "";
    metaParts.push(
      `Budget ${formatMoney(onDemandCharges ?? 0)} / ${formatMoney(od.limitUsd)}${budgetPct}`
    );
  } else if (od.status === "off") {
    metaParts.push("No on-demand budget configured");
  }
  if (od.overLimit) {
    metaParts.push(`<span class="warn">Over on-demand budget</span>`);
  }
  $("hero-meta").innerHTML = metaParts.join(" · ");

  // AI Gateway prepaid balance
  const gw = state.aiGateway || {};
  const gwCard = $("gateway-card");
  if (gw.balanceUsd != null) {
    $("gateway-value").textContent = formatMoney(gw.balanceUsd);
    gwCard.style.display = "";
  } else {
    gwCard.style.display = "none";
  }

  // Cycle spend breakdown
  const lines = state.lineItems || [];
  const linesHeading = $("lines-heading");
  const linesSlot = $("lines-slot");
  linesSlot.innerHTML = "";
  if (lines.length > 0 && !showPrompt) {
    linesHeading.style.display = "";
    linesSlot.style.display = "";
    const top = lines.slice(0, 12);
    for (const row of top) {
      const el = document.createElement("div");
      el.className = "line";
      el.innerHTML = `<span class="line-name"></span><span class="line-amt"></span>`;
      el.querySelector(".line-name").textContent = row.label;
      el.querySelector(".line-amt").textContent = formatMoney(row.amountUsd);
      linesSlot.appendChild(el);
    }
  } else {
    linesHeading.style.display = "none";
    linesSlot.style.display = "none";
  }

  // Included usage meters (below credit / on-demand / lines)
  const metersHeading = $("meters-heading");
  const metersSlot = $("meters-slot");
  metersSlot.innerHTML = "";
  const meters = state.meters || [];
  // Hobby meters are hard limits. On paid plans they are Flat Rate CDN
  // capacity: exceeding it is not billed, it moves the tier up next cycle.
  const metersAreLimits = state.subscriptionTier === "hobby";
  if (meters.length > 0 && !showPrompt) {
    metersHeading.textContent = metersAreLimits ? "Included usage" : "Flat Rate CDN capacity";
    metersHeading.style.display = "";
    for (const m of meters) {
      const pct = m.utilization;
      const usedStr = formatCompact(m.used, m.unit);
      const limitStr = formatCompact(m.limit, m.unit);
      const wrap = document.createElement("div");
      wrap.className = "meter";
      wrap.innerHTML = `
        <div class="meter-row">
          <span class="meter-label"></span>
          <span class="meter-value"></span>
        </div>
        <div class="bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100">
          <div class="bar-fill"></div>
        </div>
      `;
      wrap.querySelector(".meter-label").textContent = m.label || m.key;
      wrap.querySelector(".meter-value").textContent =
        `${formatPct(pct)} · ${usedStr} / ${limitStr}`;
      const track = wrap.querySelector(".bar-track");
      track.setAttribute("aria-label", m.label || m.key);
      if (pct != null) track.setAttribute("aria-valuenow", String(Math.round(Math.min(100, pct))));
      const fill = wrap.querySelector(".bar-fill");
      fill.style.width = `${pct != null ? Math.min(100, pct) : 0}%`;
      fill.style.backgroundColor =
        pct == null ? "var(--track)" : metersAreLimits ? barColor(pct) : capacityColor(pct);
      metersSlot.appendChild(wrap);
    }
    if (!metersAreLimits && meters.some((m) => m.utilization != null && m.utilization >= 100)) {
      const note = document.createElement("div");
      note.className = "empty";
      note.textContent =
        "Over capacity this cycle. No overage is billed, but Vercel may move you to a higher Flat Rate CDN tier next cycle.";
      metersSlot.appendChild(note);
    }
  } else {
    metersHeading.style.display = "none";
    if (!showPrompt && hasUsageData(state) && lines.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No included usage meters for this plan";
      metersSlot.appendChild(empty);
    }
  }

  $("meta-label").textContent = formatLastUpdated(state.lastUpdated);
}

function normalizeState(state) {
  return {
    ...DEFAULT_STATE,
    ...(state || {}),
    team: { ...DEFAULT_STATE.team, ...((state && state.team) || {}) },
    credit: { ...DEFAULT_STATE.credit, ...((state && state.credit) || {}) },
    onDemand: { ...DEFAULT_STATE.onDemand, ...((state && state.onDemand) || {}) },
    spend: { ...DEFAULT_STATE.spend, ...((state && state.spend) || {}) },
    aiGateway: { ...DEFAULT_STATE.aiGateway, ...((state && state.aiGateway) || {}) },
    meters: (state && state.meters) || [],
    lineItems: (state && state.lineItems) || [],
  };
}

async function loadAndRender() {
  try {
    const state = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_USAGE_STATE" }, (resp) => {
        if (chrome.runtime.lastError) {
          chrome.storage.local.get("usageState", ({ usageState }) => {
            resolve(usageState || DEFAULT_STATE);
          });
        } else {
          resolve(resp || DEFAULT_STATE);
        }
      });
    });
    render(normalizeState(state));
  } catch {
    document.getElementById("error-label").textContent = "Failed to load state.";
    document.getElementById("error-label").style.display = "block";
  }
}

async function currentState() {
  try {
    const { usageState } = await chrome.storage.local.get("usageState");
    return normalizeState(usageState);
  } catch {
    return DEFAULT_STATE;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadAndRender();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.usageState) {
      render(normalizeState(changes.usageState.newValue));
    }
  });
  setInterval(loadAndRender, 30_000);

  const btn = document.getElementById("refresh-btn");
  btn.addEventListener("click", () => {
    btn.textContent = "…";
    btn.disabled = true;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      loadAndRender();
      btn.textContent = "Refresh";
      btn.disabled = false;
    };
    const safety = setTimeout(done, 30_000);
    chrome.runtime.sendMessage({ type: "FORCE_REFRESH" }, () => {
      void chrome.runtime.lastError;
      clearTimeout(safety);
      done();
    });
  });

  document.getElementById("open-usage-btn").addEventListener("click", async () => {
    chrome.tabs.create({ url: usageUrl(await currentState()) });
  });

  document.getElementById("billing-btn").addEventListener("click", async () => {
    chrome.tabs.create({ url: billingUrl(await currentState()) });
  });
});
