import { Buffer } from "node:buffer";
import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";

let appPromise: Promise<FastifyInstance> | null = null;

function getApp(runtimeEnv?: Record<string, unknown>): Promise<FastifyInstance> {
  if (!appPromise) {
    const config = loadConfig(runtimeEnv);
    appPromise = buildApp(config);
  }

  return appPromise;
}

function toInjectHeaders(headers: Headers): NonNullable<InjectOptions["headers"]> {
  const mapped: Record<string, string> = {};
  headers.forEach((value, key) => {
    mapped[key] = value;
  });
  return mapped;
}

function toResponseHeaders(headers: OutgoingHttpHeaders): Headers {
  const responseHeaders = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "undefined") {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        responseHeaders.append(name, item);
      }
      continue;
    }

    responseHeaders.set(name, String(value));
  }

  return responseHeaders;
}

async function toPayload(request: Request): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const bodyBuffer = Buffer.from(await request.arrayBuffer());
  return bodyBuffer.length > 0 ? bodyBuffer : undefined;
}

function toInjectMethod(method: string): NonNullable<InjectOptions["method"]> {
  const normalized = method.toUpperCase();
  switch (normalized) {
    case "DELETE":
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "PATCH":
    case "POST":
    case "PUT":
      return normalized;
    default:
      return "GET";
  }
}

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const app = await getApp(env);
    const url = new URL(request.url);
    const injectOptions: InjectOptions = {
      method: toInjectMethod(request.method),
      url: `${url.pathname}${url.search}`,
      headers: toInjectHeaders(request.headers)
    };
    const payload = await toPayload(request);
    if (payload) {
      injectOptions.payload = payload;
    }

    const injectResponse = await app.inject(injectOptions);

    return new Response(injectResponse.payload, {
      status: injectResponse.statusCode,
      headers: toResponseHeaders(injectResponse.headers)
    });
  }
};
