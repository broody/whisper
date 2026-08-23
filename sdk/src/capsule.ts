import { ec } from "starknet";

import { felt, positiveFelt, u128, u64, type FeltLike } from "./bid-action.ts";
import { computeRefundCommitment, computeRevealCommitment } from "./hashes.ts";

export const WHISPER_CAPSULE_ALGORITHM = "stark-ecdh-hkdf-sha256-aes-256-gcm";
export const WHISPER_CAPSULE_VERSION = 1;

export interface WhisperCapsuleContext {
  chainId: FeltLike;
  poolAddress: FeltLike;
  whisperAddress: FeltLike;
  auctionId: FeltLike;
  revealCommitment: FeltLike;
}

export interface WhisperBidOpening {
  auctionId: FeltLike;
  amount: FeltLike;
  salt: FeltLike;
  refundRecipient: FeltLike;
  refundCommitment: FeltLike;
  winnerCommitment: FeltLike;
}

export interface WhisperEncryptedCapsule {
  version: 1;
  algorithm: typeof WHISPER_CAPSULE_ALGORITHM;
  auctionId: string;
  revealCommitment: string;
  ephemeralPublicKey: string;
  hkdfSalt: string;
  nonce: string;
  ciphertext: string;
}

interface SerializedBidOpening {
  auctionId: string;
  amount: string;
  salt: string;
  refundRecipient: string;
  refundCommitment: string;
  winnerCommitment: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder(undefined, { fatal: true });

function normalizedHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function bytesToHex(value: Uint8Array): string {
  let result = "0x";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function hexToBytes(name: string, value: string, expectedLength?: number): Uint8Array {
  if (!/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new TypeError(`${name} must be an even-length 0x-prefixed hex string`);
  }
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new RangeError(`${name} must contain ${expectedLength} bytes`);
  }
  return bytes;
}

function scalarBytes(name: string, value: FeltLike): Uint8Array {
  const scalar = positiveFelt(name, value);
  return hexToBytes(name, `0x${scalar.toString(16).padStart(64, "0")}`, 32);
}

function publicPointFromX(name: string, value: FeltLike): Uint8Array {
  const x = positiveFelt(name, value);
  const xBytes = hexToBytes(name, `0x${x.toString(16).padStart(64, "0")}`, 32);
  return Uint8Array.from([2, ...xBytes]);
}

function publicX(publicKey: Uint8Array): bigint {
  return BigInt(bytesToHex(publicKey.slice(1)));
}

function capsuleContext(context: WhisperCapsuleContext): {
  auctionId: bigint;
  revealCommitment: bigint;
  additionalData: Uint8Array;
} {
  const chainId = positiveFelt("context.chainId", context.chainId);
  const poolAddress = positiveFelt("context.poolAddress", context.poolAddress);
  const whisperAddress = positiveFelt("context.whisperAddress", context.whisperAddress);
  const auctionId = u64("context.auctionId", context.auctionId);
  const revealCommitment = positiveFelt("context.revealCommitment", context.revealCommitment);
  return {
    auctionId,
    revealCommitment,
    additionalData: textEncoder.encode(
      [
        "WHISPER_CAPSULE_V1",
        normalizedHex(chainId),
        normalizedHex(poolAddress),
        normalizedHex(whisperAddress),
        normalizedHex(auctionId),
        normalizedHex(revealCommitment),
      ].join("|"),
    ),
  };
}

async function deriveCapsuleKey(
  privateKey: Uint8Array,
  peerPublicKey: Uint8Array,
  salt: Uint8Array,
  additionalData: Uint8Array,
): Promise<CryptoKey> {
  const sharedPoint = ec.starkCurve.getSharedSecret(privateKey, peerPublicKey);
  const sharedX = sharedPoint.slice(1);
  const material = await globalThis.crypto.subtle.importKey(
    "raw",
    asArrayBuffer(sharedX),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: asArrayBuffer(salt),
      info: asArrayBuffer(additionalData),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function serializeOpening(input: WhisperBidOpening): SerializedBidOpening {
  const auctionId = u64("opening.auctionId", input.auctionId);
  const amount = u128("opening.amount", input.amount);
  const salt = felt("opening.salt", input.salt);
  const refundRecipient = positiveFelt("opening.refundRecipient", input.refundRecipient);
  const refundCommitment = positiveFelt("opening.refundCommitment", input.refundCommitment);
  const winnerCommitment = positiveFelt("opening.winnerCommitment", input.winnerCommitment);
  if (computeRefundCommitment(refundRecipient) !== refundCommitment) {
    throw new Error("opening.refundCommitment does not match refundRecipient");
  }
  return {
    auctionId: auctionId.toString(),
    amount: amount.toString(),
    salt: salt.toString(),
    refundRecipient: refundRecipient.toString(),
    refundCommitment: refundCommitment.toString(),
    winnerCommitment: winnerCommitment.toString(),
  };
}

function deserializeOpening(value: unknown): SerializedBidOpening {
  if (typeof value !== "object" || value === null) throw new TypeError("invalid capsule plaintext");
  const candidate = value as Record<string, unknown>;
  for (const key of [
    "auctionId",
    "amount",
    "salt",
    "refundRecipient",
    "refundCommitment",
    "winnerCommitment",
  ]) {
    if (typeof candidate[key] !== "string" || !/^[0-9]+$/.test(candidate[key])) {
      throw new TypeError(`invalid capsule plaintext field: ${key}`);
    }
  }
  return candidate as unknown as SerializedBidOpening;
}

function validateOpening(
  serialized: SerializedBidOpening,
  expectedAuctionId: bigint,
  expectedRevealCommitment: bigint,
): WhisperBidOpening {
  const opening = {
    auctionId: u64("opening.auctionId", serialized.auctionId),
    amount: u128("opening.amount", serialized.amount),
    salt: felt("opening.salt", serialized.salt),
    refundRecipient: positiveFelt("opening.refundRecipient", serialized.refundRecipient),
    refundCommitment: positiveFelt("opening.refundCommitment", serialized.refundCommitment),
    winnerCommitment: positiveFelt("opening.winnerCommitment", serialized.winnerCommitment),
  };
  if (opening.auctionId !== expectedAuctionId) throw new Error("capsule auctionId mismatch");
  if (computeRefundCommitment(opening.refundRecipient) !== opening.refundCommitment) {
    throw new Error("capsule refund commitment mismatch");
  }
  const computed = computeRevealCommitment(
    opening.auctionId,
    opening.amount,
    opening.salt,
    opening.refundCommitment,
    opening.winnerCommitment,
  );
  if (computed !== expectedRevealCommitment) throw new Error("capsule reveal commitment mismatch");
  return opening;
}

/** Return the felt-sized Stark-curve public key published in `AuctionConfig`. */
export function deriveWhisperRevealPublicKey(privateKey: FeltLike): bigint {
  return publicX(ec.starkCurve.getPublicKey(scalarBytes("privateKey", privateKey), true));
}

/** Encrypt the application-layer bid opening without exposing any viewing key to the dapp. */
export async function encryptWhisperBidCapsule(
  openingInput: WhisperBidOpening,
  revealPublicKey: FeltLike,
  contextInput: WhisperCapsuleContext,
): Promise<WhisperEncryptedCapsule> {
  const context = capsuleContext(contextInput);
  const serialized = serializeOpening(openingInput);
  const opening = validateOpening(serialized, context.auctionId, context.revealCommitment);
  if (BigInt(opening.auctionId) !== context.auctionId) throw new Error("capsule auctionId mismatch");

  const ephemeralPrivateKey = ec.starkCurve.utils.randomPrivateKey();
  const ephemeralPublicKey = ec.starkCurve.getPublicKey(ephemeralPrivateKey, true);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveCapsuleKey(
    ephemeralPrivateKey,
    publicPointFromX("revealPublicKey", revealPublicKey),
    salt,
    context.additionalData,
  );
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(nonce),
      additionalData: asArrayBuffer(context.additionalData),
      tagLength: 128,
    },
    key,
    asArrayBuffer(textEncoder.encode(JSON.stringify(serialized))),
  );
  return {
    version: WHISPER_CAPSULE_VERSION,
    algorithm: WHISPER_CAPSULE_ALGORITHM,
    auctionId: normalizedHex(context.auctionId),
    revealCommitment: normalizedHex(context.revealCommitment),
    ephemeralPublicKey: normalizedHex(publicX(ephemeralPublicKey)),
    hkdfSalt: bytesToHex(salt),
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(new Uint8Array(ciphertext)),
  };
}

/** Decrypt and authenticate a capsule using the operator's separate reveal key. */
export async function decryptWhisperBidCapsule(
  envelope: WhisperEncryptedCapsule,
  revealPrivateKey: FeltLike,
  contextInput: WhisperCapsuleContext,
): Promise<WhisperBidOpening> {
  if (
    envelope.version !== WHISPER_CAPSULE_VERSION ||
    envelope.algorithm !== WHISPER_CAPSULE_ALGORITHM
  ) {
    throw new Error("unsupported Whisper capsule format");
  }
  const context = capsuleContext(contextInput);
  if (BigInt(envelope.auctionId) !== context.auctionId) throw new Error("capsule auctionId mismatch");
  if (BigInt(envelope.revealCommitment) !== context.revealCommitment) {
    throw new Error("capsule reveal commitment mismatch");
  }
  const key = await deriveCapsuleKey(
    scalarBytes("revealPrivateKey", revealPrivateKey),
    publicPointFromX("ephemeralPublicKey", envelope.ephemeralPublicKey),
    hexToBytes("hkdfSalt", envelope.hkdfSalt, 32),
    context.additionalData,
  );
  const plaintext = await globalThis.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(hexToBytes("nonce", envelope.nonce, 12)),
      additionalData: asArrayBuffer(context.additionalData),
      tagLength: 128,
    },
    key,
    asArrayBuffer(hexToBytes("ciphertext", envelope.ciphertext)),
  );
  return validateOpening(
    deserializeOpening(JSON.parse(textDecoder.decode(plaintext)) as unknown),
    context.auctionId,
    context.revealCommitment,
  );
}
