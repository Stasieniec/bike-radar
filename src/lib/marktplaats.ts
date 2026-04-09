import { MarktplaatsListing } from "./types";

const MARKTPLAATS_API = "https://www.marktplaats.nl/lrp/api/search";
const BIKE_CATEGORY_L1 = 445; // Fietsen en Brommers
const RESULTS_PER_PAGE = 100;
const MAX_PAGES_PER_QUERY = 100;
const REQUEST_DELAY_MS = 1000;

const DUTCH_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mrt: 2, apr: 3, mei: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11,
};

/**
 * Parse Dutch date strings from Marktplaats API.
 * Formats: "Vandaag", "Gisteren", "Eergisteren", "12 mrt 26", "5 apr 25"
 */
function parseDutchDate(dateStr: string): Date | null {
  const lower = dateStr.toLowerCase().trim();

  if (lower === "vandaag") return today();
  if (lower === "gisteren") return daysAgo(1);
  if (lower === "eergisteren") return daysAgo(2);

  // Match "12 mrt 26" or "5 apr 25"
  const match = lower.match(/^(\d{1,2})\s+([a-z]{3})\s+(\d{2,4})$/);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = DUTCH_MONTHS[match[2]];
    const rawYear = parseInt(match[3], 10);
    if (month == null || isNaN(day) || isNaN(rawYear)) return null;
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    return new Date(year, month, day);
  }

  return null;
}

function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n: number): Date {
  const d = today();
  d.setDate(d.getDate() - n);
  return d;
}

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

  // Pick the tightest server-side date filter that covers the stolen date
  const daysSinceStolen = Math.floor(
    (Date.now() - cutoffDate.getTime()) / (1000 * 60 * 60 * 24)
  );
  const offeredSince =
    daysSinceStolen <= 0 ? "Vandaag" : daysSinceStolen <= 1 ? "Gisteren" : "Een week";

  for (let page = 0; page < MAX_PAGES_PER_QUERY; page++) {
    const params = new URLSearchParams({
      query,
      l1CategoryId: String(BIKE_CATEGORY_L1),
      limit: String(RESULTS_PER_PAGE),
      offset: String(page * RESULTS_PER_PAGE),
      postcode,
      distanceMeters: String(distanceMeters),
      sortBy: "SORT_ON_DATE",
      sortOrder: "DECREASING",
      bypassSpellingSuggestion: "true",
      "attributesByKey[]": `offeredSince:${offeredSince}`,
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

    let hasNewItemOnPage = false;

    for (const item of items) {
      const itemId = item.itemId as string;
      if (seen.has(itemId)) continue;

      // Parse listing date — include if missing or unparseable (don't accidentally filter out)
      const rawDate = (item.date as string) || "";
      let datePosted = "";
      if (rawDate) {
        const parsed = parseDutchDate(rawDate);
        if (parsed) {
          datePosted = parsed.toISOString();
          if (parsed < cutoffDate) continue;
        }
      }

      hasNewItemOnPage = true;

      seen.add(itemId);

      listings.push({
        itemId,
        title: (item.title as string) || "",
        description: (item.categorySpecificDescription as string) || (item.description as string) || "",
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

    // If no new (unseen + within date range) listings on this page, stop paginating
    if (!hasNewItemOnPage) break;

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
