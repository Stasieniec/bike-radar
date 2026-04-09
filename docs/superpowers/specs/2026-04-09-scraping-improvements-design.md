# Scraping Improvements — Design Spec

Improve scraping coverage and UX: add date filtering, remove listing caps, increase pagination depth, and interleave scraping with classification for live results.

## Changes Overview

1. **Date range filtering** — new "Stolen since" date input, filter listings to only those posted after that date
2. **Remove MAX_LISTINGS cap** — no artificial limit on total listings
3. **MAX_PAGES_PER_QUERY = 100** — paginate until empty or all listings are older than the cutoff
4. **Interleaved pipeline** — scrape one query → classify its new listings → next query (matches stream live)
5. **Retry failed classifications** — one retry before skipping, report skip count

## Files Changed

- `src/lib/types.ts` — data model updates
- `src/lib/marktplaats.ts` — per-query scraping function, date filtering, remove caps
- `src/app/api/search/route.ts` — new interleaved orchestration loop
- `src/components/BikeRadar.tsx` — date picker, reworked progress display

## Data Model (types.ts)

### SearchRequest

Add `stolenSince` field:

```ts
export interface SearchRequest {
  apiKey: string;
  postcode: string;
  radiusKm: number;
  description: string;
  photos?: string[];
  stolenSince: string; // ISO date, e.g. "2026-04-01"
}
```

### MarktplaatsListing

Add `datePosted` field to capture from API response:

```ts
export interface MarktplaatsListing {
  // ... existing fields ...
  datePosted: string; // ISO date string from Marktplaats API
}
```

### SSE Events

Update `scraping` event to carry the query text. Add `skipped` count to `done`:

```ts
export type SSEEvent =
  | { phase: "queries"; queries: SearchQuery[] }
  | {
      phase: "scraping";
      query: string;
      queryIndex: number;
      queryCount: number;
      newListings: number;    // new unique listings from this query
      totalListings: number;  // running total unique listings
    }
  | { phase: "classifying"; current: number; total: number; matchesFound: number }
  | { phase: "match"; listing: MatchedListing }
  | { phase: "non_match"; listing: MarktplaatsListing }
  | { phase: "done"; totalScraped: number; totalMatches: number; skipped: number }
  | { phase: "error"; message: string };
```

## Scraper (marktplaats.ts)

### Constants

```ts
const RESULTS_PER_PAGE = 30;
const MAX_PAGES_PER_QUERY = 100;
const REQUEST_DELAY_MS = 1000;
// MAX_LISTINGS removed entirely
```

### New function: `scrapeMarktplaatsQuery`

Replace the multi-query `scrapeMarktplaats` with a single-query function:

```ts
export async function scrapeMarktplaatsQuery(
  query: string,
  postcode: string,
  radiusKm: number,
  stolenSince: string,
  seen: Set<string>,
  onPageProgress?: (fetched: number) => void
): Promise<MarktplaatsListing[]>
```

Behavior:
- Paginates through up to `MAX_PAGES_PER_QUERY` pages for the given query
- Skips listings whose `itemId` is already in `seen`; adds new IDs to `seen`
- Filters out listings posted before `stolenSince` date
- Early termination: if an entire page contains only listings older than `stolenSince`, stop paginating (Marktplaats returns results in roughly reverse-chronological order within relevance tiers, so once we hit old listings consistently, deeper pages won't have newer ones)
- Early termination: if a page returns 0 items, stop
- Calls `onPageProgress` after each page with the count of new listings found so far for this query
- 1 second delay between page fetches

### Date field from API

The Marktplaats `/lrp/api/search` response includes a `date` field per listing (ISO string). Capture this into `datePosted`. Filter: `new Date(item.date) >= new Date(stolenSince)`. If `item.date` is missing, include the listing (don't accidentally filter out valid results).

### API date parameter

Try passing `searchDateFrom` to the API as a query parameter for server-side filtering. This is best-effort — the client-side date filter described above is the authoritative filter.

## Pipeline (route.ts)

Replace the current sequential "scrape all → classify all" with an interleaved loop:

```
queries = generateSearchQueries(...)
stream SSE: queries

seen = Set<string>()
totalMatches = 0
totalScraped = 0
totalSkipped = 0

for (qi = 0; qi < queries.length; qi++):
  newListings = scrapeMarktplaatsQuery(query, postcode, radiusKm, stolenSince, seen)
  totalScraped += newListings.length

  stream SSE: { phase: "scraping", query, queryIndex, queryCount, newListings: newListings.length, totalListings: totalScraped }

  // Classify this query's new listings in batches of 10
  for batch in chunks(newListings, 10):
    results = Promise.allSettled(batch.map(classifyListing))
    for each result:
      if fulfilled + match → stream match SSE, totalMatches++
      if fulfilled + no match → stream non_match SSE
      if rejected → retry once, if still rejected → totalSkipped++
    stream SSE: { phase: "classifying", current, total: newListings.length, matchesFound: totalMatches }

stream SSE: { phase: "done", totalScraped, totalMatches, skipped: totalSkipped }
```

### Classification retry

On rejected promise, retry the same `classifyListing` call once. If it fails again, increment `totalSkipped` and move on. The `done` event reports `skipped` so the UI can inform the user.

## UI (BikeRadar.tsx)

### Date input

Add a "Stolen since" date input between the postcode/radius row and the description textarea:

- HTML `<input type="date">` — native date picker
- Default value: 7 days ago
- Label: "Stolen since"
- Sent as `stolenSince` in the search request
- Validation: must not be in the future

### Progress display

Rework the progress section to show richer information during the interleaved pipeline:

During scraping+classification phase:
- Show current query name: **"Searching: herenfiets rood (query 5/12)"**
- Running totals: **"347 unique listings found, 3 matches so far"**
- Progress bar tracks query progress (queryIndex / queryCount)

### Matches stream in live

Matches already render via the `match` SSE event handler — no change needed there. They'll just start appearing much sooner since classification happens per-query instead of after all scraping.

### Done summary

Update to include skipped count if > 0:
- "Scanned 847 listings. Found 5 potential matches."
- "Scanned 847 listings. Found 5 potential matches. 3 listings could not be analyzed."

## Error Handling

- Marktplaats page fetch fails: break pagination for that query, continue to classification of what was found, then move to next query
- Gemini classification fails: retry once, then skip. Report in done event.
- All other error handling unchanged from current implementation.

## Performance Considerations

With MAX_PAGES_PER_QUERY=100 and up to 15 queries, worst case is 1500 page fetches at 1s delay each = ~25 minutes of scraping alone. In practice, most queries will return far fewer pages (empty page → stop). The interleaved approach means the user sees results progressively rather than waiting for all scraping to complete.
