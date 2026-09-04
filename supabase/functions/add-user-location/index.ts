import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "https://loutk.github.io",
  Vary: "Origin",
};

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON." }, 400);
  }
  if (!payload || typeof payload !== "object") {
    return jsonResponse({ error: "Invalid location." }, 400);
  }

  const { name, lat, lon } = payload as Record<string, unknown>;
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (
    !normalizedName ||
    normalizedName.length > 200 ||
    typeof lat !== "number" ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    typeof lon !== "number" ||
    !Number.isFinite(lon) ||
    lon < -180 ||
    lon > 180
  ) {
    return jsonResponse({ error: "Invalid location." }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  const location = {
    id: `user-${crypto.randomUUID()}`,
    name: normalizedName,
    lat,
    lon,
    source: "Gebruiker",
  };
  const { error } = await supabase.from("user_locations").insert(location);
  if (error) {
    console.error("Could not insert user location:", error.message);
    return jsonResponse({ error: "Could not save location." }, 500);
  }

  return jsonResponse(location, 201);
});
