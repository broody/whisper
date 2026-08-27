import { ec, hash, shortString, type Account, type ProviderInterface } from "starknet";

import {
  WHISPER_OFFCHAIN_FULFILLMENT,
  WhisperAuctionScheduleKind,
  computeOperatorIdentityCommitment,
  computeProceedsRecipientCommitment,
  encodeWhisperAuctionFulfillment,
  encodeWhisperAuctionSchedule,
} from "@whisper-trade/sdk";

import type { OperatorStore } from "./store.ts";

const IDENTITY_KEY_DOMAIN = BigInt(shortString.encodeShortString("IDENTITY_KEY_TAG:V1"));
const AUCTION_CREATED_SELECTOR = BigInt(hash.getSelectorFromName("AuctionCreated"));
const MAX_U128 = (1n << 128n) - 1n;
const MAX_BIDS = 256;

export interface CreateAuctionRequest {
  requestId: string;
  paymentToken: bigint;
  metadataHash: bigint;
  winnerPayloadDomain: bigint;
  reservePrice: bigint;
  maxBids: number;
  biddingDuration: number;
  acceptanceDuration: number;
  settlementDuration: number;
}

export interface CreateAuctionResult {
  requestId: string;
  auctionId: bigint;
  transactionHash: string;
  creator: bigint;
}

export interface AuctionCoordinatorOptions {
  provider: ProviderInterface;
  relayerAccount: Account;
  store: OperatorStore;
  whisperAddress: bigint;
  vaultAddress: bigint;
  vaultPublicKey: bigint;
  revealPublicKey: bigint;
  proceedsRecipient: bigint;
  getViewingKey: () => Promise<bigint>;
}

/** Creates fixed-shape Stake Wars auctions without exposing operator key material. */
export class AuctionCoordinator {
  constructor(private readonly options: AuctionCoordinatorOptions) {}

  async create(request: CreateAuctionRequest): Promise<CreateAuctionResult | "pending"> {
    validateRequest(request);
    const existing = await this.options.store.getAuctionCreation(request.requestId);
    if (existing?.status === "completed") {
      return {
        requestId: existing.requestId,
        auctionId: existing.auctionId!,
        transactionHash: existing.transactionHash!,
        creator: BigInt(this.options.relayerAccount.address),
      };
    }
    if (existing?.status === "pending") return "pending";
    if (!(await this.options.store.claimAuctionCreation(request.requestId))) return "pending";

    try {
      const viewingKey = await this.options.getViewingKey();
      const identityKey = ec.starkCurve.poseidonHashMany([
        IDENTITY_KEY_DOMAIN,
        this.options.vaultAddress,
        viewingKey,
        this.options.whisperAddress,
      ]);
      const calldata = [
        request.paymentToken,
        computeProceedsRecipientCommitment(this.options.proceedsRecipient),
        request.metadataHash,
        ...encodeWhisperAuctionFulfillment(WHISPER_OFFCHAIN_FULFILLMENT),
        request.winnerPayloadDomain,
        request.reservePrice,
        BigInt(request.maxBids),
        ...encodeWhisperAuctionSchedule({
          kind: WhisperAuctionScheduleKind.StartOnBid,
          biddingDuration: BigInt(request.biddingDuration),
          acceptanceDuration: BigInt(request.acceptanceDuration),
          settlementDuration: BigInt(request.settlementDuration),
        }),
        this.options.vaultAddress,
        this.options.vaultPublicKey,
        this.options.revealPublicKey,
        computeOperatorIdentityCommitment(identityKey),
      ].map(hex);
      const response = await this.options.relayerAccount.execute({
        contractAddress: hex(this.options.whisperAddress),
        entrypoint: "create_auction",
        calldata,
      });
      const receipt = await this.options.provider.waitForTransaction(response.transaction_hash);
      if (!receipt.isSuccess()) throw new Error("auction creation transaction reverted");
      const auctionId = createdAuctionId(receipt, this.options.whisperAddress);
      await this.options.store.completeAuctionCreation(
        request.requestId,
        auctionId,
        response.transaction_hash,
      );
      await this.options.store.trackAuction(auctionId);
      return {
        requestId: request.requestId,
        auctionId,
        transactionHash: response.transaction_hash,
        creator: BigInt(this.options.relayerAccount.address),
      };
    } catch (error) {
      await this.options.store.failAuctionCreation(
        request.requestId,
        error instanceof Error ? error.message : "auction creation failed",
      );
      throw error;
    }
  }
}

function validateRequest(request: CreateAuctionRequest): void {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(request.requestId)) {
    throw new TypeError("requestId must contain 1-128 safe identifier characters");
  }
  for (const [name, value] of [
    ["paymentToken", request.paymentToken],
    ["metadataHash", request.metadataHash],
    ["winnerPayloadDomain", request.winnerPayloadDomain],
  ] as const) {
    if (value <= 0n || value >= ec.starkCurve.CURVE.n) throw new RangeError(`${name} is not a felt`);
  }
  if (request.reservePrice < 0n || request.reservePrice > MAX_U128) {
    throw new RangeError("reservePrice exceeds u128");
  }
  if (!Number.isSafeInteger(request.maxBids) || request.maxBids < 1 || request.maxBids > MAX_BIDS) {
    throw new RangeError("maxBids must be between 1 and 256");
  }
  for (const [name, value] of [
    ["biddingDuration", request.biddingDuration],
    ["acceptanceDuration", request.acceptanceDuration],
    ["settlementDuration", request.settlementDuration],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  }
}

function createdAuctionId(receipt: unknown, whisperAddress: bigint): bigint {
  const events = (receipt as { events?: Array<{ from_address?: string; keys?: string[] }> }).events;
  for (const event of events ?? []) {
    if (
      event.from_address !== undefined &&
      BigInt(event.from_address) === whisperAddress &&
      event.keys !== undefined &&
      event.keys.length >= 2 &&
      BigInt(event.keys[0]!) === AUCTION_CREATED_SELECTOR
    ) {
      return BigInt(event.keys[1]!);
    }
  }
  throw new Error("auction creation receipt is missing AuctionCreated");
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}
