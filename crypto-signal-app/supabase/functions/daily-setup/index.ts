import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { createAdminClient } from "../_shared/database.ts";
import { getTodayKey, MARKETS } from "../_shared/markets.ts";
import { buildSetup, defaultLearning, fetchCandles } from "../_shared/strategy.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createAdminClient();
    const tradeDate = getTodayKey();
    const { data: learningRows, error: learningError } = await supabase.from("learning_state").select("*");
    if (learningError) {
      throw learningError;
    }

    const learningMap = new Map(
      (learningRows ?? []).map((row) => [row.market, (row.state as Record<string, unknown>) ?? defaultLearning(row.market)]),
    );

    const rows = [];
    for (const market of MARKETS) {
      const candles = await fetchCandles(market.symbol);
      const learning = learningMap.get(market.code) ?? defaultLearning(market.code);
      const setup = buildSetup(market.code, candles, learning);
      rows.push({
        trade_date: tradeDate,
        market: market.code,
        bias: setup.bias,
        confidence: setup.confidence,
        recommendation: setup.recommendation,
        entry_zone: setup.entryZone,
        trigger_type: setup.triggerType,
        trigger_note: setup.triggerNote,
        monitor_state: setup.monitorState,
        monitor_message: setup.monitorMessage,
        generated_at: new Date().toISOString(),
        data_source: "Twelve Data",
        features: setup.features,
      });
    }

    const { data, error } = await supabase.from("market_setups").upsert(rows, {
      onConflict: "trade_date,market",
    }).select();
    if (error) {
      throw error;
    }

    return jsonResponse({
      ok: true,
      tradeDate,
      setups: data ?? [],
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});
