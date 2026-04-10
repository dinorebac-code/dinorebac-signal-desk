import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { createAdminClient } from "../_shared/database.ts";
import { recomputeLearning } from "../_shared/strategy.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { tradeId, result } = await request.json();
    if (!tradeId || !["win", "loss"].includes(result)) {
      return jsonResponse({ ok: false, error: "tradeId and valid result are required" }, 400);
    }

    const supabase = createAdminClient();
    const { data: trade, error: updateError } = await supabase
      .from("trades")
      .update({
        status: "closed",
        result,
        closed_at: new Date().toISOString(),
      })
      .eq("id", tradeId)
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    const { data: trades, error: tradeError } = await supabase
      .from("trades")
      .select("*")
      .eq("status", "closed")
      .not("result", "is", null)
      .order("entry_confirmed_at", { ascending: false });

    if (tradeError) {
      throw tradeError;
    }

    const learningMap = recomputeLearning(trades ?? []);
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

    return jsonResponse({
      ok: true,
      trade,
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});
