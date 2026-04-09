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
      phase: "prefiltering";
      kept: number;
      total: number;
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
