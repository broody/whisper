import {
  hash,
  type EventFilter,
  type ProviderInterface,
} from "starknet";

import type {
  AuctionStatus,
  AuctionView,
  BidView,
  WhisperChainPort,
  WhisperEventBatch,
  WhisperEventSource,
} from "./types.ts";

const AUCTION_CREATED_SELECTOR = BigInt(hash.getSelectorFromName("AuctionCreated"));
const BID_SUBMITTED_SELECTOR = BigInt(hash.getSelectorFromName("BidSubmitted"));
const ENC_NOTE_CREATED_SELECTOR = BigInt(hash.getSelectorFromName("EncNoteCreated"));
const MAX_BIDS = 256;

interface RawEvent {
  from_address: string;
  keys: string[];
  data: string[];
  transaction_hash: string;
  block_number?: number;
}

interface RawReceipt {
  events?: RawEvent[];
}

export interface StarknetWhisperChainOptions {
  eventPageSize?: number;
}

/** Read-only RPC adapter for Whisper state and canonical pool note-creation events. */
export class StarknetWhisperChain implements WhisperChainPort, WhisperEventSource {
  private readonly eventPageSize: number;

  constructor(
    private readonly provider: ProviderInterface,
    private readonly whisperAddress: bigint,
    private readonly poolAddress: bigint,
    options: StarknetWhisperChainOptions = {},
  ) {
    this.eventPageSize = options.eventPageSize ?? 500;
  }

  async assertConfiguredPool(): Promise<void> {
    const result = await this.provider.callContract({
      contractAddress: hex(this.whisperAddress),
      entrypoint: "get_pool_address",
      calldata: [],
    });
    if (result.length !== 1 || BigInt(result[0]!) !== this.poolAddress) {
      throw new Error("Whisper contract pool address does not match operator configuration");
    }
  }

  async getAuction(auctionId: bigint): Promise<AuctionView> {
    const values = await this.provider.callContract({
      contractAddress: hex(this.whisperAddress),
      entrypoint: "get_auction",
      calldata: [hex(auctionId)],
    });
    if (values.length !== 21) {
      throw new Error(`unexpected Whisper Auction response length: ${values.length}`);
    }
    return {
      id: field(values, 0),
      paymentToken: field(values, 2),
      proceedsRecipientCommitment: field(values, 3),
      reservePrice: field(values, 6),
      forceRevealAfter: safeNumber("forceRevealAfter", field(values, 9)),
      abortAfter: safeNumber("abortAfter", field(values, 10)),
      vaultAddress: field(values, 11),
      acceptedBidsHash: field(values, 15),
      bidCount: safeNumber("bidCount", field(values, 17)),
      status: auctionStatus(field(values, 18)),
    };
  }

  async getBid(auctionId: bigint, bidHandle: bigint): Promise<BidView> {
    const values = await this.provider.callContract({
      contractAddress: hex(this.whisperAddress),
      entrypoint: "get_bid",
      calldata: [hex(auctionId), hex(bidHandle)],
    });
    if (values.length !== 10) {
      throw new Error(`unexpected Whisper SealedBid response length: ${values.length}`);
    }
    return {
      auctionId: field(values, 0),
      bidHandle: field(values, 1),
      noteId: field(values, 3),
      revealCommitment: field(values, 4),
      refundCommitment: field(values, 5),
      winnerCommitment: field(values, 6),
      funded: boolField("funded", field(values, 8)),
      settled: boolField("settled", field(values, 9)),
    };
  }

  async getAcceptedBids(auctionId: bigint): Promise<BidView[]> {
    const auction = await this.getAuction(auctionId);
    if (auction.bidCount > MAX_BIDS) throw new Error("auction bid count exceeds protocol maximum");
    const handles = await Promise.all(
      Array.from({ length: auction.bidCount }, async (_, index) => {
        const result = await this.provider.callContract({
          contractAddress: hex(this.whisperAddress),
          entrypoint: "get_bid_handle",
          calldata: [hex(auctionId), hex(BigInt(index))],
        });
        if (result.length !== 1) throw new Error("unexpected get_bid_handle response");
        return BigInt(result[0]!);
      }),
    );
    return Promise.all(handles.map((handle) => this.getBid(auctionId, handle)));
  }

  async candidateVaultNoteIds(
    transactionHash: string,
    _vaultAddress: bigint,
    _paymentToken: bigint,
  ): Promise<bigint[]> {
    const receipt = (await this.provider.getTransactionReceipt(transactionHash)) as unknown as RawReceipt;
    const events = receipt.events;
    if (events === undefined) throw new Error("transaction receipt does not expose events");
    return events.flatMap((event) => {
      if (BigInt(event.from_address) !== this.poolAddress) return [];
      if (event.keys.length < 2 || BigInt(event.keys[0]!) !== ENC_NOTE_CREATED_SELECTOR) return [];
      return [BigInt(event.keys[1]!)];
    });
  }

  async getFinalizedBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  async scanEvents(fromBlock: number, toBlock: number): Promise<WhisperEventBatch> {
    if (fromBlock > toBlock) return { auctions: [], submissions: [] };
    const [auctionEvents, submissionEvents] = await Promise.all([
      this.scanSelector(AUCTION_CREATED_SELECTOR, fromBlock, toBlock),
      this.scanSelector(BID_SUBMITTED_SELECTOR, fromBlock, toBlock),
    ]);
    return {
      auctions: auctionEvents.map((event) => ({
        auctionId: eventKey(event, 1, "auctionId"),
        transactionHash: event.transaction_hash,
        blockNumber: eventBlock(event),
      })),
      submissions: submissionEvents.map((event) => ({
        auctionId: eventKey(event, 1, "auctionId"),
        bidHandle: eventKey(event, 2, "bidHandle"),
        transactionHash: event.transaction_hash,
        blockNumber: eventBlock(event),
      })),
    };
  }

  private async scanSelector(selector: bigint, fromBlock: number, toBlock: number): Promise<RawEvent[]> {
    const events: RawEvent[] = [];
    let continuationToken: string | undefined;
    do {
      const filter = {
        address: hex(this.whisperAddress),
        from_block: { block_number: fromBlock },
        to_block: { block_number: toBlock },
        keys: [[hex(selector)]],
        chunk_size: this.eventPageSize,
        ...(continuationToken === undefined ? {} : { continuation_token: continuationToken }),
      } as EventFilter;
      const page = await this.provider.getEvents(filter);
      events.push(...(page.events as unknown as RawEvent[]));
      continuationToken = page.continuation_token;
    } while (continuationToken !== undefined);
    return events;
  }
}

function auctionStatus(value: bigint): AuctionStatus {
  switch (value) {
    case 1n:
      return "bidding";
    case 2n:
      return "settled";
    case 3n:
      return "aborted";
    default:
      throw new Error(`unexpected auction status: ${value}`);
  }
}

function boolField(name: string, value: bigint): boolean {
  if (value === 0n) return false;
  if (value === 1n) return true;
  throw new Error(`${name} is not a Cairo bool`);
}

function field(values: readonly string[], index: number): bigint {
  return BigInt(values[index]!);
}

function eventKey(event: RawEvent, index: number, name: string): bigint {
  const value = event.keys[index];
  if (value === undefined) throw new Error(`${name} is missing from event keys`);
  return BigInt(value);
}

function eventBlock(event: RawEvent): number {
  if (event.block_number === undefined) throw new Error("finalized event is missing block_number");
  return event.block_number;
}

function safeNumber(name: string, value: bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RangeError(`${name} is not a safe integer`);
  return parsed;
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}
