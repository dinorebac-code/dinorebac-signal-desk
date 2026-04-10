import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { createAdminClient } from "../_shared/database.ts";
import { MARKETS } from "../_shared/markets.ts";
import { fetchCandles, recomputeLearning } from "../_shared/strategy.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createAdminClient();
    const { data: trades, error: tradeError } = await supabase
      .from("trades")
      .select("*")
      .eq("status", "open")
      .order("entry_confirmed_at", { ascending: true });

    if (tradeError) {
      throw tradeError;
    }

    const resolved = [];
    for (const trade of trades ?? []) {
      const market = MARKETS.find((entry) => entry.code === trade.market);
      if (!market) {
        continue;
      }

      const stopPrice = Number(trade.features?.stopPrice);
      const targetPrice = Number(trade.features?.targetPrice);
      if (!stopPrice || !targetPrice) {
        continue;
      }

      const candles = await fetchCandles(market.symbol, 200);
      const entryTime = new Date(trade.entry_confirmed_at).getTime();
      const postEntryCandles = candles.filter((candle) => new Date(candle.datetime).getTime() >= entryTime);
      const resolution = resolveTradeFromCandles({
        bias: trade.bias,
        stopPrice,
        targetPrice,
        candles: postEntryCandles,
      });

      if (!resolution) {
        continue;
      }

      const { data: updatedTrade, error: updateError } = await supabase
        .from("trades")
        .update({
          status: "closed",
          result: resolution.result,
          closed_at: resolution.closedAt,
          features: {
            ...(trade.features ?? {}),
            resolvedBy: "auto",
            resolvedAt: resolution.closedAt,
            resolvedReason: resolution.reason,
          },
        })
        .eq("id", trade.id)
        .select()
        .single();

      if (updateError) {
        throw updateError;
      }

      resolved.push(updatedTrade);
    }

    if (resolved.length) {
      const { data: closedTrades, error: closedTradeError } = await supabase
        .from("trades")
        .select("*")
        .eq("status", "closed")
        .not("result", "is", null)
        .order("entry_confirmed_at", { ascending: false });

      if (closedTradeError) {
        throw closedTradeError;
      }

      const learningMap = recomputeLearning(closedTrades ?? []);
      const rows = Object.entries(learningMap).map(([market, state]) => ({
        market,
        sample_size: state.sampleSize,
        state,
        updated_at: new Date().toISOString(),
      }));

      const { error: learningError } = await supabase
        .from("learning_state")
        .upsert(rows, { onConflict: "market" });

      if (learningError) {
        throw learningError;
      }
    }

    return jsonResponse({
      ok: true,
      resolvedCount: resolved.length,
      resolved,
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});

function resolveTradeFromCandles(input: {
  bias: string;
  stopPrice: number;
  targetPrice: number;
  candles: Array<{ datetime: string; high: number; low: number }>;
}) {
  for (const candle of input.candles) {
    const hitTarget = input.bias === "long" ? candle.high >= input.targetPrice : candle.low <= input.targetPrice;
    const hitStop = input.bias === "long" ? candle.low <= input.stopPrice : candle.high >= input.stopPrice;

    if (!hitTarget && !hitStop) {
      continue;
    }

    if (hitTarget && hitStop) {
      return {
        result: "loss",
        closedAt: new Date(candle.datetime).toISOString(),
        reason: "Both levels touched in same candle, conservative auto-loss applied",
      };
    }

    if (hitTarget) {
      return {
        result: "win",
        closedAt: new Date(candle.datetime).toISOString(),
        reason: "Auto target hit first",
      };
    }

    return {
      result: "loss",
      closedAt: new Date(candle.datetime).toISOString(),
      reason: "Auto stop hit first",
    };
  }

  return null;
}
