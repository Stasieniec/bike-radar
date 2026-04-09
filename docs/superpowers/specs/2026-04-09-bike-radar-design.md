# Bike Radar — Design Spec

A Next.js app on Cloudflare Workers that helps users find their stolen bikes on Marktplaats by scraping listings and using Gemini 2.5 Flash to classify potential matches.

## Problem

Bikes get stolen in the Netherlands constantly. Thieves often resell them on Marktplaats within days. Manually searching is tedious — you need to try many different search terms, check hundreds of listings, and visually compare each one. This app automates that entire process.

## Architecture

Single Cloudflare Workers app (unbound). One Next.js page, two API routes, no database, no auth. Users bring their own Gemini API key.

```
Client (browser)
  │
  ├─ POST /api/validate-key   → validates Gemini API key
  │
  └─ POST /api/search (SSE)   → streams the full pipeline:
       ├─ Step 1: Query generation (Gemini)
       ├─ Step 2: Marktplaats scraping
       ├─ Step 3: Listing classification (Gemini + vision)
       └─ Step 4: Done
```

### Tech Stack

- Next.js 15 (App Router)
- `@cloudflare/next-on-pages` for Cloudflare Workers deployment
- Tailwind CSS
- `@google/generative-ai` SDK for Gemini 2.5 Flash
- No database, no auth, no external services beyond Gemini + Marktplaats

## User Interface

Single-page app with an input form and a results area.

### Input Form

- **Gemini API Key**: Text field with lock icon. Witty note below: "We're not a charity — bring your own key. Get one free at ai.google.dev". Validates on blur via `/api/validate-key`. Green checkmark if valid, red highlight + error if invalid. Persisted in `localStorage`.
- **Postcode**: Text field, validated for Dutch format (4 digits + 2 letters, e.g., "1012AB").
- **Search Radius**: Dropdown, default 50km. Options: 3, 5, 10, 15, 25, 50, 75 km.
- **Bike Description**: Large textarea. Placeholder: "Describe your bike — color, brand, type, any distinguishing features. E.g.: Red Giant Escape 3, men's city bike, black saddle, scratched left pedal".
- **Photos**: Optional drag-and-drop / file picker, max 3 images. Thumbnails shown after upload.
- **Search button**: Disabled until API key is validated and description is non-empty.

### Results Area

- **Progress line**: Shows current phase and counts.
  - "Generating search queries..."
  - "Searching Marktplaats (query 3/7)..."
  - "Analyzing listing 34/147..."
  - "Done! Found 8 potential matches"
- **Match cards**: Stream in as they're found. Each card shows: thumbnail, title, price, location, distance, Marktplaats link, and Gemini's reason for flagging it.
- **Toggle**: "Show all 147 listings" to see non-matches too.

## Backend Pipeline

Single API route: `POST /api/search` returning `text/event-stream`.

### Step 1: Query Generation

- Input: user's bike description + photos
- Send to Gemini 2.5 Flash with a prompt asking for 8-15 Dutch Marktplaats search queries
- Queries range from specific ("Giant Escape 3 rood") to vague ("herenfiets rood", "fiets ophalen")
- Output: JSON array of `{ query: string, specificity: "specific" | "medium" | "vague" }`
- SSE: `{ phase: "queries", queries: [...] }`

### Step 2: Marktplaats Scraping

- Endpoint: `https://www.marktplaats.nl/lrp/api/search`
- Parameters: `l1CategoryId=445`, `query`, `postcode`, `distanceMeters`, `limit=30`, `offset`
- No l2 category filter (cast a wide net across all bike subcategories)
- Up to 3 pages (90 listings) per query
- ~1 second delay between requests
- Deduplicate by `itemId` across all queries
- Cap at ~500 unique listings per search
- Collect per listing: `itemId`, `title`, `description`, `priceInfo`, `imageUrls`, `location`, listing URL
- SSE: `{ phase: "scraping", query: "...", found: 23, total: 87, queryIndex: 3, queryCount: 7 }`

### Step 3: Classification

- Send each listing to Gemini 2.5 Flash with:
  - System prompt containing the user's bike description
  - User's uploaded photos (if any)
  - Listing's first image (fetched from Marktplaats CDN)
  - Listing title + description text
- Prompt asks: does this listing potentially match the stolen bike? Consider color, type, brand, distinguishing features.
- Structured JSON output: `{ match: boolean, confidence: number (0-1), reason: string }`
- Parallel batches of 10 concurrent requests
- SSE progress: `{ phase: "classifying", current: 34, total: 147, matchesFound: 3 }`
- SSE on match: `{ phase: "match", listing: { title, price, image, url, location, distance, reason, confidence } }`

### Step 4: Done

- SSE: `{ phase: "done", totalScraped: 147, totalMatches: 8 }`

## API Routes

### POST /api/validate-key

- Body: `{ apiKey: string }`
- Makes a minimal Gemini API call (list models)
- Returns: `{ valid: boolean, error?: string }`

### POST /api/search

- Body: `{ apiKey: string, postcode: string, radiusKm: number, description: string, photos?: base64[] }`
- Returns: `text/event-stream` with SSE events as described above

## API Key Handling

- Sent from client in request body per search — never stored server-side
- Validated via `/api/validate-key` before search is allowed
- Persisted in `localStorage` on the client

## Marktplaats API Details

- Search endpoint: `https://www.marktplaats.nl/lrp/api/search`
- No authentication or cookies required
- Image CDN: `https://cdn.marktplaats.com/api/v1/listing-mp-p/images/{uuid}?rule=ecg_mp_eps$_82.jpg` (CORS enabled)
- Listing URL: extracted from the API response per listing (URL slug varies by subcategory)
- Distance options (meters): 3000, 5000, 10000, 15000, 25000, 50000, 75000

## Error Handling

- Marktplaats query fails: skip it, continue with remaining queries
- Gemini classification fails for a listing: skip it, mark as "could not analyze"
- Gemini quota exhausted mid-search: stop, show results so far with a message explaining why
- Invalid postcode: client-side validation prevents submission
- Network errors: SSE error event, client shows retry option

## Project Structure

```
src/
  app/
    page.tsx                  — main UI (single page)
    layout.tsx                — root layout
    globals.css               — Tailwind imports
    api/
      search/route.ts         — SSE pipeline endpoint
      validate-key/route.ts   — API key validation
  lib/
    gemini.ts                 — Gemini API client (query gen + classification)
    marktplaats.ts            — Marktplaats search/scraping
    types.ts                  — shared TypeScript types
```

## Deployment

- Cloudflare Workers via `@cloudflare/next-on-pages`
- Unbound worker (30s CPU, 15min wall clock)
- `wrangler.toml` with `compatibility_flags = ["nodejs_compat"]`
- No KV, D1, R2, or Durable Objects needed

## Cost

- Zero hosting cost (Cloudflare Workers free tier: 100k requests/day)
- Gemini cost borne by user via their own API key
- Estimated ~$0.05 per search (500 listings worst case)
