import { MARKETS, TRIGGER_LABELS } from "./markets.ts";

export type LearningState = {
  market: string;
  sampleSize: number;
  windowSize: number;
  overallWinRate: number;
  biasWeights: {
    long: number;
    short: number;
  };
  triggerWeights: Record<string, number>;
  topTrigger: string;
  mode: string;
};

export type Candle = {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export function defaultLearning(market: string): LearningState {
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

export async function fetchCandles(symbol: string, outputsize = 120) {
  const apiKey = Deno.env.get("TWELVE_DATA_API_KEY");
  if (!apiKey) {
    throw new Error("Missing TWELVE_DATA_API_KEY");
  }

  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=15min&outputsize=${outputsize}&apikey=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url);
  const payload = await response.json();

  if (!response.ok || payload.status === "error" || !Array.isArray(payload.values)) {
    throw new Error(`Failed to fetch candles for ${symbol}: ${payload.message ?? response.statusText}`);
  }

  return payload.values
    .slice()
    .reverse()
    .map((item: Record<string, string>) => ({
      datetime: item.datetime,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
    })) as Candle[];
}

export function buildAutoExitLevels(input: {
  bias: string;
  entryPrice: number;
  atr: number;
  marketCode: string;
}) {
  const riskMultiplier = input.marketCode === "SOL" ? 0.9 : 0.75;
  const rewardMultiplier = input.marketCode === "SOL" ? 1.35 : 1.1;
  const stopDistance = input.atr * riskMultiplier;
  const targetDistance = input.atr * rewardMultiplier;

  if (input.bias === "long") {
    return {
      stopPrice: Number(roundPrice(input.entryPrice - stopDistance, input.marketCode)),
      targetPrice: Number(roundPrice(input.entryPrice + targetDistance, input.marketCode)),
      resolutionRule: "auto_atr_0.9R_stop_1.35R_target",
    };
  }

  return {
    stopPrice: Number(roundPrice(input.entryPrice + stopDistance, input.marketCode)),
    targetPrice: Number(roundPrice(input.entryPrice - targetDistance, input.marketCode)),
    resolutionRule: "auto_atr_0.75R_stop_1.1R_target",
  };
}

export function buildSetup(marketCode: string, candles: Candle[], learning: Partial<LearningState>) {
  const market = MARKETS.find((entry) => entry.code === marketCode);
  if (!market) {
    throw new Error(`Unknown market ${marketCode}`);
  }

  const normalizedLearning = {
    ...defaultLearning(marketCode),
    ...learning,
    biasWeights: {
      ...defaultLearning(marketCode).biasWeights,
      ...(learning.biasWeights ?? {}),
    },
    triggerWeights: {
      ...defaultLearning(marketCode).triggerWeights,
      ...(learning.triggerWeights ?? {}),
    },
  };

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

  const bias = trendScore >= 0 ? "long" : "short";
  const triggerType = pickTrigger(bias, market.code, normalizedLearning);
  const directionWeight = normalizedLearning.biasWeights[bias];
  const triggerWeight = normalizedLearning.triggerWeights[triggerType] ?? 0.5;
  const learningFactor =
    normalizedLearning.sampleSize < 10 ? 0.35 : normalizedLearning.sampleSize < 30 ? 0.65 : 1;
  const confidence = clamp(
    Math.round(
      Math.abs(trendScore) +
        14 +
        (directionWeight - 0.5) * 26 * learningFactor +
        (triggerWeight - 0.5) * 18 * learningFactor +
        atrValue * market.volatilityWeight * (market.code === "SOL" ? 1.2 : 8000)
    ),
    4,
    96,
  );

  const recommendation =
    confidence <= 24 ? "not_recommended" : confidence <= 49 ? "weak" : confidence <= 69 ? "moderate" : "strong";
  const zoneWidth = atrValue * (market.code === "SOL" ? 0.55 : 0.4);
  const zoneLow = bias === "long" ? latest.close - zoneWidth : latest.close + zoneWidth * 0.15;
  const zoneHigh = bias === "long" ? latest.close - zoneWidth * 0.15 : latest.close + zoneWidth;

  return {
    bias,
    confidence,
    recommendation,
    entryZone: `${roundPrice(Math.min(zoneLow, zoneHigh), market.code)} - ${roundPrice(Math.max(zoneLow, zoneHigh), market.code)}`,
    zoneLow: Number(roundPrice(Math.min(zoneLow, zoneHigh), market.code)),
    zoneHigh: Number(roundPrice(Math.max(zoneLow, zoneHigh), market.code)),
    triggerType,
    triggerLabel: TRIGGER_LABELS[triggerType],
    triggerNote: buildTriggerNote(bias, triggerType),
    monitorState: "waiting",
    monitorMessage: `Venter pa ${TRIGGER_LABELS[triggerType].toLowerCase()} i entry-zonen.`,
    features: {
      emaFast: roundPrice(emaFast, market.code),
      emaSlow: roundPrice(emaSlow, market.code),
      rsi: Number(roundNumber(rsiValue)),
      atr: roundPrice(atrValue, market.code),
      structure: structureScore > 0 ? "supportive" : structureScore < 0 ? "weak" : "neutral",
      learningMode: normalizedLearning.mode,
    },
  };
}

export function detectTrigger(triggerType: string, previous: Candle, latest: Candle) {
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

export function recomputeLearning(trades: Array<Record<string, unknown>>) {
  const nextState = Object.fromEntries(MARKETS.map((market) => [market.code, defaultLearning(market.code)]));

  for (const market of MARKETS) {
    const closed = trades.filter((trade) =>
      trade.market === market.code && trade.status === "closed" && typeof trade.result === "string"
    );
    const windowTrades = closed.slice(0, 100);
    const learning = defaultLearning(market.code);

    if (!windowTrades.length) {
      nextState[market.code] = learning;
      continue;
    }

    const wins = windowTrades.filter((trade) => trade.result === "win").length;
    learning.sampleSize = closed.length;
    learning.windowSize = windowTrades.length;
    learning.overallWinRate = Number(roundNumber((wins / windowTrades.length) * 100));
    learning.mode = windowTrades.length < 10 ? "Warmup" : windowTrades.length < 30 ? "Adaptive" : "Mature";

    for (const bias of ["long", "short"] as const) {
      const bucket = windowTrades.filter((trade) => trade.bias === bias);
      const bucketWins = bucket.filter((trade) => trade.result === "win").length;
      learning.biasWeights[bias] = Number(roundNumber((bucketWins + 1) / (bucket.length + 2), 3));
    }

    const triggerScores: Record<string, number> = {};
    for (const trigger of Object.keys(TRIGGER_LABELS)) {
      const bucket = windowTrades.filter((trade) => trade.trigger_type === trigger || trade.triggerType === trigger);
      const bucketWins = bucket.filter((trade) => trade.result === "win").length;
      const score = Number(roundNumber((bucketWins + 1) / (bucket.length + 2), 3));
      learning.triggerWeights[trigger] = score;
      triggerScores[trigger] = score;
    }

    const [bestTrigger] = Object.entries(triggerScores).sort((left, right) => right[1] - left[1])[0];
    learning.topTrigger = TRIGGER_LABELS[bestTrigger];
    nextState[market.code] = learning;
  }

  return nextState;
}

function computeStructureScore(candles: Candle[]) {
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

function buildTriggerNote(bias: string, triggerType: string) {
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

function pickTrigger(bias: string, marketCode: string, learning: LearningState) {
  const market = MARKETS.find((entry) => entry.code === marketCode);
  if (!market) {
    throw new Error(`Unknown market ${marketCode}`);
  }
  const candidates = bias === "long" ? market.preferredLongTriggers : market.preferredShortTriggers;
  const weighted = candidates
    .map((trigger) => ({
      trigger,
      score: learning.triggerWeights[trigger] ?? 0.5,
    }))
    .sort((left, right) => right.score - left.score);
  return weighted[0].trigger;
}

function ema(values: number[], length: number) {
  const multiplier = 2 / (length + 1);
  let current = values[0] ?? 0;
  for (let index = 1; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
  }
  return current;
}

function rsi(values: number[], length: number) {
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

function atr(candles: Candle[], length: number) {
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
      Math.abs(candle.low - previousClose),
    );
    ranges.push(trueRange);
  }
  return ranges.reduce((total, value) => total + value, 0) / ranges.length;
}

function roundPrice(value: number, marketCode: string) {
  return Number(value).toFixed(marketCode === "SOL" ? 2 : 4);
}

function roundNumber(value: number, digits = 1) {
  return Number(value).toFixed(digits);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
