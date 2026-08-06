import { Buffer } from "node:buffer";
import type { AppConfig } from "../config/env.js";
import { itemSchema, type Item } from "../domain/item.js";
import type { ItemRepository, SaveItemInput } from "../ports/item-repository.js";

type FirestoreValue = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number | string;
  booleanValue?: boolean;
  nullValue?: null;
  mapValue?: { fields?: Record<string, FirestoreValue> };
  arrayValue?: { values?: FirestoreValue[] };
};

type FirestoreDocument = {
  name?: string;
  fields?: Record<string, FirestoreValue>;
};

type ServiceAccountCredentials = {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
};

function parseServiceAccount(raw: string): ServiceAccountCredentials {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const clientEmail = parsed.client_email;
  const privateKeyRaw = parsed.private_key;
  const tokenUriRaw = parsed.token_uri;

  if (typeof clientEmail !== "string" || !clientEmail.trim()) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing client_email");
  }
  if (typeof privateKeyRaw !== "string" || !privateKeyRaw.trim()) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing private_key");
  }
  if (typeof tokenUriRaw !== "string" || !tokenUriRaw.trim()) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing token_uri");
  }

  return {
    clientEmail,
    privateKey: privateKeyRaw.replace(/\\n/g, "\n"),
    tokenUri: tokenUriRaw
  };
}

function base64UrlEncode(input: string | ArrayBuffer): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function privateKeyPemToPkcs8(privateKeyPem: string): ArrayBuffer {
  const base64 = privateKeyPem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s+/g, "");
  const binary = Buffer.from(base64, "base64");
  return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
}

async function createServiceAccountJwt(
  credentials: ServiceAccountCredentials,
  scope: string
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is not available for Firestore token signing");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: credentials.clientEmail,
    sub: credentials.clientEmail,
    aud: credentials.tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    scope
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const key = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    privateKeyPemToPkcs8(credentials.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await globalThis.crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsignedToken)
  );

  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

function toFirestoreValue(value: unknown): FirestoreValue {
  if (value === null) {
    return { nullValue: null };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { integerValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((entry) => toFirestoreValue(entry)) } };
  }
  if (typeof value === "object") {
    const fields: Record<string, FirestoreValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      fields[key] = toFirestoreValue(entry);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(value: FirestoreValue | undefined): unknown {
  if (!value) {
    return undefined;
  }
  if (typeof value.stringValue === "string") {
    return value.stringValue;
  }
  if (typeof value.integerValue === "string") {
    return Number(value.integerValue);
  }
  if (typeof value.doubleValue === "number") {
    return value.doubleValue;
  }
  if (typeof value.doubleValue === "string") {
    return Number(value.doubleValue);
  }
  if (typeof value.booleanValue === "boolean") {
    return value.booleanValue;
  }
  if (value.nullValue === null) {
    return null;
  }
  if (value.arrayValue) {
    return (value.arrayValue.values ?? []).map((entry) => fromFirestoreValue(entry));
  }
  if (value.mapValue) {
    const mapped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value.mapValue.fields ?? {})) {
      mapped[key] = fromFirestoreValue(entry);
    }
    return mapped;
  }
  return undefined;
}

export class FirestoreItemRepository implements ItemRepository {
  private readonly projectId: string;
  private readonly credentials: ServiceAccountCredentials;
  private readonly apiBaseUrl: string;
  private cachedToken: { accessToken: string; expiresAtEpochMs: number } | null = null;

  constructor(config: AppConfig) {
    this.projectId = config.FIREBASE_PROJECT_ID;
    this.credentials = parseServiceAccount(config.FIREBASE_SERVICE_ACCOUNT_JSON);
    this.apiBaseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/databases/(default)/documents`;
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAtEpochMs - 60_000) {
      return this.cachedToken.accessToken;
    }

    const assertion = await createServiceAccountJwt(this.credentials, "https://www.googleapis.com/auth/datastore");
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    });

    const response = await fetch(this.credentials.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    if (!response.ok) {
      throw new Error(`Failed to mint Firestore access token (${response.status})`);
    }

    const data = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== "string") {
      throw new Error("Firestore token response did not include access_token");
    }

    const expiresInSeconds = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
    this.cachedToken = {
      accessToken: data.access_token,
      expiresAtEpochMs: Date.now() + expiresInSeconds * 1000
    };

    return data.access_token;
  }

  private async firestoreRequest(
    path: string,
    init?: Omit<RequestInit, "headers"> & { headers?: Record<string, string> }
  ): Promise<Response> {
    const accessToken = await this.getAccessToken();
    return fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init?.headers ?? {})
      }
    });
  }

  private async getDocument(path: string): Promise<FirestoreDocument | null> {
    const response = await this.firestoreRequest(path, { method: "GET" });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Failed to read Firestore document (${response.status})`);
    }
    return (await response.json()) as FirestoreDocument;
  }

  private async commitDocuments(
    writes: Array<{ name: string; fields: Record<string, unknown> }>
  ): Promise<void> {
    const response = await this.firestoreRequest(":commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        writes: writes.map((write) => ({
          update: {
            name: write.name,
            fields: Object.fromEntries(
              Object.entries(write.fields).map(([key, value]) => [key, toFirestoreValue(value)])
            )
          }
        }))
      })
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Failed to commit Firestore writes (${response.status}): ${details}`);
    }
  }

  async save(input: SaveItemInput): Promise<Item> {
    const now = new Date().toISOString();
    const itemPath = `/users/${encodeURIComponent(input.uid)}/items/${encodeURIComponent(input.itemId)}`;
    const debugPath = `/users/${encodeURIComponent(input.uid)}/item_debug/${encodeURIComponent(input.itemId)}`;
    const encodedUid = encodeURIComponent(input.uid);
    const encodedItemId = encodeURIComponent(input.itemId);
    const itemName = `projects/${this.projectId}/databases/(default)/documents/users/${encodedUid}/items/${encodedItemId}`;
    const debugName = `projects/${this.projectId}/databases/(default)/documents/users/${encodedUid}/item_debug/${encodedItemId}`;

    const [existingDoc, debugDoc] = await Promise.all([
      this.getDocument(itemPath),
      this.getDocument(debugPath)
    ]);

    const existing = existingDoc?.fields
      ? itemSchema.parse(fromFirestoreValue({ mapValue: { fields: existingDoc.fields } }))
      : null;
    const debugData = debugDoc?.fields
      ? (fromFirestoreValue({ mapValue: { fields: debugDoc.fields } }) as { audit?: { idempotencyKey?: string } })
      : null;

    if (existing && debugData?.audit?.idempotencyKey === input.audit.idempotencyKey) {
      return existing;
    }

    const item: Item = existing
      ? {
          ...existing,
          title: input.title,
          summary: input.summary,
          category: input.category,
          deadline: input.deadline,
          eventDate: input.eventDate,
          state: input.state,
          metadata: input.metadata,
          updatedAt: now
        }
      : {
          id: input.itemId,
          title: input.title,
          summary: input.summary,
          category: input.category,
          deadline: input.deadline,
          eventDate: input.eventDate,
          state: input.state,
          metadata: input.metadata,
          createdAt: now,
          updatedAt: now
        };

    await this.commitDocuments([
      { name: itemName, fields: item },
      {
        name: debugName,
        fields: {
          itemId: input.itemId,
          uid: input.uid,
          audit: input.audit,
          updatedAt: now
        }
      }
    ]);

    return item;
  }
}
