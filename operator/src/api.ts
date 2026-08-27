import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import {
  WHISPER_CAPSULE_ALGORITHM,
  WHISPER_CAPSULE_VERSION,
  type WhisperEncryptedCapsule,
} from "@whisper-trade/sdk";

import type { OperatorStore } from "./store.ts";
import type { AuctionCoordinator, CreateAuctionRequest } from "./auction-coordinator.ts";

const DEFAULT_BODY_LIMIT = 64 * 1_024;

export interface OperatorPublicConfig {
  chainId: bigint;
  poolAddress: bigint;
  whisperAddress: bigint;
  vaultAddress: bigint;
  vaultPublicKey: bigint;
  revealPublicKey: bigint;
}

export interface OperatorApiOptions {
  store: OperatorStore;
  publicConfig: OperatorPublicConfig;
  readiness?: () => Promise<void>;
  allowedOrigins?: readonly string[];
  bodyLimitBytes?: number;
  coordinator?: AuctionCoordinator;
  coordinatorToken?: string;
}

export function createOperatorApi(options: OperatorApiOptions): Server {
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  return createServer(async (request, response) => {
    try {
      if (applyCors(request, response, allowedOrigins)) return;
      const url = new URL(request.url ?? "/", "http://operator.invalid");
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        try {
          await options.readiness?.();
          sendJson(response, 200, { status: "ready" });
        } catch {
          sendJson(response, 503, { status: "not_ready" });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/config") {
        sendJson(response, 200, serializePublicConfig(options.publicConfig));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/capsules") {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          sendJson(response, 415, { error: "content type must be application/json" });
          return;
        }
        const envelope = parseCapsule(await readJson(request, bodyLimit));
        const result = await options.store.putCapsule(envelope);
        if (result === "conflict") {
          sendJson(response, 409, { error: "reveal commitment already has a different capsule" });
          return;
        }
        sendJson(response, result === "created" ? 201 : 200, {
          status: result,
          revealCommitment: envelope.revealCommitment,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/coordinator/auctions") {
        if (options.coordinator === undefined || options.coordinatorToken === undefined) {
          sendJson(response, 404, { error: "not found" });
          return;
        }
        if (!authorized(request, options.coordinatorToken)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          sendJson(response, 415, { error: "content type must be application/json" });
          return;
        }
        const result = await options.coordinator.create(
          parseCreateAuctionRequest(await readJson(request, bodyLimit)),
        );
        if (result === "pending") {
          sendJson(response, 409, { error: "auction creation is already pending" });
          return;
        }
        sendJson(response, 201, {
          requestId: result.requestId,
          auctionId: hex(result.auctionId),
          transactionHash: result.transactionHash,
          creator: hex(result.creator),
        });
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      sendJson(response, status, {
        error: status === 500 ? "internal operator error" : (error as Error).message,
      });
    }
  });
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function parseCreateAuctionRequest(value: unknown): CreateAuctionRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestError(400, "auction request must be an object");
  }
  const candidate = value as Record<string, unknown>;
  return {
    requestId: requiredString(candidate, "requestId"),
    paymentToken: requiredBigInt(candidate, "paymentToken"),
    metadataHash: requiredBigInt(candidate, "metadataHash"),
    winnerPayloadDomain: requiredBigInt(candidate, "winnerPayloadDomain"),
    reservePrice: requiredBigInt(candidate, "reservePrice"),
    maxBids: requiredInteger(candidate, "maxBids"),
    biddingDuration: requiredInteger(candidate, "biddingDuration"),
    acceptanceDuration: requiredInteger(candidate, "acceptanceDuration"),
    settlementDuration: requiredInteger(candidate, "settlementDuration"),
  };
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new RequestError(400, `${key} must be a non-empty string`);
  }
  return field;
}

function requiredBigInt(value: Record<string, unknown>, key: string): bigint {
  const field = value[key];
  if (typeof field !== "string" && typeof field !== "number") {
    throw new RequestError(400, `${key} must be bigint-compatible`);
  }
  try {
    return BigInt(field);
  } catch {
    throw new RequestError(400, `${key} must be bigint-compatible`);
  }
}

function requiredInteger(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field)) {
    throw new RequestError(400, `${key} must be an integer`);
  }
  return field;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    length += bytes.length;
    if (length > limit) throw new RequestError(413, "request body is too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestError(400, "request body is not valid JSON");
  }
}

function parseCapsule(value: unknown): WhisperEncryptedCapsule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestError(400, "capsule must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== WHISPER_CAPSULE_VERSION ||
    candidate.algorithm !== WHISPER_CAPSULE_ALGORITHM
  ) {
    throw new RequestError(400, "unsupported capsule format");
  }
  for (const key of [
    "auctionId",
    "revealCommitment",
    "ephemeralPublicKey",
    "hkdfSalt",
    "nonce",
    "ciphertext",
  ]) {
    const field = candidate[key];
    if (typeof field !== "string" || !/^0x[0-9a-fA-F]+$/.test(field)) {
      throw new RequestError(400, `${key} must be 0x-prefixed hex`);
    }
  }
  try {
    if (BigInt(candidate.auctionId as string) <= 0n) throw new Error();
    if (BigInt(candidate.revealCommitment as string) <= 0n) throw new Error();
  } catch {
    throw new RequestError(400, "capsule identifiers must be positive felts");
  }
  return candidate as unknown as WhisperEncryptedCapsule;
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (request.method === "OPTIONS") {
    response.writeHead(origin !== undefined && allowedOrigins.has(origin) ? 204 : 403);
    response.end();
    return true;
  }
  return false;
}

function serializePublicConfig(config: OperatorPublicConfig): Record<string, string> {
  return {
    chainId: hex(config.chainId),
    poolAddress: hex(config.poolAddress),
    whisperAddress: hex(config.whisperAddress),
    vaultAddress: hex(config.vaultAddress),
    vaultPublicKey: hex(config.vaultPublicKey),
    revealPublicKey: hex(config.revealPublicKey),
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(encoded);
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}
