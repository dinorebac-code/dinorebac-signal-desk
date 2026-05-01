(function () {
  const APP_VERSION = "0.1.0";
  const STORAGE_KEY = "signal-desk-state-v2";
  const CONFIG = window.APP_CONFIG || {};
  const WATCH_WINDOW = CONFIG.watchWindow || { start: "15:00", end: "20:00", pollSeconds: 45 };
  const MARKETS = [
    {
      code: "SOL",
      label: "SOL",
      symbol: "SOL/USD",
      preferredLongTriggers: ["bullish_engulfing", "hammer", "breakout_retest", "momentum_close"],
      preferredShortTriggers: ["bearish_engulfing", "shooting_star", "breakout_retest"],
      volatilityWeight: 1.2,
    },
    {
      code: "EURUSD",
      label: "EUR/USD",
      symbol: "EUR/USD",
      preferredLongTriggers: ["bullish_engulfing", "breakout_retest", "momentum_close"],
      preferredShortTriggers: ["bearish_engulfing", "shooting_star", "breakout_retest"],
      volatilityWeight: 0.7,
    },
  ];
  const TRIGGER_LABELS = {
    bullish_engulfing: "Bullish engulfing",
    bearish_engulfing: "Bearish engulfing",
    shooting_star: "Shooting star",
    hammer: "Hammer",
    breakout_retest: "Breakout retest",
    momentum_close: "Momentum close",
  };
  const dom = {};
  let pollTimer = null;
  let supabaseClient = null;
  let state = loadState();

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheDom();
    bindEvents();
    updateConfigLabels();
    addLog("Appen er klar. Lokal lagring er aktiv.", "info");
    await refreshSupabaseStatus(false);
    const hydrated = await hydrateFromSupabase();
    if (!hydrated) {
      await generateDailySetups(false);
    }
    render();
    startMonitorLoop();
  }

  function cacheDom() {
    dom.statsGrid = document.getElementById("stats-grid");
    dom.signalsGrid = document.getElementById("signals-grid");
    dom.learningGrid = document.getElementById("learning-grid");
    dom.historyList = document.getElementById("history-list");
    dom.monitorLog = document.getElementById("monitor-log");
    dom.storageStatus = document.getElementById("storage-status");
    dom.emailStatus = document.getElementById("email-status");
    dom.syncStatus = document.getElementById("sync-status");
    dom.lastUpdateLabel = document.getElementById("last-update-label");
    dom.windowLabel = document.getElementById("window-label");
    dom.dataSourceLabel = document.getElementById("data-source-label");
    dom.notificationEmail = document.getElementById("notification-email");
    dom.refreshButton = document.getElementById("refresh-button");
    dom.runSetupButton = document.getElementById("run-setup-button");
    dom.monitorButton = document.getElementById("monitor-button");
    dom.seedButton = document.getElementById("seed-button");
    dom.resetButton = document.getElementById("reset-button");
    dom.syncButton = document.getElementById("sync-button");
  }

  function bindEvents() {
    dom.refreshButton.addEventListener("click", () => handleAsyncAction(refreshDashboard));
    dom.runSetupButton.addEventListener("click", () => handleAsyncAction(runSetupsNow));
    dom.monitorButton.addEventListener("click", () => handleAsyncAction(runMonitorNow));
    dom.seedButton.addEventListener("click", seedDemoHistory);
    dom.resetButton.addEventListener("click", resetLocalState);
    dom.syncButton.addEventListener("click", () => handleAsyncAction(syncSupabase));
    document.addEventListener("click", handleTableActions);
  }

  function updateConfigLabels() {
    dom.windowLabel.textContent = `${WATCH_WINDOW.start}-${WATCH_WINDOW.end} ${CONFIG.timezone || "Europe/Oslo"}`;
    dom.notificationEmail.textContent = CONFIG.notificationEmail || "Ikke satt";
  }

  async function handleAsyncAction(fn) {
    try {
      await fn();
    } catch (error) {
      addLog(`Noe feilet: ${error.message}`, "danger");
      render();
    }
  }

  async function runSetupsNow() {
    await generateDailySetups(true);
    addLog("Dagens setups ble bygget pa nytt.", "info");
    render();
  }

  async function refreshDashboard() {
    const hydrated = await hydrateFromSupabase(true);
    if (!hydrated) {
      await generateDailySetups(true);
      addLog("Serverdata er ikke klare enda. Viser lokal fallback.", "warning");
    }
    render();
  }

  async function runMonitorNow() {
    await monitorForTriggers(true);
    render();
  }

  function resetLocalState() {
    state = buildInitialState();
    persistState();
    addLog("Lokal historikk ble nullstilt. Appen starter na helt rent.", "success");
    hydrateFromSupabase(true)
      .then((hydrated) => {
        if (!hydrated) {
          return generateDailySetups(true);
        }
      })
      .then(render);
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return buildInitialState();
      }
      const parsed = JSON.parse(raw);
      return hydrateState(parsed);
    } catch (_error) {
      return buildInitialState();
    }
  }

  function buildInitialState() {
    return {
      trades: [],
      setupsByDate: {},
      learningByMarket: Object.fromEntries(MARKETS.map((market) => [market.code, defaultLearning(market.code)])),
      logs: [],
      meta: {
        lastDataSource: CONFIG.twelveDataApiKey ? "Twelve Data" : "Demo preview",
        lastRunAt: null,
        lastSyncAt: null,
        appVersion: APP_VERSION,
      },
    };
  }

  function hydrateState(parsed) {
    const next = buildInitialState();
    next.trades = Array.isArray(parsed.trades) ? parsed.trades : [];
    next.setupsByDate = parsed.setupsByDate || {};
    next.logs = Array.isArray(parsed.logs) ? parsed.logs.slice(0, 20) : [];
    next.meta = { ...next.meta, ...(parsed.meta || {}) };
    next.learningByMarket = { ...next.learningByMarket, ...(parsed.learningByMarket || {}) };
    recalculateLearning(next);
    return next;
  }

  function persistState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function defaultLearning(market) {
    return {
      market,
      sampleSize: 0,
      windowSize: 0,
      overallWinRate: 0,
      biasWeights: {
        long: 0.5,
        short: 0.5,
      },
      triggerWeights: Object.fromEntries(Object.keys(TRIGGER_LABELS).map((key) => [key, 0.5])),
      topTrigger: "Ingen data enda",
      mode: "Warmup",
    };
  }

  function hasLiveMarketData() {
    return Boolean(CONFIG.twelveDataApiKey);
  }

  function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  async function generateDailySetups(forceRegenerate) {
    const key = todayKey();
    if (!state.setupsByDate[key] || forceRegenerate) {
      state.setupsByDate[key] = {};
    }

    for (const market of MARKETS) {
      if (state.setupsByDate[key][market.code] && !forceRegenerate) {
        continue;
      }

      const candles = await fetchCandles(market);
      const learning = state.learningByMarket[market.code] || defaultLearning(market.code);
      state.setupsByDate[key][market.code] = buildSetup(market, candles, learning);
    }

    state.meta.lastRunAt = new Date().toISOString();
    persistState();
  }

  async function fetchCandles(market) {
    if (CONFIG.twelveDataApiKey) {
      try {
        const url =
          `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(market.symbol)}` +
          `&interval=15min&outputsize=120&apikey=${encodeURIComponent(CONFIG.twelveDataApiKey)}`;
        const response = await fetch(url);
        const payload = await response.json();
        if (payload && Array.isArray(payload.values)) {
          state.meta.lastDataSource = `Twelve Data (${market.label})`;
          return payload.values
            .slice()
            .reverse()
            .map((item) => ({
              datetime: item.datetime,
              open: Number(item.open),
              high: Number(item.high),
              low: Number(item.low),
              close: Number(item.close),
            }));
        }
      } catch (_error) {
        addLog(`Klarte ikke hente ${market.label} fra API. Bruker demo preview.`, "warning");
      }
    }

    state.meta.lastDataSource = "Demo preview";
    return buildDemoCandles(market);
  }

  function buildDemoCandles(market) {
    const seedBase = stringSeed(`${todayKey()}-${market.code}`);
    const basePrice = market.code === "SOL" ? 79.6 : 1.0824;
    const candles = [];
    let previousClose = basePrice + ((seedBase % 13) - 6) * (market.code === "SOL" ? 0.14 : 0.00045);

    for (let index = 0; index < 120; index += 1) {
      const drift = Math.sin((seedBase + index) / 7) * (market.code === "SOL" ? 0.28 : 0.00062);
      const pulse = Math.cos((seedBase + index) / 5) * (market.code === "SOL" ? 0.11 : 0.00022);
      const close = previousClose + drift * 0.35 + pulse * 0.25;
      const open = previousClose;
      const high = Math.max(open, close) + Math.abs(drift) * 0.38 + (market.code === "SOL" ? 0.09 : 0.0002);
      const low = Math.min(open, close) - Math.abs(pulse) * 0.4 - (market.code === "SOL" ? 0.09 : 0.0002);
      candles.push({
        datetime: new Date(Date.now() - (120 - index) * 900000).toISOString(),
        open: Number(roundPrice(open, market.code)),
        high: Number(roundPrice(high, market.code)),
        low: Number(roundPrice(low, market.code)),
        close: Number(roundPrice(close, market.code)),
      });
      previousClose = close;
    }

    return candles;
  }

  function buildSetup(market, candles, learning) {
    const closes = candles.map((candle) => candle.close);
    const latest = candles[candles.length - 1];
    const emaFast = ema(closes, 9);
    const emaSlow = ema(closes, 21);
    const rsiValue = rsi(closes, 14);
    const atrValue = atr(candles, 14);
    const structureScore = computeStructureScore(candles);
    const trendScore =
      (latest.close > emaSlow ? 18 : -18) +
      (emaFast > emaSlow ? 14 : -14) +
      (rsiValue >= 55 ? 14 : rsiValue <= 45 ? -14 : rsiValue >= 50 ? 5 : -5) +
      structureScore;

    const baseBias = trendScore >= 0 ? "long" : "short";
    const triggerType = pickTrigger(baseBias, market, learning);
    const directionWeight = learning.biasWeights[baseBias] || 0.5;
    const triggerWeight = learning.triggerWeights[triggerType] || 0.5;
    const learningFactor = learning.sampleSize < 10 ? 0.35 : learning.sampleSize < 30 ? 0.65 : 1;
    const confidence = clamp(
      Math.round(
        Math.abs(trendScore) +
          14 +
          (directionWeight - 0.5) * 26 * learningFactor +
          (triggerWeight - 0.5) * 18 * learningFactor +
          atrValue * market.volatilityWeight * (market.code === "SOL" ? 1.2 : 8000)
      ),
      4,
      96
    );

    const recommendation = confidence <= 24 ? "not_recommended" : confidence <= 49 ? "weak" : confidence <= 69 ? "moderate" : "strong";
    const zoneWidth = atrValue * (market.code === "SOL" ? 0.55 : 0.4);
    const zoneLow = baseBias === "long" ? latest.close - zoneWidth : latest.close + zoneWidth * 0.15;
    const zoneHigh = baseBias === "long" ? latest.close - zoneWidth * 0.15 : latest.close + zoneWidth;

    return {
      id: crypto.randomUUID(),
      market: market.code,
      marketLabel: market.label,
      generatedAt: new Date().toISOString(),
      bias: baseBias,
      confidence,
      recommendation,
      entryZone: `${roundPrice(Math.min(zoneLow, zoneHigh), market.code)} - ${roundPrice(Math.max(zoneLow, zoneHigh), market.code)}`,
      zoneLow: Number(roundPrice(Math.min(zoneLow, zoneHigh), market.code)),
      zoneHigh: Number(roundPrice(Math.max(zoneLow, zoneHigh), market.code)),
      triggerType,
      triggerLabel: TRIGGER_LABELS[triggerType],
      triggerNote: buildTriggerNote(baseBias, triggerType),
      monitorState: "waiting",
      monitorMessage: hasLiveMarketData()
        ? `Venter pa ${TRIGGER_LABELS[triggerType].toLowerCase()} i entry-zonen.`
        : "Demo-modus aktiv. Legg inn API-nokkel for ekte trigger-overvaking og trade-oppretting.",
      features: {
        emaFast: roundPrice(emaFast, market.code),
        emaSlow: roundPrice(emaSlow, market.code),
        rsi: Number(roundNumber(rsiValue)),
        atr: roundPrice(atrValue, market.code),
        structure: structureScore > 0 ? "supportive" : structureScore < 0 ? "weak" : "neutral",
        learningMode: learning.mode,
      },
      source: state.meta.lastDataSource,
    };
  }

  function computeStructureScore(candles) {
    const last = candles.slice(-4);
    if (last.length < 4) {
      return 0;
    }
    const rising = last[3].low > last[1].low && last[2].high > last[0].high;
    const falling = last[3].high < last[1].high && last[2].low < last[0].low;
    if (rising) {
      return 12;
    }
    if (falling) {
      return -12;
    }
    return 0;
  }

  function buildTriggerNote(bias, triggerType) {
    if (bias === "long") {
      if (triggerType === "bullish_engulfing") {
        return "Vent til en bullish engulfing candle lukker inne i sonen.";
      }
      if (triggerType === "hammer") {
        return "Vent pa hammer eller tydelig rejection wick i sonen.";
      }
      if (triggerType === "momentum_close") {
        return "Vent pa sterk candle close opp fra sonen for entry.";
      }
      return "Vent pa bekreftelse i sonen for long-entry.";
    }

    if (triggerType === "bearish_engulfing") {
      return "Vent til en bearish engulfing candle lukker inne i sonen.";
    }
    if (triggerType === "shooting_star") {
      return "Vent pa shooting star eller tydelig rejection fra toppen av sonen.";
    }
    return "Vent pa bekreftelse i sonen for short-entry.";
  }

  function pickTrigger(bias, market, learning) {
    const candidates = bias === "long" ? market.preferredLongTriggers : market.preferredShortTriggers;
    const weighted = candidates
      .map((trigger) => ({
        trigger,
        score: learning.triggerWeights[trigger] || 0.5,
      }))
      .sort((left, right) => right.score - left.score);
    return weighted[0].trigger;
  }

  async function monitorForTriggers(isManual) {
    const key = todayKey();
    const setups = state.setupsByDate[key];
    if (!setups) {
      addLog("Ingen setups a overvake enda.", "warning");
      return;
    }

    if (!hasLiveMarketData()) {
      Object.values(setups).forEach((setup) => {
        setup.monitorState = "waiting";
        setup.monitorMessage = "Demo-modus aktiv. Ingen ekte trades opprettes for API er satt opp.";
      });
      if (isManual) {
        addLog("Trigger-sjekk er deaktivert i demo-modus. Legg inn Twelve Data API-nokkel for ekte trades.", "warning");
      }
      persistState();
      render();
      return;
    }

    const now = new Date();
    const inWindow = isWithinWatchWindow(now);
    const windowState = getWatchWindowState(now);
    if (!inWindow && !isManual) {
      Object.values(setups).forEach((setup) => {
        if (setup.monitorState !== "confirmed") {
          setup.monitorState = windowState.phase === "after" ? "closed" : "waiting";
          setup.monitorMessage = windowState.note;
        }
      });
      persistState();
      render();
      return;
    }

    for (const market of MARKETS) {
      const setup = setups[market.code];
      if (!setup || setup.monitorState === "confirmed") {
        continue;
      }

      const candles = await fetchCandles(market);
      const latest = candles[candles.length - 1];
      const previous = candles[candles.length - 2];
      const zoneHit = latest.low <= setup.zoneHigh && latest.high >= setup.zoneLow;
      const triggerHit = detectTrigger(setup.triggerType, previous, latest);

      if (zoneHit && triggerHit) {
        confirmTrade(setup, latest);
        addLog(`${setup.marketLabel}: entry bekreftet med ${setup.triggerLabel}.`, "success");
      } else {
        setup.monitorState = inWindow ? "watching" : "waiting";
        setup.monitorMessage = zoneHit
          ? `Pris er i sonen, men ${setup.triggerLabel.toLowerCase()} er ikke bekreftet enda.`
          : "Venter pa at pris skal komme inn i entry-zonen.";
      }
    }

    persistState();
    render();
  }

  function confirmTrade(setup, candle) {
    setup.monitorState = "confirmed";
    setup.monitorMessage = "Entry bekreftet og trade lagt i journalen.";
    setup.entryConfirmedAt = new Date().toISOString();

    const trade = {
      id: crypto.randomUUID(),
      setupId: setup.id,
      createdAt: new Date().toISOString(),
      tradeDate: todayKey(),
      market: setup.market,
      marketLabel: setup.marketLabel,
      bias: setup.bias,
      confidence: setup.confidence,
      recommendation: setup.recommendation,
      entryZone: setup.entryZone,
      triggerType: setup.triggerType,
      triggerLabel: setup.triggerLabel,
      triggerNote: setup.triggerNote,
      status: "open",
      result: "",
      entryPrice: candle.close,
      source: setup.source,
      features: { ...setup.features },
      learningSnapshot: { ...(state.learningByMarket[setup.market] || defaultLearning(setup.market)) },
    };

    state.trades.unshift(trade);
    persistState();
  }

  function detectTrigger(triggerType, previous, latest) {
    if (!previous || !latest) {
      return false;
    }

    const latestBody = Math.abs(latest.close - latest.open);
    const previousBody = Math.abs(previous.close - previous.open);
    const latestRange = latest.high - latest.low || 1;
    const previousRange = previous.high - previous.low || 1;
    const upperWick = latest.high - Math.max(latest.open, latest.close);
    const lowerWick = Math.min(latest.open, latest.close) - latest.low;
    const engulfTolerance = Math.max(latestRange, previousRange) * 0.18;
    const latestBodyShare = latestBody / latestRange;
    const bullishBody = latest.close > latest.open;
    const bearishBody = latest.close < latest.open;
    const previousBearishOrWeak = previous.close <= previous.open || previousBody / previousRange < 0.22;
    const previousBullishOrWeak = previous.close >= previous.open || previousBody / previousRange < 0.22;
    const bullishEngulf =
      bullishBody &&
      previousBearishOrWeak &&
      latest.open <= previous.close + engulfTolerance &&
      (latest.close >= previous.open - engulfTolerance || latest.close >= previous.high - engulfTolerance) &&
      (latestBody >= previousBody * 0.65 || latestBodyShare >= 0.48);
    const bearishEngulf =
      bearishBody &&
      previousBullishOrWeak &&
      latest.open >= previous.close - engulfTolerance &&
      (latest.close <= previous.open + engulfTolerance || latest.close <= previous.low + engulfTolerance) &&
      (latestBody >= previousBody * 0.65 || latestBodyShare >= 0.48);

    switch (triggerType) {
      case "bullish_engulfing":
        return bullishEngulf;
      case "bearish_engulfing":
        return bearishEngulf;
      case "shooting_star":
        return upperWick > latestBody * 2.2 && lowerWick < latestBody && latest.close < latest.open;
      case "hammer":
        return lowerWick > latestBody * 2.2 && upperWick < latestBody;
      case "breakout_retest":
        return latestBody / latestRange > 0.55;
      case "momentum_close":
        return latestBody / latestRange > 0.62 && latest.close > latest.open;
      default:
        return false;
    }
  }

  async function handleTableActions(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const action = target.dataset.action;
    const tradeId = target.dataset.tradeId;
    if (!action || !tradeId) {
      return;
    }

    if (action === "win" || action === "loss") {
      await closeTrade(tradeId, action);
    }
  }

  async function closeTrade(tradeId, result) {
    const trade = state.trades.find((item) => item.id === tradeId);
    if (!trade) {
      return;
    }
    trade.result = result;
    trade.status = "closed";
    trade.closedAt = new Date().toISOString();
    recalculateLearning();
    persistState();
    addLog(`${trade.marketLabel}: trade markert som ${result}. Laeringen er oppdatert.`, result === "win" ? "success" : "danger");
    await pushTradeResultToSupabase(tradeId, result);
    render();
  }

  function recalculateLearning(nextState = state) {
    for (const market of MARKETS) {
      const closed = nextState.trades.filter((trade) => trade.market === market.code && trade.status === "closed" && trade.result);
      const windowTrades = closed.slice(0, 100);
      const learning = defaultLearning(market.code);

      if (!windowTrades.length) {
        nextState.learningByMarket[market.code] = learning;
        continue;
      }

      const wins = windowTrades.filter((trade) => trade.result === "win").length;
      learning.sampleSize = closed.length;
      learning.windowSize = windowTrades.length;
      learning.overallWinRate = Number(roundNumber((wins / windowTrades.length) * 100));
      learning.mode = windowTrades.length < 10 ? "Warmup" : windowTrades.length < 30 ? "Adaptive" : "Mature";

      for (const bias of ["long", "short"]) {
        const bucket = windowTrades.filter((trade) => trade.bias === bias);
        const bucketWins = bucket.filter((trade) => trade.result === "win").length;
        learning.biasWeights[bias] = Number(roundNumber((bucketWins + 1) / (bucket.length + 2), 3));
      }

      const triggerScores = {};
      for (const trigger of Object.keys(TRIGGER_LABELS)) {
        const bucket = windowTrades.filter((trade) => trade.triggerType === trigger);
        const bucketWins = bucket.filter((trade) => trade.result === "win").length;
        const score = Number(roundNumber((bucketWins + 1) / (bucket.length + 2), 3));
        learning.triggerWeights[trigger] = score;
        triggerScores[trigger] = score;
      }

      const [bestTrigger] = Object.entries(triggerScores).sort((left, right) => right[1] - left[1])[0];
      learning.topTrigger = TRIGGER_LABELS[bestTrigger];
      nextState.learningByMarket[market.code] = learning;
    }
  }

  function seedDemoHistory() {
    if (state.trades.length) {
      addLog("Demo-historikk ble hoppet over fordi appen allerede har trades.", "warning");
      return;
    }

    const seeds = [
      ["SOL", "long", 68, "moderate", "79.20 - 79.70", "bullish_engulfing", "win"],
      ["SOL", "short", 54, "weak", "81.20 - 81.60", "shooting_star", "loss"],
      ["SOL", "long", 74, "strong", "77.80 - 78.10", "hammer", "win"],
      ["SOL", "short", 61, "moderate", "82.00 - 82.40", "bearish_engulfing", "win"],
      ["EURUSD", "short", 63, "moderate", "1.0860 - 1.0872", "shooting_star", "win"],
      ["EURUSD", "long", 51, "weak", "1.0785 - 1.0793", "breakout_retest", "loss"],
      ["EURUSD", "long", 72, "strong", "1.0801 - 1.0810", "bullish_engulfing", "win"],
      ["EURUSD", "short", 48, "weak", "1.0840 - 1.0850", "bearish_engulfing", "loss"],
    ];

    state.trades = seeds.map((seed, index) => ({
      id: crypto.randomUUID(),
      createdAt: new Date(Date.now() - index * 86400000).toISOString(),
      tradeDate: isoDayOffset(index),
      market: seed[0],
      marketLabel: seed[0] === "SOL" ? "SOL" : "EUR/USD",
      bias: seed[1],
      confidence: seed[2],
      recommendation: seed[3],
      entryZone: seed[4],
      triggerType: seed[5],
      triggerLabel: TRIGGER_LABELS[seed[5]],
      triggerNote: "Demo-trade for a fylle historikk.",
      status: "closed",
      result: seed[6],
      entryPrice: seed[0] === "SOL" ? 80.12 + index * 0.1 : 1.0812 + index * 0.0004,
      source: "Demo history",
      features: {
        emaFast: seed[0] === "SOL" ? 79.8 : 1.0814,
        emaSlow: seed[0] === "SOL" ? 79.3 : 1.0808,
        rsi: seed[1] === "long" ? 57 : 44,
        atr: seed[0] === "SOL" ? 1.06 : 0.0014,
        structure: seed[1] === "long" ? "supportive" : "weak",
        learningMode: "Demo",
      },
      learningSnapshot: defaultLearning(seed[0]),
      closedAt: new Date(Date.now() - index * 86000000).toISOString(),
    }));

    recalculateLearning();
    persistState();
    addLog("Demo-historikk ble lagt inn. Du kan na se winrate og laeringsprofiler.", "success");
    render();
  }

  function render() {
    renderStats();
    renderSignals();
    renderLearning();
    renderHistory();
    renderLogs();
    dom.storageStatus.textContent = `Aktivt (${state.trades.length} trades lokalt, uavhengig av Supabase)`;
    dom.emailStatus.textContent = CONFIG.notificationEmail
      ? "Klar nar RESEND_API_KEY er lagt inn i Supabase"
      : "Mangler mottakeradresse";
    dom.lastUpdateLabel.textContent = state.meta.lastRunAt ? formatDateTime(state.meta.lastRunAt) : "Ikke kjort enda";
    dom.dataSourceLabel.textContent = `Datakilde: ${state.meta.lastDataSource || "Demo preview"}`;
    if (state.meta.lastSyncAt) {
      dom.syncStatus.textContent = `Synced ${formatDateTime(state.meta.lastSyncAt)}`;
    }
  }

  function renderStats() {
    const closedTrades = state.trades.filter((trade) => trade.status === "closed");
    const wins = closedTrades.filter((trade) => trade.result === "win").length;
    const openTrades = state.trades.filter((trade) => trade.status === "open").length;
    const winRate = closedTrades.length ? Number(roundNumber((wins / closedTrades.length) * 100)) : 0;
    const todaySetups = Object.values(state.setupsByDate[todayKey()] || {}).length;
    const sampleSize = MARKETS.reduce((total, market) => total + (state.learningByMarket[market.code]?.windowSize || 0), 0);
    const windowState = getWatchWindowState();

    const cards = [
      {
        label: "Total winrate",
        value: `${winRate}%`,
        copy: `${wins} wins av ${closedTrades.length || 0} lukkede trades`,
      },
      {
        label: "Vindustatus",
        value: windowState.label,
        copy: windowState.note,
      },
      {
        label: "Dagens bias-signaler",
        value: String(todaySetups),
        copy: "Appen viser alltid dagens long/short-bias, selv hvis ingen entry ble aktiv.",
      },
      {
        label: "Apne trades",
        value: String(openTrades),
        copy: sampleSize
          ? `Laeringsmotoren bruker na ${sampleSize} trades i aktivt vindu.`
          : "Ingen bekreftede trades enda. Laeringen er fortsatt i warmup.",
      },
    ];

    dom.statsGrid.innerHTML = cards
      .map(
        (card) => `
          <article class="stat-card">
            <p class="eyebrow">${card.label}</p>
            <div class="stat-value">${card.value}</div>
            <p class="stat-copy">${card.copy}</p>
          </article>
        `
      )
      .join("");
  }

  function renderSignals() {
    const setups = Object.values(state.setupsByDate[todayKey()] || {});
    const windowState = getWatchWindowState();
    if (!setups.length) {
      dom.signalsGrid.innerHTML = `
        <article class="history-empty">
          <p class="eyebrow">Dagens signaler</p>
          <h3>Bygger dagens bias akkurat na</h3>
          <p class="section-note">
            Appen fant ingen ferdige signaler fra serveren i dette oyeblikket. Den prover automatisk
            a hente eller bygge dagens bias for SOL og EUR/USD, slik at dashboardet ikke blir tomt.
          </p>
        </article>
      `;
      return;
    }
    dom.signalsGrid.innerHTML = setups
      .map((setup) => {
        const learning = state.learningByMarket[setup.market] || defaultLearning(setup.market);
        const activeTrade = state.trades.find((trade) => trade.market === setup.market && trade.status === "open");
        const stopPrice = activeTrade?.features?.stopPrice;
        const targetPrice = activeTrade?.features?.targetPrice;
        const biasIntent = getBiasIntentCopy(setup.confidence);
        const autoExitCopy = stopPrice && targetPrice ? `SL ${stopPrice} / TP ${targetPrice}` : "Settes ved entry";
        const monitorCopy =
          activeTrade
            ? "Entry er aktiv og overvakes videre av serveren."
            : setup.monitorMessage || windowState.note;
        const confidenceTone = setup.confidence <= 24 ? "low" : setup.confidence <= 49 ? "mid" : "high";
        const meterWidth = Math.max(4, Math.min(100, Number(setup.confidence) || 4));
        return `
          <article class="signal-card signal-${setup.bias}">
            <div class="signal-top">
              <div>
                <p class="eyebrow">${setup.market === "SOL" ? "SOL/USD" : "EUR/USD"}</p>
                <div class="signal-market">${setup.marketLabel}</div>
              </div>
              <div class="pill ${setup.bias === "long" ? "pill-long" : "pill-short"}">${setup.bias.toUpperCase()}</div>
            </div>

            <div class="signal-status-banner">
              <div>
                <p class="detail-label">Dagens bias</p>
                <p class="signal-status-copy">${setup.bias.toUpperCase()} ${setup.confidence}%</p>
              </div>
              <span class="pill ${setup.confidence <= 24 ? "pill-weak" : "pill-strong"}">${biasIntent}</span>
            </div>

            <div class="confidence-track confidence-${confidenceTone}" aria-label="Confidence ${setup.confidence}%">
              <span style="width:${meterWidth}%"></span>
            </div>

            <div class="signal-gridline">
              <div class="detail-card">
                <p class="detail-label">Entry zone</p>
                <p class="detail-value">${setup.entryZone}</p>
              </div>
              <div class="detail-card">
                <p class="detail-label">Trigger</p>
                <p class="detail-value">${setup.triggerLabel}</p>
              </div>
              <div class="detail-card">
                <p class="detail-label">Auto SL/TP</p>
                <p class="detail-value">${autoExitCopy}</p>
              </div>
              <div class="detail-card">
                <p class="detail-label">Mode</p>
                <p class="detail-value">${
                  setup.confidence <= 24
                    ? "Bias only"
                    : formatRecommendation(setup.recommendation)
                }</p>
              </div>
            </div>

            <details class="signal-details">
              <summary>Trigger status og data</summary>
              <div class="detail-card monitor-card">
                <p class="detail-label">Monitor</p>
                <p class="detail-value">${monitorCopy}</p>
              </div>
              <ul class="feature-list">
                <li>EMA fast / slow: ${setup.features.emaFast} / ${setup.features.emaSlow}</li>
                <li>RSI: ${setup.features.rsi}</li>
                <li>Structure: ${setup.features.structure}</li>
                <li>Laeringsmodus: ${learning.mode}</li>
                <li>Datakilde: ${setup.source}</li>
              </ul>
            </details>
          </article>
        `;
      })
      .join("");
  }

  function renderLearning() {
    dom.learningGrid.innerHTML = MARKETS.map((market) => {
      const learning = state.learningByMarket[market.code] || defaultLearning(market.code);
      return `
        <article class="learning-card">
          <div class="signal-top">
            <div>
              <p class="eyebrow">Marked</p>
              <h3>${market.label}</h3>
            </div>
            <div class="pill ${learning.overallWinRate >= 55 ? "pill-strong" : "pill-weak"}">${learning.mode}</div>
          </div>

          <div class="learning-metric">
            <span>Winrate siste ${learning.windowSize || 0}</span>
            <strong>${learning.overallWinRate}%</strong>
          </div>
          <div class="learning-bar">
            <span style="width:${learning.overallWinRate}%"></span>
          </div>

          <div class="learning-metric">
            <span>Long bias score</span>
            <strong>${Math.round((learning.biasWeights.long || 0.5) * 100)}%</strong>
          </div>
          <div class="learning-metric">
            <span>Short bias score</span>
            <strong>${Math.round((learning.biasWeights.short || 0.5) * 100)}%</strong>
          </div>
          <div class="learning-metric">
            <span>Beste trigger</span>
            <strong>${learning.topTrigger}</strong>
          </div>
          <div class="learning-metric">
            <span>Total historikk</span>
            <strong>${learning.sampleSize}</strong>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderHistory() {
    if (!state.trades.length) {
      const windowState = getWatchWindowState();
      dom.historyList.innerHTML = `
        <article class="history-empty">
          <p class="eyebrow">Historikk</p>
          <h3>Ingen bekreftede entries enda</h3>
          <p class="section-note">
            Dagens bias-signaler vises alltid over. Historikken fylles bare nar entry faktisk
            blir bekreftet i overvakingsvinduet. ${windowState.note}
          </p>
        </article>
      `;
      return;
    }

    dom.historyList.innerHTML = state.trades
      .map((trade) => {
        const actionMarkup =
          trade.status === "open"
            ? `
              <div class="history-actions">
                <button class="button button-tiny button-win" data-action="win" data-trade-id="${trade.id}" type="button">Win</button>
                <button class="button button-tiny button-loss" data-action="loss" data-trade-id="${trade.id}" type="button">Loss</button>
              </div>
            `
            : `<span class="pill ${
                trade.result === "win" ? "pill-win" : trade.result === "loss" ? "pill-loss" : "pill-open"
              }">${formatTradeStatus(trade)}</span>`;

        const statusPillClass =
          trade.result === "win"
            ? "pill-win"
            : trade.result === "loss"
              ? "pill-loss"
              : "pill-open";

        return `
          <article class="history-card">
            <div class="history-top">
              <div>
                <p class="history-caption">Trade</p>
                <div class="history-market">${trade.marketLabel}</div>
                <p class="history-date">${trade.tradeDate}</p>
              </div>
              <div class="history-pills">
                <span class="pill ${trade.bias === "long" ? "pill-long" : "pill-short"}">${trade.bias.toUpperCase()}</span>
                <span class="pill ${statusPillClass}">${formatTradeStatus(trade)}</span>
              </div>
            </div>

            <div class="history-meta">
              <div class="detail-card">
                <p class="detail-label">Confidence</p>
                <p class="detail-value">${trade.confidence}%</p>
              </div>
              <div class="detail-card">
                <p class="detail-label">Trigger</p>
                <p class="detail-value">${trade.triggerLabel}</p>
              </div>
              <div class="detail-card">
                <p class="detail-label">Entry zone</p>
                <p class="detail-value">${trade.entryZone}</p>
              </div>
              <div class="detail-card">
                <p class="detail-label">Kilde</p>
                <p class="detail-value">${trade.source || "Server"}</p>
              </div>
            </div>

            <div class="history-footer">
              <p class="history-note">
                ${trade.triggerNote || "Trigger oppgitt av strategien."}
              </p>
              ${actionMarkup}
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderLogs() {
    dom.monitorLog.innerHTML = state.logs.length
      ? state.logs
          .map(
            (entry) => `
              <article class="log-entry">
                <p>${entry.message}</p>
                <time>${formatDateTime(entry.timestamp)}</time>
              </article>
            `
          )
          .join("")
      : `
        <article class="log-entry">
          <p>Ingen logg enda. Appen oppdaterer denne listen nar setups, monitor og laering endres.</p>
        </article>
      `;
  }

  function addLog(message, tone) {
    state.logs.unshift({
      id: crypto.randomUUID(),
      message,
      tone,
      timestamp: new Date().toISOString(),
    });
    state.logs = state.logs.slice(0, 12);
    persistState();
  }

  function startMonitorLoop() {
    if (pollTimer) {
      clearInterval(pollTimer);
    }

    const frequency = Math.max(15, Number(WATCH_WINDOW.pollSeconds || 45)) * 1000;
    pollTimer = setInterval(() => {
      monitorForTriggers(false).catch((error) => addLog(`Monitor-feil: ${error.message}`, "danger"));
    }, frequency);
  }

  function isWithinWatchWindow(now) {
    const [startHour, startMinute] = WATCH_WINDOW.start.split(":").map(Number);
    const [endHour, endMinute] = WATCH_WINDOW.end.split(":").map(Number);
    const value = now.getHours() * 60 + now.getMinutes();
    const startValue = startHour * 60 + startMinute;
    const endValue = endHour * 60 + endMinute;
    return value >= startValue && value <= endValue;
  }

  function getWatchWindowState(now = new Date()) {
    const [startHour, startMinute] = WATCH_WINDOW.start.split(":").map(Number);
    const [endHour, endMinute] = WATCH_WINDOW.end.split(":").map(Number);
    const value = now.getHours() * 60 + now.getMinutes();
    const startValue = startHour * 60 + startMinute;
    const endValue = endHour * 60 + endMinute;

    if (value < startValue) {
      return {
        phase: "before",
        label: "Venter pa vindu",
        note: `Bias er klar. Entry-overvaking starter ${WATCH_WINDOW.start}.`,
      };
    }

    if (value > endValue) {
      return {
        phase: "after",
        label: "Vindu stengt",
        note: `Dagens bias vises fortsatt, men nye entries ventes til i morgen ${WATCH_WINDOW.start}.`,
      };
    }

    return {
      phase: "live",
      label: "Overvaker na",
      note: "Appen sjekker entry-zone og candle-trigger akkurat na.",
    };
  }

  function getBiasIntentCopy(confidence) {
    if (confidence <= 24) {
      return "Bias only";
    }
    if (confidence <= 49) {
      return "Svak setup";
    }
    if (confidence <= 69) {
      return "Moderat setup";
    }
    return "Sterk setup";
  }

  async function refreshSupabaseStatus(logResult) {
    const available = CONFIG.supabaseUrl && CONFIG.supabaseAnonKey && window.supabase;
    if (!available) {
      dom.syncStatus.textContent = "Ikke konfigurert";
      return;
    }

    if (!supabaseClient) {
      supabaseClient = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
    }

    dom.syncStatus.textContent = "Klar";
    if (logResult) {
      addLog("Supabase-klienten er klar. Neste steg er sync.", "success");
    }
  }

  async function hydrateFromSupabase(showLog) {
    if (!CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) {
      return false;
    }

    try {
      const response = await fetchWithSupabaseAuth("dashboard-state", "GET");

      if (!response.ok) {
        return false;
      }

      const payload = await response.json();
      if (!payload.ok) {
        return false;
      }

      if (!payload.setups?.length) {
        const generated = await ensureTodayServerSetups(showLog);
        if (generated) {
          return hydrateFromSupabase(showLog);
        }
        return false;
      }

      const setupMap = {};
      for (const setup of payload.setups || []) {
        setupMap[setup.market] = {
          id: setup.id,
          market: setup.market,
          marketLabel: setup.market === "SOL" ? "SOL" : "EUR/USD",
          generatedAt: setup.generated_at,
          bias: setup.bias,
          confidence: setup.confidence,
          recommendation: setup.recommendation,
          entryZone: setup.entry_zone,
          zoneLow: Number(String(setup.entry_zone).split(" - ")[0]),
          zoneHigh: Number(String(setup.entry_zone).split(" - ")[1]),
          triggerType: setup.trigger_type,
          triggerLabel: TRIGGER_LABELS[setup.trigger_type],
          triggerNote: setup.trigger_note,
          monitorState: setup.monitor_state,
          monitorMessage: setup.monitor_message,
          features: setup.features || {},
          source: setup.data_source,
        };
      }

      state.setupsByDate[payload.tradeDate] = setupMap;
      state.trades = (payload.trades || []).map((trade) => ({
        id: trade.id,
        setupId: trade.setup_id || null,
        createdAt: trade.entry_confirmed_at,
        tradeDate: trade.trade_date,
        market: trade.market,
        marketLabel: trade.market === "SOL" ? "SOL" : "EUR/USD",
        bias: trade.bias,
        confidence: trade.confidence,
        recommendation: trade.recommendation,
        entryZone: trade.entry_zone,
        triggerType: trade.trigger_type,
        triggerLabel: TRIGGER_LABELS[trade.trigger_type],
        triggerNote: trade.trigger_note,
        status: trade.status,
        result: trade.result || "",
        entryPrice: trade.features?.entryPrice || null,
        source: trade.data_source,
        features: trade.features || {},
        learningSnapshot: trade.learning_snapshot || {},
        closedAt: trade.closed_at || null,
      }));

      for (const row of payload.learningState || []) {
        state.learningByMarket[row.market] = {
          ...defaultLearning(row.market),
          ...(row.state || {}),
          sampleSize: row.sample_size || row.state?.sampleSize || 0,
        };
      }

      persistState();
      if (showLog) {
        addLog("Dashboardet hentet siste serverdata fra Supabase.", "success");
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  async function ensureTodayServerSetups(showLog) {
    try {
      const response = await fetchWithSupabaseAuth("daily-setup", "POST", {
        source: "frontend",
        reason: "missing-today-setups",
      });
      if (!response.ok) {
        return false;
      }

      const payload = await response.json();
      if (!payload.ok) {
        return false;
      }

      if (showLog) {
        addLog("Dagens signaler manglet og ble generert automatisk fra serveren.", "success");
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  async function fetchWithSupabaseAuth(functionName, method = "GET", body = null) {
    return fetch(`${CONFIG.supabaseUrl}/functions/v1/${functionName}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        apikey: CONFIG.supabaseAnonKey,
        Authorization: `Bearer ${CONFIG.supabaseAnonKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function pushTradeResultToSupabase(tradeId, result) {
    if (!CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) {
      return;
    }

    try {
      const response = await fetchWithSupabaseAuth("record-result", "POST", { tradeId, result });

      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      if (!payload.ok) {
        return;
      }

      await hydrateFromSupabase();
    } catch (_error) {
      // Local state stays as fallback if the function is not deployed yet.
    }
  }

  async function syncSupabase() {
    await refreshSupabaseStatus(true);
    if (!supabaseClient) {
      addLog("Fyll inn Supabase URL og anon key i config.js for a synce.", "warning");
      render();
      return;
    }

    const todaySetups = Object.values(state.setupsByDate[todayKey()] || {});
    const setupRows = todaySetups.map((setup) => ({
      trade_date: todayKey(),
      market: setup.market,
      bias: setup.bias,
      confidence: setup.confidence,
      recommendation: setup.recommendation,
      entry_zone: setup.entryZone,
      trigger_type: setup.triggerType,
      trigger_note: setup.triggerNote,
      monitor_state: setup.monitorState,
      monitor_message: setup.monitorMessage,
      generated_at: setup.generatedAt,
      data_source: setup.source,
      features: setup.features,
    }));

    const tradeRows = state.trades.map((trade) => ({
      id: trade.id,
      setup_id: trade.setupId || null,
      trade_date: trade.tradeDate,
      market: trade.market,
      bias: trade.bias,
      confidence: trade.confidence,
      recommendation: trade.recommendation,
      entry_zone: trade.entryZone,
      trigger_type: trade.triggerType,
      trigger_note: trade.triggerNote,
      status: trade.status,
      result: trade.result || null,
      entry_confirmed_at: trade.createdAt,
      closed_at: trade.closedAt || null,
      data_source: trade.source,
      features: trade.features,
      learning_snapshot: trade.learningSnapshot,
    }));

    const learningRows = MARKETS.map((market) => ({
      market: market.code,
      sample_size: state.learningByMarket[market.code]?.sampleSize || 0,
      state: state.learningByMarket[market.code] || defaultLearning(market.code),
      updated_at: new Date().toISOString(),
    }));

    const setupResponse = await supabaseClient.from("market_setups").upsert(setupRows, { onConflict: "trade_date,market" });
    if (setupResponse.error) {
      throw new Error(`Setup sync feilet: ${setupResponse.error.message}`);
    }

    const tradeResponse = await supabaseClient.from("trades").upsert(tradeRows);
    if (tradeResponse.error) {
      throw new Error(`Trade sync feilet: ${tradeResponse.error.message}`);
    }

    const learningResponse = await supabaseClient.from("learning_state").upsert(learningRows, { onConflict: "market" });
    if (learningResponse.error) {
      throw new Error(`Learning sync feilet: ${learningResponse.error.message}`);
    }

    state.meta.lastSyncAt = new Date().toISOString();
    dom.syncStatus.textContent = `Synced ${formatDateTime(state.meta.lastSyncAt)}`;
    persistState();
    addLog("Data ble synkronisert til Supabase.", "success");
    render();
  }

  function formatRecommendation(value) {
    switch (value) {
      case "not_recommended":
        return "Ikke anbefalt";
      case "weak":
        return "Svakt signal";
      case "moderate":
        return "Moderat signal";
      case "strong":
        return "Sterkt signal";
      default:
        return value;
    }
  }

  function formatTradeResult(value) {
    if (value === "win") {
      return "Win";
    }
    if (value === "loss") {
      return "Loss";
    }
    return "Apen";
  }

  function formatTradeStatus(trade) {
    if (trade.result === "win" || trade.result === "loss") {
      return formatTradeResult(trade.result);
    }
    return trade.status === "open" ? "Apen" : "Lukket";
  }

  function roundPrice(value, marketCode) {
    return Number(value).toFixed(marketCode === "SOL" ? 2 : 4);
  }

  function roundNumber(value, digits = 1) {
    return Number(value).toFixed(digits);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function ema(values, length) {
    const multiplier = 2 / (length + 1);
    let current = values[0] || 0;
    for (let index = 1; index < values.length; index += 1) {
      current = (values[index] - current) * multiplier + current;
    }
    return current;
  }

  function rsi(values, length) {
    if (values.length <= length) {
      return 50;
    }
    let gains = 0;
    let losses = 0;
    for (let index = values.length - length; index < values.length; index += 1) {
      const delta = values[index] - values[index - 1];
      if (delta >= 0) {
        gains += delta;
      } else {
        losses += Math.abs(delta);
      }
    }
    if (!losses) {
      return 100;
    }
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
  }

  function atr(candles, length) {
    if (candles.length <= length) {
      return candles[candles.length - 1].high - candles[candles.length - 1].low;
    }
    const ranges = [];
    for (let index = candles.length - length; index < candles.length; index += 1) {
      const candle = candles[index];
      const previousClose = candles[index - 1]?.close ?? candle.close;
      const trueRange = Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose)
      );
      ranges.push(trueRange);
    }
    return ranges.reduce((total, value) => total + value, 0) / ranges.length;
  }

  function isoDayOffset(offset) {
    const date = new Date(Date.now() - offset * 86400000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function stringSeed(value) {
    return value.split("").reduce((total, char, index) => total + char.charCodeAt(0) * (index + 7), 0);
  }

  function formatDateTime(value) {
    return new Date(value).toLocaleString("nb-NO", {
      dateStyle: "short",
      timeStyle: "short",
    });
  }
})();
