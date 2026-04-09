import { MarktplaatsListing } from "./types";

const MARKTPLAATS_API = "https://www.marktplaats.nl/lrp/api/search";
const BIKE_CATEGORY_L1 = 445; // Fietsen en Brommers
const RESULTS_PER_PAGE = 30;
const MAX_PAGES_PER_QUERY = 3;
const REQUEST_DELAY_MS = 1000;
const MAX_LISTINGS = 500;

const RADIUS_TO_METERS: Record<number, number> = {
  3: 3000,
  5: 5000,
  10: 10000,
  15: 15000,
  25: 25000,
  50: 50000,
  75: 75000,
};

export interface ScrapeProgress {
  query: string;
  found: number;
  total: number;
  queryIndex: number;
  queryCount: number;
}

export async function scrapeMarktplaats(
  queries: string[],
  postcode: string,
  radiusKm: number,
  onProgress: (progress: ScrapeProgress) => void
): Promise<MarktplaatsListing[]> {
  const seen = new Set<string>();
  const listings: MarktplaatsListing[] = [];
  const distanceMeters = RADIUS_TO_METERS[radiusKm] || 50000;

  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi];
    let queryFound = 0;

    for (let page = 0; page < MAX_PAGES_PER_QUERY; page++) {
      if (listings.length >= MAX_LISTINGS) break;

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

      try {
        const res = await fetch(`${MARKTPLAATS_API}?${params}`);
        if (!res.ok) break;

        const data = await res.json();
        const items = data.listings || [];
        if (items.length === 0) break;

        for (const item of items) {
          if (seen.has(item.itemId) || listings.length >= MAX_LISTINGS) continue;
          seen.add(item.itemId);
          queryFound++;

          listings.push({
            itemId: item.itemId,
            title: item.title || "",
            description: item.description || "",
            price: formatPrice(item.priceInfo),
            imageUrls: (item.imageUrls || []).map((u: string) =>
              u.startsWith("//") ? `https:${u}` : u
            ),
            location: item.location?.cityName || "Onbekend",
            distance: Math.round((item.location?.distanceMeters || 0) / 1000),
            url: item.vipUrl
              ? `https://www.marktplaats.nl${item.vipUrl}`
              : `https://www.marktplaats.nl/v/item/${item.itemId}`,
          });
        }
      } catch {
        // Skip failed pages
        break;
      }

      // Delay between pages
      if (page < MAX_PAGES_PER_QUERY - 1) {
        await delay(REQUEST_DELAY_MS);
      }
    }

    onProgress({
      query,
      found: queryFound,
      total: listings.length,
      queryIndex: qi + 1,
      queryCount: queries.length,
    });

    // Delay between queries
    if (qi < queries.length - 1 && listings.length < MAX_LISTINGS) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  return listings;
}

export function formatPrice(priceInfo: Record<string, unknown> | null | undefined): string {
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
