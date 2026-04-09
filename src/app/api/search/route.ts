import { generateSearchQueries, classifyListing } from "@/lib/gemini";
import { scrapeMarktplaatsQuery } from "@/lib/marktplaats";
import { sendSSE } from "@/lib/sse";
import { SearchRequest, MatchedListing } from "@/lib/types";

const CLASSIFICATION_BATCH_SIZE = 5;
const CLASSIFICATION_BATCH_DELAY_MS = 2000;

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as SearchRequest;
  const { apiKey, postcode, radiusKm, description, photos, stolenSince } = body;

  if (!apiKey || !postcode || !description || radiusKm == null || !stolenSince) {
    return Response.json(
      {
        error:
          "Missing required fields: apiKey, postcode, radiusKm, description, stolenSince",
      },
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

        // Step 2+3: Interleaved scrape → classify per query
        const seen = new Set<string>();
        let totalScraped = 0;
        let totalMatches = 0;
        let totalSkipped = 0;

        for (let qi = 0; qi < queries.length; qi++) {
          const query = queries[qi].query;

          try {
            // Scrape this query
            const newListings = await scrapeMarktplaatsQuery(
              query,
              postcode,
              radiusKm,
              stolenSince,
              seen
            );

            totalScraped += newListings.length;

            sendSSE(controller, encoder, {
              phase: "scraping",
              query,
              queryIndex: qi + 1,
              queryCount: queries.length,
              newListings: newListings.length,
              totalListings: totalScraped,
            });

            // Classify this query's new listings in batches
            for (let i = 0; i < newListings.length; i += CLASSIFICATION_BATCH_SIZE) {
              const batch = newListings.slice(i, i + CLASSIFICATION_BATCH_SIZE);

              const results = await Promise.allSettled(
                batch.map((listing) =>
                  classifyListing(apiKey, description, photos, listing)
                )
              );

              for (let j = 0; j < results.length; j++) {
                const result = results[j];

                if (result.status === "fulfilled" && result.value.match) {
                  totalMatches++;
                  const matched: MatchedListing = {
                    ...batch[j],
                    confidence: result.value.confidence,
                    reason: result.value.reason,
                  };
                  sendSSE(controller, encoder, {
                    phase: "match",
                    listing: matched,
                  });
                } else if (result.status === "fulfilled") {
                  sendSSE(controller, encoder, {
                    phase: "non_match",
                    listing: batch[j],
                  });
                } else {
                  // Retry once on failure
                  try {
                    const retry = await classifyListing(
                      apiKey,
                      description,
                      photos,
                      batch[j]
                    );
                    if (retry.match) {
                      totalMatches++;
                      const matched: MatchedListing = {
                        ...batch[j],
                        confidence: retry.confidence,
                        reason: retry.reason,
                      };
                      sendSSE(controller, encoder, {
                        phase: "match",
                        listing: matched,
                      });
                    } else {
                      sendSSE(controller, encoder, {
                        phase: "non_match",
                        listing: batch[j],
                      });
                    }
                  } catch {
                    totalSkipped++;
                  }
                }
              }

              sendSSE(controller, encoder, {
                phase: "classifying",
                current: Math.min(i + CLASSIFICATION_BATCH_SIZE, newListings.length),
                total: newListings.length,
                matchesFound: totalMatches,
              });

              // Delay between classification batches to respect Gemini rate limits
              if (i + CLASSIFICATION_BATCH_SIZE < newListings.length) {
                await new Promise((resolve) =>
                  setTimeout(resolve, CLASSIFICATION_BATCH_DELAY_MS)
                );
              }
            }
          } catch {
            // Skip failed query, continue with the rest
            sendSSE(controller, encoder, {
              phase: "scraping",
              query,
              queryIndex: qi + 1,
              queryCount: queries.length,
              newListings: 0,
              totalListings: totalScraped,
            });
          }

          // Delay between queries to avoid rate limiting
          if (qi < queries.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }

        // Step 4: Done
        sendSSE(controller, encoder, {
          phase: "done",
          totalScraped,
          totalMatches,
          skipped: totalSkipped,
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
