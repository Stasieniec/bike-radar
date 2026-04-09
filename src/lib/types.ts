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
      found: number;
      total: number;
      queryIndex: number;
      queryCount: number;
    }
  | { phase: "classifying"; current: number; total: number; matchesFound: number }
  | { phase: "match"; listing: MatchedListing }
  | { phase: "non_match"; listing: MarktplaatsListing }
  | { phase: "done"; totalScraped: number; totalMatches: number }
  | { phase: "error"; message: string };

// --- API request/response ---

export interface SearchRequest {
  apiKey: string;
  postcode: string;
  radiusKm: number;
  description: string;
  photos?: string[]; // base64 data URLs
}

export interface ValidateKeyResponse {
  valid: boolean;
  error?: string;
}
