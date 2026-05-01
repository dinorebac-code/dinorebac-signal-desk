import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { createAdminClient } from "../_shared/database.ts";
import { sendSignalEmail } from "../_shared/email.ts";
import { getTodayKey, isInsideWatchWindow, MARKETS } from "../_shared/markets.ts";
import { buildAutoExitLevels, detectTrigger, fetchCandles } from "../_shared/strategy.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!isInsideWatchWindow()) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "Outside watch window",
      });
    }

    const supabase = createAdminClient();
    const tradeDate = getTodayKey();
    const { data: setups, error: setupError } = await supabase
      .from("market_setups")
      .select("*")
      .eq("trade_date", tradeDate)
      .neq("monitor_state", "confirmed");

    if (setupError) {
      throw setupError;
    }

    const confirmedTrades = [];
    for (const setup of setups ?? []) {
      const market = MARKETS.find((entry) => entry.code === setup.market);
      if (!market) {
        continue;
      }

      const [zoneLow, zoneHigh] = String(setup.entry_zone).split(" - ").map(Number);
      const zonePadding = buildZonePadding({
        market: setup.market,
        atr: Number(setup.features?.atr ?? 0),
      });
      const candles = await fetchCandles(market.symbol, 160);
      const confirmation = findEntryConfirmation({
        candles,
        setupGeneratedAt: setup.generated_at,
        triggerType: setup.trigger_type,
        zoneLow,
        zoneHigh,
        zonePadding,
      });

      if (!confirmation.confirmed) {
        await supabase
          .from("market_setups")
          .update({
            monitor_state: confirmation.zoneTouched ? "watching" : "waiting",
            monitor_message: confirmation.zoneTouched
              ? `Pris har vaert i sonen, men ${String(setup.trigger_type).replaceAll("_", " ")} er ikke bekreftet enda.`
              : "Venter pa at pris skal komme inn i entry-zonen.",
          })
          .eq("id", setup.id);
        continue;
      }

      const latest = confirmation.latest;
      if (!latest) {
        continue;
      }

      const autoExit = buildAutoExitLevels({
        bias: setup.bias,
        entryPrice: latest.close,
        atr: Number(setup.features?.atr ?? 0),
        marketCode: setup.market,
      });

      const tradeRow = {
        setup_id: setup.id,
        trade_date: tradeDate,
        market: setup.market,
        bias: setup.bias,
        confidence: setup.confidence,
        recommendation: setup.recommendation,
        entry_zone: setup.entry_zone,
        trigger_type: setup.trigger_type,
        trigger_note: setup.trigger_note,
        status: "open",
        result: null,
        entry_confirmed_at: new Date().toISOString(),
        data_source: "Twelve Data",
        features: {
          ...(setup.features ?? {}),
          entryPrice: latest.close,
          latestCandleAt: latest.datetime,
          confirmationMatchedAt: latest.datetime,
          stopPrice: autoExit.stopPrice,
          targetPrice: autoExit.targetPrice,
          resolutionRule: autoExit.resolutionRule,
        },
        learning_snapshot: {},
      };

      const { data: insertedTrade, error: tradeError } = await supabase
        .from("trades")
        .upsert(tradeRow, { onConflict: "setup_id" })
        .select()
        .single();

      if (tradeError) {
        throw tradeError;
      }

      await supabase
        .from("market_setups")
        .update({
          monitor_state: "confirmed",
          monitor_message: "Entry bekreftet og trade lagret automatisk.",
        })
        .eq("id", setup.id);

      const alertEmail = Deno.env.get("ALERT_EMAIL");
      if (alertEmail) {
        try {
          await sendSignalEmail({
            to: alertEmail,
            subject: `${setup.market} ${String(setup.bias).toUpperCase()} entry confirmed`,
            html:
              `<h2>Signal Desk Entry Confirmed</h2>` +
              `<p><strong>Market:</strong> ${setup.market}</p>` +
              `<p><strong>Bias:</strong> ${String(setup.bias).toUpperCase()}</p>` +
              `<p><strong>Confidence:</strong> ${setup.confidence}%</p>` +
              `<p><strong>Entry zone:</strong> ${setup.entry_zone}</p>` +
              `<p><strong>Trigger:</strong> ${setup.trigger_type}</p>` +
              `<p><strong>Entry price:</strong> ${latest.close}</p>` +
              `<p><strong>Auto stop:</strong> ${autoExit.stopPrice}</p>` +
              `<p><strong>Auto target:</strong> ${autoExit.targetPrice}</p>`,
          });
        } catch (error) {
          console.error("Signal email failed", error);
        }
      }

      confirmedTrades.push(insertedTrade);
    }

    return jsonResponse({
      ok: true,
      tradeDate,
      confirmedTrades,
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});

function findEntryConfirmation(input: {
  candles: Array<{ datetime: string; open: number; high: number; low: number; close: number }>;
  setupGeneratedAt: string;
  triggerType: string;
  zoneLow: number;
  zoneHigh: number;
  zonePadding: number;
}) {
  const closedCandles = input.candles.slice(0, -1);
  const setupTime = new Date(input.setupGeneratedAt).getTime();
  const recentCandles = closedCandles
    .filter((candle) => {
      const candleTime = new Date(candle.datetime).getTime();
      return Number.isNaN(candleTime) || Number.isNaN(setupTime) || candleTime >= setupTime - 30 * 60 * 1000;
    })
    .slice(-32);

  let zoneTouched = false;
  for (let index = 1; index < recentCandles.length; index += 1) {
    const previous = recentCandles[index - 1];
    const latest = recentCandles[index];
    const pairTouchedZone = intersectsZone(previous, input.zoneLow, input.zoneHigh, input.zonePadding) ||
      intersectsZone(latest, input.zoneLow, input.zoneHigh, input.zonePadding) ||
      closeIsNearZone(latest.close, input.zoneLow, input.zoneHigh, input.zonePadding);

    zoneTouched = zoneTouched || pairTouchedZone;
    if (pairTouchedZone && detectTrigger(input.triggerType, previous, latest)) {
      return {
        confirmed: true,
        zoneTouched,
        previous,
        latest,
      };
    }
  }

  return {
    confirmed: false,
    zoneTouched,
    previous: null,
    latest: null,
  };
}

function intersectsZone(
  candle: { low: number; high: number },
  zoneLow: number,
  zoneHigh: number,
  padding: number,
) {
  return candle.low <= zoneHigh + padding && candle.high >= zoneLow - padding;
}

function closeIsNearZone(close: number, zoneLow: number, zoneHigh: number, padding: number) {
  return close >= zoneLow - padding && close <= zoneHigh + padding;
}

function buildZonePadding(input: { market: string; atr: number }) {
  if (input.atr > 0) {
    return input.atr * 0.35;
  }

  return input.market === "SOL" ? 0.18 : 0.00035;
}
