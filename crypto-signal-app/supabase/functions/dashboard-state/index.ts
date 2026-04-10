import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { createAdminClient } from "../_shared/database.ts";
import { getTodayKey } from "../_shared/markets.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createAdminClient();
    const tradeDate = getTodayKey();

    const [{ data: setups, error: setupError }, { data: trades, error: tradeError }, {
      data: learningState,
      error: learningError,
    }] = await Promise.all([
      supabase.from("market_setups").select("*").eq("trade_date", tradeDate).order("market"),
      supabase.from("trades").select("*").order("entry_confirmed_at", { ascending: false }).limit(250),
      supabase.from("learning_state").select("*").order("market"),
    ]);

    if (setupError) throw setupError;
    if (tradeError) throw tradeError;
    if (learningError) throw learningError;

    return jsonResponse({
      ok: true,
      tradeDate,
      setups: setups ?? [],
      trades: trades ?? [],
      learningState: learningState ?? [],
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});
