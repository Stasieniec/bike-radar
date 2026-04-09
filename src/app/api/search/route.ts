import { generateSearchQueries, classifyListing } from "@/lib/gemini";
import { scrapeMarktplaats } from "@/lib/marktplaats";
import { sendSSE } from "@/lib/sse";
import { SearchRequest, MatchedListing } from "@/lib/types";

const CLASSIFICATION_BATCH_SIZE = 10;

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as SearchRequest;
  const { apiKey, postcode, radiusKm, description, photos } = body;

  // Input validation
  if (!apiKey || !postcode || !description || radiusKm == null) {
    return Response.json(
      { error: "Missing required fields: apiKey, postcode, radiusKm, description" },
      { status: 400 }
    );
  }

  if (!/^[1-9]\d{3}[A-Za-z]{2}$/.test(postcode)) {
    return Response.json({ error: "Invalid Dutch postcode" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Step 1: Generate search queries
        const queries = await generateSearchQueries(apiKey, description, photos);
        sendSSE(controller, encoder, { phase: "queries", queries });

        // Step 2: Scrape Marktplaats
        const listings = await scrapeMarktplaats(
          queries.map((q) => q.query),
          postcode,
          radiusKm,
          (progress) => {
            sendSSE(controller, encoder, { phase: "scraping", ...progress });
          }
        );

        // Step 3: Classify each listing
        let matchesFound = 0;

        for (let i = 0; i < listings.length; i += CLASSIFICATION_BATCH_SIZE) {
          const batch = listings.slice(i, i + CLASSIFICATION_BATCH_SIZE);

          const results = await Promise.allSettled(
            batch.map((listing) =>
              classifyListing(apiKey, description, photos, listing)
            )
          );

          for (let j = 0; j < results.length; j++) {
            const result = results[j];
            if (result.status === "fulfilled" && result.value.match) {
              matchesFound++;
              const matched: MatchedListing = {
                ...batch[j],
                confidence: result.value.confidence,
                reason: result.value.reason,
              };
              sendSSE(controller, encoder, { phase: "match", listing: matched });
            } else if (result.status === "fulfilled") {
              sendSSE(controller, encoder, { phase: "non_match", listing: batch[j] });
            }
            // rejected promises (API errors) are silently skipped
          }

          sendSSE(controller, encoder, {
            phase: "classifying",
            current: Math.min(i + CLASSIFICATION_BATCH_SIZE, listings.length),
            total: listings.length,
            matchesFound,
          });
        }

        // Step 4: Done
        sendSSE(controller, encoder, {
          phase: "done",
          totalScraped: listings.length,
          totalMatches: matchesFound,
        });
      } catch (e: unknown) {
        const message =
          e instanceof Error ? e.message : "An unexpected error occurred";
        sendSSE(controller, encoder, { phase: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
