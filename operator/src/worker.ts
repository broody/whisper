import type { WhisperOperator } from "./engine.ts";
import type { OperatorStore } from "./store.ts";
import type { Clock, WhisperChainPort, WhisperEventSource } from "./types.ts";
import { systemClock } from "./types.ts";

export interface OperatorWorkerOptions {
  deploymentBlock: number;
  scanRange?: number;
  maxScanWindows?: number;
  submissionBatchSize?: number;
  staleLeaseMilliseconds?: number;
  pollIntervalMilliseconds?: number;
  clock?: Clock;
  onError?: (error: unknown, context: string) => void;
}

export interface OperatorWorkerResult {
  scannedToBlock?: number;
  eventsRecorded: number;
  submissionsProcessed: number;
  settlementsAttempted: number;
  staleLeasesRecovered: number;
}

/** Durable finalized-block scanner and settlement scheduler. */
export class OperatorWorker {
  private readonly scanRange: number;
  private readonly maxScanWindows: number;
  private readonly submissionBatchSize: number;
  private readonly staleLeaseMilliseconds: number;
  private readonly pollIntervalMilliseconds: number;
  private readonly clock: Clock;

  constructor(
    private readonly operator: WhisperOperator,
    private readonly chain: WhisperChainPort,
    private readonly events: WhisperEventSource,
    private readonly store: OperatorStore,
    private readonly options: OperatorWorkerOptions,
  ) {
    assertPositiveInteger("deploymentBlock", options.deploymentBlock, true);
    this.scanRange = positiveOption("scanRange", options.scanRange, 1_000);
    this.maxScanWindows = positiveOption("maxScanWindows", options.maxScanWindows, 10);
    this.submissionBatchSize = positiveOption(
      "submissionBatchSize",
      options.submissionBatchSize,
      25,
    );
    this.staleLeaseMilliseconds = positiveOption(
      "staleLeaseMilliseconds",
      options.staleLeaseMilliseconds,
      5 * 60_000,
    );
    this.pollIntervalMilliseconds = positiveOption(
      "pollIntervalMilliseconds",
      options.pollIntervalMilliseconds,
      10_000,
    );
    this.clock = options.clock ?? systemClock;
  }

  async runOnce(): Promise<OperatorWorkerResult> {
    const result: OperatorWorkerResult = {
      eventsRecorded: 0,
      submissionsProcessed: 0,
      settlementsAttempted: 0,
      staleLeasesRecovered: await this.store.recoverStaleWork(
        Date.now() - this.staleLeaseMilliseconds,
      ),
    };
    const latest = await this.events.getFinalizedBlockNumber();
    let cursor =
      (await this.store.getLastScannedBlock()) ?? Math.max(this.options.deploymentBlock - 1, -1);

    for (let window = 0; window < this.maxScanWindows && cursor < latest; window += 1) {
      const fromBlock = Math.max(cursor + 1, this.options.deploymentBlock);
      const toBlock = Math.min(fromBlock + this.scanRange - 1, latest);
      const batch = await this.events.scanEvents(fromBlock, toBlock);
      for (const auction of batch.auctions) await this.store.trackAuction(auction.auctionId);
      for (const submission of batch.submissions) {
        await this.store.trackAuction(submission.auctionId);
        await this.store.recordSubmission(submission);
      }
      await this.store.setLastScannedBlock(toBlock);
      result.eventsRecorded += batch.auctions.length + batch.submissions.length;
      result.scannedToBlock = toBlock;
      cursor = toBlock;
    }

    const submissions = await this.store.listProcessableSubmissions(this.submissionBatchSize);
    for (const submission of submissions) {
      try {
        await this.operator.processSubmission(submission.auctionId, submission.bidHandle);
      } catch (error) {
        this.options.onError?.(error, `submission:${submission.auctionId}:${submission.bidHandle}`);
      }
      result.submissionsProcessed += 1;
    }

    const now = this.clock.nowSeconds();
    for (const auctionId of await this.store.listTrackedAuctions()) {
      try {
        const auction = await this.chain.getAuction(auctionId);
        if (
          auction.status === "bidding" &&
          now >= auction.forceRevealAfter &&
          now < auction.abortAfter
        ) {
          result.settlementsAttempted += 1;
          await this.operator.settleAuction(auctionId);
        }
      } catch (error) {
        this.options.onError?.(error, `settlement:${auctionId}`);
      }
    }
    return result;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch (error) {
        this.options.onError?.(error, "worker");
      }
      await abortableDelay(this.pollIntervalMilliseconds, signal);
    }
  }
}

function positiveOption(name: string, value: number | undefined, fallback: number): number {
  const parsed = value ?? fallback;
  assertPositiveInteger(name, parsed, false);
  return parsed;
}

function assertPositiveInteger(name: string, value: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new RangeError(`${name} must be ${allowZero ? "non-negative" : "positive"}`);
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
