# Scraping Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve scraping coverage with date filtering, remove listing caps, increase pagination to 100 pages, and interleave scraping with classification for live results.

**Architecture:** Replace the current "scrape all → classify all" sequential pipeline with a per-query interleaved loop. Each query is scraped, deduplicated, then classified before moving to the next query. A new `stolenSince` date parameter filters out old listings. Classification failures get one retry.

**Tech Stack:** Next.js 15 (App Router), TypeScript, Tailwind CSS, Gemini 2.5 Flash REST API, Marktplaats search API, SSE streaming.

**No test runner is configured in this project.** Verification is done via `npm run build` (TypeScript type-checking + Next.js build) after each task.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/types.ts` | Modify | Add `stolenSince` to request, `datePosted` to listing, update SSE event types |
| `src/lib/marktplaats.ts` | Rewrite | New `scrapeMarktplaatsQuery()` single-query function, date filtering, remove caps |
| `src/app/api/search/route.ts` | Rewrite | Interleaved per-query scrape→classify loop, retry logic, deduplication |
| `src/components/BikeRadar.tsx` | Modify | Date picker input, reworked progress display, skipped count in summary |

---

### Task 1: Update data model (types.ts)

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Update SearchRequest, MarktplaatsListing, and SSEEvent types**

Replace the entire contents of `src/lib/types.ts` with:

```ts
// --- Search query generation ---

export interface SearchQuery {
  query: string;
  specificity: "specific" | "medium" | "vague";
}

// --- Marktplaats listing ---

export interface MarktplaatsListing {
  itemId: string;
  title: string;
  description: string;
  price: string;
  imageUrls: string[];
  location: string;
  distance: number;
  url: string;
  datePosted: string; // ISO date string from Marktplaats API
}

// --- Classification ---

export interface ClassificationResult {
  match: boolean;
  confidence: number;
  reason: string;
}

export interface MatchedListing extends MarktplaatsListing {
  confidence: number;
  reason: string;
}

// --- SSE events ---

export type SSEEvent =
  | { phase: "queries"; queries: SearchQuery[] }
  | {
      phase: "scraping";
      query: string;
      queryIndex: number;
      queryCount: number;
      newListings: number;
      totalListings: number;
    }
  | {
      phase: "classifying";
      current: number;
      total: number;
      matchesFound: number;
    }
  | { phase: "match"; listing: MatchedListing }
  | { phase: "non_match"; listing: MarktplaatsListing }
  | {
      phase: "done";
      totalScraped: number;
      totalMatches: number;
      skipped: number;
    }
  | { phase: "error"; message: string };

// --- API request/response ---

export interface SearchRequest {
  apiKey: string;
  postcode: string;
  radiusKm: number;
  description: string;
  photos?: string[]; // base64 data URLs
  stolenSince: string; // ISO date, e.g. "2026-04-01"
}

export interface ValidateKeyResponse {
  valid: boolean;
  error?: string;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build fails because `marktplaats.ts` and `route.ts` reference the old types/functions. This is expected — we'll fix those in the next tasks.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: update types for date filtering and interleaved pipeline"
```

---

### Task 2: Rewrite scraper (marktplaats.ts)

**Files:**
- Rewrite: `src/lib/marktplaats.ts`

- [ ] **Step 1: Replace marktplaats.ts with per-query scraping function**

Replace the entire contents of `src/lib/marktplaats.ts` with:

```ts
import { MarktplaatsListing } from "./types";

const MARKTPLAATS_API = "https://www.marktplaats.nl/lrp/api/search";
const BIKE_CATEGORY_L1 = 445; // Fietsen en Brommers
const RESULTS_PER_PAGE = 30;
const MAX_PAGES_PER_QUERY = 100;
const REQUEST_DELAY_MS = 1000;

const RADIUS_TO_METERS: Record<number, number> = {
  3: 3000,
  5: 5000,
  10: 10000,
  15: 15000,
  25: 25000,
  50: 50000,
  75: 75000,
};

/**
 * Scrape Marktplaats for a single query, paginating until results are exhausted
 * or all listings are older than stolenSince.
 *
 * Deduplication: caller passes a `seen` Set. Listings already in `seen` are skipped.
 * New listing IDs are added to `seen` by this function.
 */
export async function scrapeMarktplaatsQuery(
  query: string,
  postcode: string,
  radiusKm: number,
  stolenSince: string,
  seen: Set<string>,
  onPageProgress?: (newCount: number) => void
): Promise<MarktplaatsListing[]> {
  const listings: MarktplaatsListing[] = [];
  const distanceMeters = RADIUS_TO_METERS[radiusKm] || 50000;
  const cutoffDate = new Date(stolenSince);

  for (let page = 0; page < MAX_PAGES_PER_QUERY; page++) {
    const params = new URLSearchParams({
      query,
      l1CategoryId: String(BIKE_CATEGORY_L1),
      limit: String(RESULTS_PER_PAGE),
      offset: String(page * RESULTS_PER_PAGE),
      postcode,
      distanceMeters: String(distanceMeters),
      sortBy: "SORT_INDEX",
      sortOrder: "DECREASING",
    });

    let items: Record<string, unknown>[];
    try {
      const res = await fetch(`${MARKTPLAATS_API}?${params}`);
      if (!res.ok) break;

      const data = await res.json();
      items = data.listings || [];
      if (items.length === 0) break;
    } catch {
      break;
    }

    let allOlderThanCutoff = true;

    for (const item of items) {
      const itemId = item.itemId as string;
      if (seen.has(itemId)) continue;

      // Parse listing date — include if missing (don't accidentally filter out)
      const rawDate = (item.date as string) || (item.timestamp as string) || "";
      const datePosted = rawDate ? new Date(rawDate).toISOString() : "";
      if (datePosted && new Date(datePosted) < cutoffDate) continue;
      if (!datePosted || new Date(datePosted) >= cutoffDate) {
        allOlderThanCutoff = false;
      }

      seen.add(itemId);

      listings.push({
        itemId,
        title: (item.title as string) || "",
        description: (item.description as string) || "",
        price: formatPrice(item.priceInfo as Record<string, unknown> | null),
        imageUrls: ((item.imageUrls as string[]) || []).map((u: string) =>
          u.startsWith("//") ? `https:${u}` : u
        ),
        location: (item.location as Record<string, unknown>)?.cityName as string || "Onbekend",
        distance: Math.round(
          ((item.location as Record<string, unknown>)?.distanceMeters as number || 0) / 1000
        ),
        url: (item.vipUrl as string)
          ? `https://www.marktplaats.nl${item.vipUrl as string}`
          : `https://www.marktplaats.nl/v/item/${itemId}`,
        datePosted,
      });
    }

    onPageProgress?.(listings.length);

    // If every listing on this page was older than cutoff, stop paginating
    if (allOlderThanCutoff) break;

    // Delay between pages
    if (page < MAX_PAGES_PER_QUERY - 1) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  return listings;
}

export function formatPrice(
  priceInfo: Record<string, unknown> | null | undefined
): string {
  if (!priceInfo) return "Onbekend";
  const cents = priceInfo.priceCents as number | undefined;
  if (cents != null && cents > 0) {
    return `\u20AC${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
  }
  const type = priceInfo.priceType as string | undefined;
  if (type === "FAST_BID") return "Bieden";
  if (type === "SEE_DESCRIPTION") return "Zie omschrijving";
  if (type === "FREE") return "Gratis";
  if (type === "EXCHANGE") return "Ruilen";
  return type || "Onbekend";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: May still fail due to `route.ts` importing the old `scrapeMarktplaats` function. That's fixed in the next task.

- [ ] **Step 3: Commit**

```bash
git add src/lib/marktplaats.ts
git commit -m "feat: rewrite scraper with per-query function, date filtering, 100-page pagination"
```

---

### Task 3: Rewrite pipeline (route.ts)

**Files:**
- Rewrite: `src/app/api/search/route.ts`

- [ ] **Step 1: Replace route.ts with interleaved scrape→classify pipeline**

Replace the entire contents of `src/app/api/search/route.ts` with:

```ts
import { generateSearchQueries, classifyListing } from "@/lib/gemini";
import { scrapeMarktplaatsQuery } from "@/lib/marktplaats";
import { sendSSE } from "@/lib/sse";
import { SearchRequest, MatchedListing } from "@/lib/types";

const CLASSIFICATION_BATCH_SIZE = 10;

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
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: May still fail due to `BikeRadar.tsx` referencing old SSE event shapes. Fixed in the next task.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/search/route.ts
git commit -m "feat: interleaved scrape-classify pipeline with retry logic"
```

---

### Task 4: Update UI (BikeRadar.tsx)

**Files:**
- Modify: `src/components/BikeRadar.tsx`

- [ ] **Step 1: Add stolenSince state and date input**

Add state variable after the `photos` state (around line 33):

```ts
  const [stolenSince, setStolenSince] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split("T")[0];
  });
```

- [ ] **Step 2: Add stolenSince to search request body**

In the `startSearch` function, update the `body: JSON.stringify(...)` call (around line 146) to include `stolenSince`:

Replace:
```ts
        body: JSON.stringify({
          apiKey,
          postcode: postcode.replace(/\s/g, "").toUpperCase(),
          radiusKm,
          description,
          photos: photos.length > 0 ? photos : undefined,
        }),
```

With:
```ts
        body: JSON.stringify({
          apiKey,
          postcode: postcode.replace(/\s/g, "").toUpperCase(),
          radiusKm,
          description,
          photos: photos.length > 0 ? photos : undefined,
          stolenSince,
        }),
```

- [ ] **Step 3: Add stolenSince to startSearch dependency array**

Update the dependency array of the `startSearch` useCallback (around line 168):

Replace:
```ts
  }, [apiKey, postcode, radiusKm, description, photos]);
```

With:
```ts
  }, [apiKey, postcode, radiusKm, description, photos, stolenSince]);
```

- [ ] **Step 4: Update handleSSEEvent for new scraping event shape**

Replace the `case "scraping"` handler in `handleSSEEvent`:

Replace:
```ts
      case "scraping":
        setProgress({
          phase: "scraping",
          message: `Searching Marktplaats (${event.queryIndex}/${event.queryCount})...`,
          current: event.queryIndex,
          total: event.queryCount,
        });
        setTotalScraped(event.total);
        break;
```

With:
```ts
      case "scraping":
        setProgress({
          phase: "scraping",
          message: `Query ${event.queryIndex}/${event.queryCount}: "${event.query}" \u2014 ${event.newListings} new (${event.totalListings} total unique)`,
          current: event.queryIndex,
          total: event.queryCount,
          matchesFound: progress?.matchesFound,
        });
        setTotalScraped(event.totalListings);
        break;
```

- [ ] **Step 5: Update done summary for skipped count**

Replace the done handler:

Replace:
```ts
      case "done":
        setSearchStatus("done");
        setTotalScraped(event.totalScraped);
        setProgress(null);
        break;
```

With:
```ts
      case "done":
        setSearchStatus("done");
        setTotalScraped(event.totalScraped);
        setProgress(null);
        break;
```

This handler stays the same. Instead, add state for skipped count. Add after the `nonMatches` state (around line 41):

```ts
  const [skippedCount, setSkippedCount] = useState(0);
```

Then update the done handler to:

```ts
      case "done":
        setSearchStatus("done");
        setTotalScraped(event.totalScraped);
        setSkippedCount(event.skipped);
        setProgress(null);
        break;
```

And reset it in `startSearch` alongside the other resets (after `setTotalScraped(0)`):

```ts
    setSkippedCount(0);
```

- [ ] **Step 6: Add "Stolen since" date input to the form**

Add this block between the Postcode/Radius row and the Description textarea. Insert after the closing `</div>` of the postcode/radius flex container (after line 343) and before the Description `<div className="mb-5">`:

```tsx
          {/* Stolen since */}
          <div className="mb-5">
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              Stolen since
            </label>
            <input
              type="date"
              value={stolenSince}
              onChange={(e) => setStolenSince(e.target.value)}
              max={new Date().toISOString().split("T")[0]}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            <p className="mt-1.5 text-xs text-gray-400">
              Only listings posted after this date will be checked
            </p>
          </div>
```

- [ ] **Step 7: Update done summary to show skipped count**

Replace the done summary JSX block:

Replace:
```tsx
            {searchStatus === "done" && (
              <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
                Scanned <strong>{totalScraped}</strong> listings. Found{" "}
                <strong>{matches.length}</strong> potential match
                {matches.length !== 1 ? "es" : ""}.
              </div>
            )}
```

With:
```tsx
            {searchStatus === "done" && (
              <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
                Scanned <strong>{totalScraped}</strong> listings. Found{" "}
                <strong>{matches.length}</strong> potential match
                {matches.length !== 1 ? "es" : ""}.
                {skippedCount > 0 && (
                  <span className="text-gray-400">
                    {" "}{skippedCount} listing{skippedCount !== 1 ? "s" : ""} could not be analyzed.
                  </span>
                )}
              </div>
            )}
```

- [ ] **Step 8: Update progress display to show matches during scraping**

Replace the progress section in the JSX:

Replace:
```tsx
            {progress && (
              <div className="mb-6 rounded-xl border border-blue-100 bg-blue-50 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm text-blue-700">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
                  {progress.message}
                </div>
                {progress.total && progress.current && (
                  <div className="h-2 overflow-hidden rounded-full bg-blue-200">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all"
                      style={{
                        width: `${(progress.current / progress.total) * 100}%`,
                      }}
                    />
                  </div>
                )}
                {progress.matchesFound != null && progress.matchesFound > 0 && (
                  <p className="mt-2 text-xs text-blue-600">
                    Found {progress.matchesFound} potential match
                    {progress.matchesFound !== 1 ? "es" : ""} so far
                  </p>
                )}
              </div>
            )}
```

With:
```tsx
            {progress && (
              <div className="mb-6 rounded-xl border border-blue-100 bg-blue-50 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm text-blue-700">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
                  {progress.message}
                </div>
                {progress.total != null && progress.current != null && (
                  <div className="h-2 overflow-hidden rounded-full bg-blue-200">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all"
                      style={{
                        width: `${(progress.current / progress.total) * 100}%`,
                      }}
                    />
                  </div>
                )}
                <div className="mt-2 flex items-center gap-3 text-xs text-blue-600">
                  {totalScraped > 0 && (
                    <span>{totalScraped} listings found</span>
                  )}
                  {progress.matchesFound != null && progress.matchesFound > 0 && (
                    <span>
                      {progress.matchesFound} match{progress.matchesFound !== 1 ? "es" : ""}
                    </span>
                  )}
                </div>
              </div>
            )}
```

- [ ] **Step 9: Verify build**

Run: `npm run build`
Expected: PASS — all files now consistent with the updated types and pipeline.

- [ ] **Step 10: Commit**

```bash
git add src/components/BikeRadar.tsx
git commit -m "feat: add date picker, live progress, and skipped count in UI"
```

---

### Task 5: Build verification and smoke test

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Clean build with no errors.

- [ ] **Step 2: Start dev server and visually verify**

Run: `npm run dev`

Verify in the browser:
1. The "Stolen since" date picker appears between postcode/radius and description
2. It defaults to 7 days ago
3. The form still requires API key validation, postcode, and description before enabling search
4. Progress during search shows query names and running totals
5. Matches appear live as each query's listings are classified

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address build or runtime issues from scraping improvements"
```
