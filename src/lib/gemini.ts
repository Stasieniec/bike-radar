import { GoogleGenerativeAI, Part } from "@google/generative-ai";
import { SearchQuery, ClassificationResult, MarktplaatsListing } from "./types";

const MODEL = "gemini-2.5-flash";

// --- API Key Validation ---

export async function validateApiKey(apiKey: string): Promise<boolean> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  );
  return res.ok;
}

// --- Query Generation ---

const QUERY_GENERATION_PROMPT = `You are helping find a stolen bicycle on Marktplaats, a Dutch online marketplace.

Based on the bike description (and photos if provided), generate 8-15 search queries that someone reselling this bike might use as a listing title on Marktplaats.

Generate a mix of:
- SPECIFIC: brand + model + color (e.g. "Giant Escape 3 rood")
- MEDIUM: partial features (e.g. "Giant stadsfiets", "rode herenfiets")
- VAGUE: generic terms a lazy seller might use (e.g. "herenfiets", "fiets ophalen", "stadsfiets")

Rules:
- Write queries in Dutch (most Marktplaats listings are in Dutch)
- Include common informal terms and abbreviations
- Think about how a thief (not the owner) would describe the bike
- Include color names in Dutch (rood, blauw, zwart, wit, groen, grijs, etc.)

Respond with ONLY a JSON array:
[{"query": "search term", "specificity": "specific"}, {"query": "another term", "specificity": "medium"}, ...]`;

export async function generateSearchQueries(
  apiKey: string,
  description: string,
  photos?: string[]
): Promise<SearchQuery[]> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: "application/json" },
  });

  const parts: Part[] = [
    { text: `${QUERY_GENERATION_PROMPT}\n\nBike description: ${description}` },
  ];

  if (photos?.length) {
    for (const photo of photos) {
      const parsed = parseDataUrl(photo);
      if (parsed) {
        parts.push({ inlineData: parsed });
      }
    }
  }

  const result = await model.generateContent(parts);
  const text = result.response.text();
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("Expected array");
    return parsed as SearchQuery[];
  } catch {
    throw new Error("Failed to parse search queries from Gemini response");
  }
}

// --- Classification ---

const CLASSIFICATION_PROMPT = `You are helping find a stolen bicycle. Compare this Marktplaats listing against the owner's description of their stolen bike.

STOLEN BIKE DESCRIPTION:
{description}

LISTING TITLE: {title}
LISTING DESCRIPTION: {listingDescription}
LISTING PRICE: {price}
LISTING LOCATION: {location}

Does this listing POTENTIALLY match the stolen bike? Consider:
- Bike type (city/race/mountain/electric/etc.)
- Color
- Brand and model
- Any distinguishing features

Be INCLUSIVE — it is much better to flag a non-match than to miss the actual stolen bike. When in doubt, flag it.

Respond with JSON: {"match": true/false, "confidence": 0.0-1.0, "reason": "brief explanation"}`;

export async function classifyListing(
  apiKey: string,
  description: string,
  photos: string[] | undefined,
  listing: MarktplaatsListing
): Promise<ClassificationResult> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: "application/json" },
  });

  const prompt = CLASSIFICATION_PROMPT
    .replace("{description}", description)
    .replace("{title}", listing.title)
    .replace("{listingDescription}", listing.description)
    .replace("{price}", listing.price)
    .replace("{location}", listing.location);

  const parts: Part[] = [{ text: prompt }];

  // Add user's reference photos
  if (photos?.length) {
    for (const photo of photos) {
      const parsed = parseDataUrl(photo);
      if (parsed) {
        parts.push({ inlineData: parsed });
      }
    }
  }

  // Fetch and add the listing's first image
  if (listing.imageUrls.length > 0) {
    try {
      const imgRes = await fetch(listing.imageUrls[0]);
      if (imgRes.ok) {
        const buffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
        parts.push({ inlineData: { mimeType, data: base64 } });
      }
    } catch {
      // Classify based on text only if image fetch fails
    }
  }

  const result = await model.generateContent(parts);
  const text = result.response.text();
  try {
    return JSON.parse(text) as ClassificationResult;
  } catch {
    return { match: false, confidence: 0, reason: "Failed to parse response" };
  }
}

// --- Helpers ---

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}
