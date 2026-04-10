import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { createAdminClient } from "../_shared/database.ts";
import { recomputeLearning } from "../_shared/strategy.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createAdminClient();
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

    const { data, error } = await supabase
      .from("learning_state")
      .upsert(rows, { onConflict: "market" })
      .select();

    if (error) {
      throw error;
    }

    return jsonResponse({
      ok: true,
      learning: data ?? [],
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});
