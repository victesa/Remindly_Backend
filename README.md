# Remindly Backend

Remindly Backend is a Fastify + TypeScript API that ingests uploaded media or text payloads, builds structured reminder items with Gemini, stores item records in Firestore, and stores media in Cloudflare R2.

## What It Does

- Receives payloads containing `itemId`, `contentType`, optional uploaded media, optional `extractedText`, and metadata.
- Evaluates OCR quality against the image.
- If OCR is sufficient:
  - Extracts structured fields locally.
  - Uses Gemini to generate summary and may infer `state` (`NEW`, `IN_PROGRESS`, `COMPLETED`, `ARCHIVED`).
- If OCR is insufficient:
  - Uses Gemini vision extraction to return full JSON item details.
  - Starts with basic model and escalates to advanced model only when extraction fails.
- Supports text-only extraction path when image is unavailable.
- Enforces strict timezone fallback when timezone is missing or invalid.
- Uses idempotency key (derived from uid + item payload identity) to make retries safe.
- Stores audit fields per item for source and extraction traceability.
- Saves item under `users/{uid}/items/{itemId}` in Firestore.
- Returns saved item and extraction metadata in API response.
- Enforces Firebase Authentication (Bearer ID token) for write operations.

## Tech Stack

- Node.js
- TypeScript
- Fastify
- Firebase Admin SDK (Auth + Firestore)
- Gemini via Google Generative Language REST API
- Zod validation
- Vitest tests

## Requirements

- Node.js 18+
- Firebase service account JSON
- Gemini API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy environment file:

```bash
cp .env.example .env
```

3. Set required variables in `.env`:

- `GEMINI_API_KEY`
- `FIREBASE_PROJECT_ID`
- `DEFAULT_TIMEZONE`
- `FIREBASE_SERVICE_ACCOUNT_JSON` (JSON stringified in one line)

Media upload variables (required when sending media):

- `CLOUDFLARE_R2_ENDPOINT`
- `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_R2_BUCKET`
- `CLOUDFLARE_R2_SIGNED_URL_TTL_SECONDS` (optional, default `900`)

Example PowerShell for service account JSON:

```powershell
$svc = Get-Content .\service-account.json -Raw
$svcEscaped = $svc -replace "`r`n", "" -replace "`n", ""
```

## Run

```bash
npm run dev
```

Server defaults to `http://localhost:8080`.

## API

- `GET /health`
- `POST /v1/items/ingest` (requires `Authorization: Bearer <firebase_id_token>`)

Swagger UI:

- `GET /docs`

Static API artifacts:

- `docs/openapi.yaml`
- `docs/postman_collection.json`

## Request Example

`application/json` text-only request:

```json
{
  "itemId": "local-generated-uuid",
  "contentType": "TEXT",
  "extractedText": "Google Internship Applications are now open. Deadline: 31 August...",
  "capturedAt": "2026-07-28T10:30:00Z",
  "metadata": {
    "source": "mobile",
    "locale": "en-US",
    "timezone": "Africa/Nairobi"
  }
}
```

`multipart/form-data` media request fields:

- `itemId` = `local-generated-uuid`
- `contentType` = `IMAGE`
- `media` = (binary file)
- `extractedText` = optional OCR text
- `capturedAt` = optional ISO date-time
- `metadata` = JSON string, e.g. `{"source":"mobile","timezone":"Africa/Nairobi"}`

## Response Example

```json
{
  "item": {
    "id": "abc123",
    "title": "Scholarship Application",
    "summary": "Apply before the deadline and submit required documents.",
    "category": "SCHOLARSHIP",
    "deadline": "2026-09-10T00:00:00.000Z",
    "eventDate": null,
    "state": "NEW",
    "metadata": {
      "institution": "Example University",
      "applicationLink": "https://example.edu/apply"
    },
    "audit": {
      "idempotencyKey": "9f0b...",
      "source": {
        "itemId": "local-generated-uuid",
        "contentType": "IMAGE",
        "storagePath": "uploads/uid/local-generated-uuid/3e9f....jpg",
        "imageUrl": "https://<signed-r2-url>",
        "mimeType": "image/jpeg",
        "capturedAt": "2026-07-28T10:30:00.000Z",
        "receivedAt": "2026-07-28T10:30:01.000Z",
        "extractedTextProvided": true
      },
      "extraction": {
        "strategy": "VISION_FULL_EXTRACTION",
        "confidence": 0.82,
        "ocrQualityScore": 0.33,
        "effectiveTimezone": "Africa/Nairobi",
        "model": "gemini-2.5-flash",
        "usedAdvancedModel": false
      }
    },
    "createdAt": "2026-07-28T10:00:00.000Z",
    "updatedAt": "2026-07-28T10:00:00.000Z"
  },
  "extraction": {
    "strategy": "VISION_FULL_EXTRACTION",
    "confidence": 0.82,
    "ocrQualityScore": 0.33
  }
}
```

## Testing

```bash
npm test
```

Included:

- Unit tests for text extraction and metadata sanitization.
- Integration test for authenticated ingest route behavior.

## Notes

- Ambiguous dates are allowed as `null`; Gemini may resolve when context is sufficient.
- Unknown metadata is never invented; only category-allowed keys are persisted.
- For uncategorized content, category is `OTHER` and extras are stored under `metadata.custom`.
- Repeated ingest calls with the same payload identity are idempotent.
