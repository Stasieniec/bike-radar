"use client";

import { useState, useRef, useCallback } from "react";
import { parseSSEStream } from "@/lib/sse";
import { SSEEvent, MatchedListing, MarktplaatsListing, SearchQuery } from "@/lib/types";

const RADIUS_OPTIONS = [3, 5, 10, 15, 25, 50, 75];
const POSTCODE_REGEX = /^[1-9]\d{3}\s?[A-Za-z]{2}$/;
const MAX_PHOTOS = 3;

type KeyStatus = "idle" | "validating" | "valid" | "invalid";
type SearchStatus = "idle" | "searching" | "done" | "error";

interface ProgressState {
  phase: string;
  message: string;
  current?: number;
  total?: number;
  matchesFound?: number;
}

export default function BikeRadar() {
  // Form state
  const [apiKey, setApiKey] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("gemini-api-key") || "" : ""
  );
  const [keyStatus, setKeyStatus] = useState<KeyStatus>("idle");
  const [keyError, setKeyError] = useState("");
  const [postcode, setPostcode] = useState("");
  const [radiusKm, setRadiusKm] = useState(50);
  const [description, setDescription] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);

  // Search state
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [matches, setMatches] = useState<MatchedListing[]>([]);
  const [queries, setQueries] = useState<SearchQuery[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [totalScraped, setTotalScraped] = useState(0);
  const [nonMatches, setNonMatches] = useState<MarktplaatsListing[]>([]);
  const [showAll, setShowAll] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- API Key Validation ---

  const validateKey = useCallback(async (key: string) => {
    if (!key.trim()) {
      setKeyStatus("idle");
      return;
    }
    setKeyStatus("validating");
    setKeyError("");
    try {
      const res = await fetch("/api/validate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await res.json();
      if (data.valid) {
        setKeyStatus("valid");
        localStorage.setItem("gemini-api-key", key);
      } else {
        setKeyStatus("invalid");
        setKeyError(data.error || "Invalid API key");
      }
    } catch {
      setKeyStatus("invalid");
      setKeyError("Could not validate key");
    }
  }, []);

  // --- Photo Handling ---

  const handlePhotoAdd = useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      const remaining = MAX_PHOTOS - photos.length;
      const toProcess = Array.from(files).slice(0, remaining);

      const newPhotos = await Promise.all(
        toProcess.map(
          (file) =>
            new Promise<string>((resolve) => {
              const img = new Image();
              const reader = new FileReader();
              reader.onload = (e) => {
                img.onload = () => {
                  const canvas = document.createElement("canvas");
                  const scale = Math.min(1, 768 / Math.max(img.width, img.height));
                  canvas.width = img.width * scale;
                  canvas.height = img.height * scale;
                  const ctx = canvas.getContext("2d")!;
                  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                  resolve(canvas.toDataURL("image/jpeg", 0.8));
                };
                img.src = e.target!.result as string;
              };
              reader.readAsDataURL(file);
            })
        )
      );

      setPhotos((prev) => [...prev, ...newPhotos].slice(0, MAX_PHOTOS));
    },
    [photos.length]
  );

  const removePhoto = useCallback((index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // --- Search ---

  const canSearch =
    keyStatus === "valid" &&
    description.trim().length > 0 &&
    POSTCODE_REGEX.test(postcode) &&
    searchStatus !== "searching";

  const startSearch = useCallback(async () => {
    setSearchStatus("searching");
    setMatches([]);
    setNonMatches([]);
    setShowAll(false);
    setQueries([]);
    setErrorMessage("");
    setTotalScraped(0);
    setProgress({ phase: "queries", message: "Generating search queries..." });

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          postcode: postcode.replace(/\s/g, "").toUpperCase(),
          radiusKm,
          description,
          photos: photos.length > 0 ? photos : undefined,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }

      for await (const event of parseSSEStream(res)) {
        handleSSEEvent(event);
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setSearchStatus("error");
      setErrorMessage(e instanceof Error ? e.message : "Search failed");
    }
  }, [apiKey, postcode, radiusKm, description, photos]);

  const handleSSEEvent = (event: SSEEvent) => {
    switch (event.phase) {
      case "queries":
        setQueries(event.queries);
        setProgress({
          phase: "scraping",
          message: `Searching Marktplaats (0/${event.queries.length} queries)...`,
        });
        break;

      case "scraping":
        setProgress({
          phase: "scraping",
          message: `Searching Marktplaats (${event.queryIndex}/${event.queryCount})...`,
          current: event.queryIndex,
          total: event.queryCount,
        });
        setTotalScraped(event.total);
        break;

      case "classifying":
        setProgress({
          phase: "classifying",
          message: `Analyzing listing ${event.current}/${event.total}...`,
          current: event.current,
          total: event.total,
          matchesFound: event.matchesFound,
        });
        break;

      case "match":
        setMatches((prev) => [...prev, event.listing]);
        break;

      case "non_match":
        setNonMatches((prev) => [...prev, event.listing]);
        break;

      case "done":
        setSearchStatus("done");
        setTotalScraped(event.totalScraped);
        setProgress(null);
        break;

      case "error":
        setSearchStatus("error");
        setErrorMessage(event.message);
        setProgress(null);
        break;
    }
  };

  const stopSearch = useCallback(() => {
    abortRef.current?.abort();
    setSearchStatus("done");
    setProgress(null);
  }, []);

  // --- Render ---

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-2xl px-4 py-12">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900">Bike Radar</h1>
          <p className="mt-2 text-gray-500">
            Find your stolen bike on Marktplaats
          </p>
        </div>

        {/* Form */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          {/* API Key */}
          <div className="mb-5">
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              Gemini API Key
            </label>
            <div className="relative">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setKeyStatus("idle");
                }}
                onBlur={() => validateKey(apiKey)}
                placeholder="Your Gemini API key"
                className={`w-full rounded-lg border px-3 py-2 pr-10 text-sm transition-colors focus:outline-none focus:ring-2 ${
                  keyStatus === "valid"
                    ? "border-green-300 focus:ring-green-200"
                    : keyStatus === "invalid"
                      ? "border-red-300 focus:ring-red-200"
                      : "border-gray-300 focus:ring-blue-200"
                }`}
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                {keyStatus === "validating" && (
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
                )}
                {keyStatus === "valid" && (
                  <span className="text-green-500">&#10003;</span>
                )}
                {keyStatus === "invalid" && (
                  <span className="text-red-500">&#10007;</span>
                )}
              </div>
            </div>
            {keyStatus === "invalid" && keyError && (
              <p className="mt-1 text-xs text-red-500">{keyError}</p>
            )}
            <p className="mt-1.5 text-xs text-gray-400">
              We&apos;re not a charity &mdash; bring your own key. Get one free
              at{" "}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 underline"
              >
                ai.google.dev
              </a>
            </p>
          </div>

          {/* Postcode + Radius */}
          <div className="mb-5 flex gap-4">
            <div className="flex-1">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Postcode
              </label>
              <input
                type="text"
                value={postcode}
                onChange={(e) => setPostcode(e.target.value)}
                placeholder="1012AB"
                maxLength={7}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
              {postcode && !POSTCODE_REGEX.test(postcode) && (
                <p className="mt-1 text-xs text-red-500">
                  Enter a valid Dutch postcode (e.g. 1012AB)
                </p>
              )}
            </div>
            <div className="w-36">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Radius
              </label>
              <select
                value={radiusKm}
                onChange={(e) => setRadiusKm(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
              >
                {RADIUS_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r} km
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Description */}
          <div className="mb-5">
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              Describe your bike
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe your bike — color, brand, type, any distinguishing features. E.g.: Red Giant Escape 3, men's city bike, black saddle, scratched left pedal"
              rows={4}
              className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
          </div>

          {/* Photos */}
          <div className="mb-6">
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              Photos{" "}
              <span className="font-normal text-gray-400">(optional, max 3)</span>
            </label>
            {photos.length < MAX_PHOTOS && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mb-2 w-full rounded-lg border-2 border-dashed border-gray-300 px-4 py-3 text-sm text-gray-400 transition-colors hover:border-blue-300 hover:text-blue-500"
              >
                Click to add photos
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => handlePhotoAdd(e.target.files)}
            />
            {photos.length > 0 && (
              <div className="flex gap-2">
                {photos.map((photo, i) => (
                  <div key={i} className="group relative">
                    <img
                      src={photo}
                      alt={`Bike photo ${i + 1}`}
                      className="h-20 w-20 rounded-lg border border-gray-200 object-cover"
                    />
                    <button
                      onClick={() => removePhoto(i)}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Search Button */}
          {searchStatus === "searching" ? (
            <button
              onClick={stopSearch}
              className="w-full rounded-lg bg-red-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-600"
            >
              Stop Search
            </button>
          ) : (
            <button
              onClick={startSearch}
              disabled={!canSearch}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              Search Marktplaats
            </button>
          )}
        </div>

        {/* Results */}
        {(searchStatus !== "idle" || matches.length > 0) && (
          <div className="mt-8">
            {/* Progress */}
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

            {/* Error */}
            {searchStatus === "error" && (
              <div className="mb-6 rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">
                {errorMessage || "An error occurred during search."}
              </div>
            )}

            {/* Done summary */}
            {searchStatus === "done" && (
              <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
                Scanned <strong>{totalScraped}</strong> listings. Found{" "}
                <strong>{matches.length}</strong> potential match
                {matches.length !== 1 ? "es" : ""}.
              </div>
            )}

            {/* Generated queries (collapsible) */}
            {queries.length > 0 && (
              <details className="mb-6">
                <summary className="cursor-pointer text-sm text-gray-400 hover:text-gray-600">
                  Search queries used ({queries.length})
                </summary>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {queries.map((q, i) => (
                    <span
                      key={i}
                      className={`rounded-full px-2.5 py-0.5 text-xs ${
                        q.specificity === "specific"
                          ? "bg-green-100 text-green-700"
                          : q.specificity === "medium"
                            ? "bg-yellow-100 text-yellow-700"
                            : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {q.query}
                    </span>
                  ))}
                </div>
              </details>
            )}

            {/* Match cards */}
            {matches.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-lg font-semibold text-gray-900">
                  Potential Matches
                </h2>
                {matches.map((m) => (
                  <a
                    key={m.itemId}
                    href={m.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex gap-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
                  >
                    {m.imageUrls.length > 0 ? (
                      <img
                        src={m.imageUrls[0]}
                        alt={m.title}
                        className="h-24 w-24 flex-shrink-0 rounded-lg object-cover"
                      />
                    ) : (
                      <div className="flex h-24 w-24 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-400">
                        No image
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-medium text-gray-900">
                        {m.title}
                      </h3>
                      <p className="mt-0.5 text-sm text-gray-500">
                        {m.price} &middot; {m.location}{" "}
                        {m.distance > 0 ? `\u00B7 ${m.distance} km` : ""}
                      </p>
                      <p className="mt-1.5 text-xs text-blue-600">{m.reason}</p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-200">
                          <div
                            className="h-full rounded-full bg-blue-500"
                            style={{ width: `${m.confidence * 100}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-400">
                          {Math.round(m.confidence * 100)}%
                        </span>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}

            {/* Show all listings toggle */}
            {nonMatches.length > 0 && (
              <div className="mt-4">
                <button
                  onClick={() => setShowAll((prev) => !prev)}
                  className="text-sm text-gray-400 underline hover:text-gray-600"
                >
                  {showAll
                    ? "Hide non-matching listings"
                    : `Show all ${matches.length + nonMatches.length} listings`}
                </button>
                {showAll && (
                  <div className="mt-3 space-y-3">
                    {nonMatches.map((m) => (
                      <a
                        key={m.itemId}
                        href={m.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex gap-4 rounded-xl border border-gray-100 bg-gray-50 p-4 opacity-60 transition-opacity hover:opacity-100"
                      >
                        {m.imageUrls.length > 0 ? (
                          <img
                            src={m.imageUrls[0]}
                            alt={m.title}
                            className="h-24 w-24 flex-shrink-0 rounded-lg object-cover"
                          />
                        ) : (
                          <div className="flex h-24 w-24 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-400">
                            No image
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate font-medium text-gray-500">
                            {m.title}
                          </h3>
                          <p className="mt-0.5 text-sm text-gray-400">
                            {m.price} &middot; {m.location}{" "}
                            {m.distance > 0 ? `\u00B7 ${m.distance} km` : ""}
                          </p>
                        </div>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* No matches */}
            {searchStatus === "done" && matches.length === 0 && (
              <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
                <p className="text-gray-500">
                  No potential matches found. Try a broader description or larger
                  radius.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
