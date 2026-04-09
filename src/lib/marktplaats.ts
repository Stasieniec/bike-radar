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
