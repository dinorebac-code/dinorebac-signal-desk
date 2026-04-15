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

      const candles = await fetchCandles(market.symbol);
      const latest = candles[candles.length - 2];
      const previous = candles[candles.length - 3];
      if (!latest || !previous) {
        continue;
      }

      const [zoneLow, zoneHigh] = String(setup.entry_zone).split(" - ").map(Number);
      const zonePadding = buildZonePadding({
        market: setup.market,
        atr: Number(setup.features?.atr ?? 0),
      });
      const zoneHit = intersectsZone(previous, zoneLow, zoneHigh, zonePadding) ||
        intersectsZone(latest, zoneLow, zoneHigh, zonePadding) ||
        closeIsNearZone(latest.close, zoneLow, zoneHigh, zonePadding);
      const triggerHit = detectTrigger(setup.trigger_type, previous, latest);

      if (!zoneHit || !triggerHit) {
        await supabase
          .from("market_setups")
          .update({
            monitor_state: zoneHit ? "watching" : "waiting",
            monitor_message: zoneHit
              ? `Pris er i sonen, men ${String(setup.trigger_type).replaceAll("_", " ")} er ikke bekreftet enda.`
              : "Venter pa at pris skal komme inn i entry-zonen.",
          })
          .eq("id", setup.id);
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
