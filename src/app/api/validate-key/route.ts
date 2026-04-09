import { validateApiKey } from "@/lib/gemini";

export const runtime = "edge";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const apiKey = body?.apiKey;

    if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return new Response(
        JSON.stringify({ valid: false, error: "API key is required" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const valid = await validateApiKey(apiKey);
    return new Response(
      JSON.stringify({ valid, error: valid ? undefined : "Invalid API key" }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return new Response(
      JSON.stringify({ valid: false, error: message }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
}
