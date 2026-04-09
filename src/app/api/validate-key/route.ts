import { validateApiKey } from "@/lib/gemini";
import { ValidateKeyResponse } from "@/lib/types";

export const runtime = "edge";

export async function POST(request: Request): Promise<Response> {
  const { apiKey } = (await request.json()) as { apiKey?: string };

  if (!apiKey || apiKey.trim().length === 0) {
    return Response.json({ valid: false, error: "API key is required" } satisfies ValidateKeyResponse);
  }

  try {
    const valid = await validateApiKey(apiKey);
    if (valid) {
      return Response.json({ valid: true } satisfies ValidateKeyResponse);
    }
    return Response.json({ valid: false, error: "Invalid API key" } satisfies ValidateKeyResponse);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ valid: false, error: `Validation failed: ${message}` } satisfies ValidateKeyResponse);
  }
}
