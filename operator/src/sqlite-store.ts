import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";

import type { WhisperEncryptedCapsule } from "@whisper-trade/sdk";

import type {
  OperatorStore,
  SettlementRecord,
  SettlementStatus,
  SubmissionRecord,
  SubmissionStatus,
} from "./store.ts";
import type { BidSubmissionEvent } from "./types.ts";

interface SubmissionRow {
  auction_id: string;
  bid_handle: string;
  source_tx_hash: string;
  block_number: number;
  status: SubmissionStatus;
  note_id: string | null;
  result_tx_hash: string | null;
  error: string | null;
}

interface SettlementRow {
  auction_id: string;
  status: SettlementStatus;
  transaction_hash: string | null;
  error: string | null;
}

export class SqliteOperatorStore implements OperatorStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS capsules (
        reveal_commitment TEXT PRIMARY KEY,
        auction_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS submissions (
        auction_id TEXT NOT NULL,
        bid_handle TEXT NOT NULL,
        source_tx_hash TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('received','accepting','retry','funded','rejected')),
        note_id TEXT,
        result_tx_hash TEXT,
        error TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (auction_id, bid_handle)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS settlements (
        auction_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending','settling','retry','settled')),
        transaction_hash TEXT,
        error TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    this.database.close();
  }

  async putCapsule(
    envelope: WhisperEncryptedCapsule,
  ): Promise<"created" | "exists" | "conflict"> {
    const key = BigInt(envelope.revealCommitment).toString();
    const encoded = JSON.stringify(envelope);
    const current = this.database
      .prepare("SELECT envelope_json FROM capsules WHERE reveal_commitment = ?")
      .get(key) as { envelope_json: string } | undefined;
    if (current !== undefined) return current.envelope_json === encoded ? "exists" : "conflict";
    this.database
      .prepare(
        "INSERT INTO capsules (reveal_commitment, auction_id, envelope_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(key, BigInt(envelope.auctionId).toString(), encoded, Date.now());
    return "created";
  }

  async getCapsule(revealCommitment: bigint): Promise<WhisperEncryptedCapsule | undefined> {
    const row = this.database
      .prepare("SELECT envelope_json FROM capsules WHERE reveal_commitment = ?")
      .get(revealCommitment.toString()) as { envelope_json: string } | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(row.envelope_json) as WhisperEncryptedCapsule);
  }

  async recordSubmission(event: BidSubmissionEvent): Promise<SubmissionRecord> {
    this.database
      .prepare(
        `INSERT INTO submissions
          (auction_id, bid_handle, source_tx_hash, block_number, status, updated_at)
         VALUES (?, ?, ?, ?, 'received', ?)
         ON CONFLICT (auction_id, bid_handle) DO NOTHING`,
      )
      .run(
        event.auctionId.toString(),
        event.bidHandle.toString(),
        event.transactionHash,
        event.blockNumber,
        Date.now(),
      );
    const record = await this.getSubmission(event.auctionId, event.bidHandle);
    if (record === undefined) throw new Error("failed to record submission");
    return record;
  }

  async getSubmission(
    auctionId: bigint,
    bidHandle: bigint,
  ): Promise<SubmissionRecord | undefined> {
    const row = this.database
      .prepare("SELECT * FROM submissions WHERE auction_id = ? AND bid_handle = ?")
      .get(auctionId.toString(), bidHandle.toString()) as SubmissionRow | undefined;
    return row === undefined ? undefined : submissionFromRow(row);
  }

  async claimSubmission(auctionId: bigint, bidHandle: bigint): Promise<boolean> {
    const result = this.database
      .prepare(
        `UPDATE submissions SET status = 'accepting', error = NULL, updated_at = ?
         WHERE auction_id = ? AND bid_handle = ? AND status IN ('received', 'retry')`,
      )
      .run(Date.now(), auctionId.toString(), bidHandle.toString());
    return changed(result);
  }

  async markSubmissionRetry(auctionId: bigint, bidHandle: bigint, error: string): Promise<void> {
    this.updateSubmission(auctionId, bidHandle, "retry", undefined, undefined, error);
  }

  async markSubmissionRejected(auctionId: bigint, bidHandle: bigint, error: string): Promise<void> {
    this.updateSubmission(auctionId, bidHandle, "rejected", undefined, undefined, error);
  }

  async markSubmissionFunded(
    auctionId: bigint,
    bidHandle: bigint,
    noteId: bigint,
    transactionHash: string,
  ): Promise<void> {
    this.updateSubmission(auctionId, bidHandle, "funded", noteId, transactionHash, undefined);
  }

  async getSettlement(auctionId: bigint): Promise<SettlementRecord | undefined> {
    const row = this.database
      .prepare("SELECT * FROM settlements WHERE auction_id = ?")
      .get(auctionId.toString()) as SettlementRow | undefined;
    if (row === undefined) return undefined;
    return {
      auctionId: BigInt(row.auction_id),
      status: row.status,
      ...(row.transaction_hash === null ? {} : { transactionHash: row.transaction_hash }),
      ...(row.error === null ? {} : { error: row.error }),
    };
  }

  async claimSettlement(auctionId: bigint): Promise<boolean> {
    const result = this.database
      .prepare(
        `INSERT INTO settlements (auction_id, status, updated_at)
         VALUES (?, 'settling', ?)
         ON CONFLICT (auction_id) DO UPDATE SET
           status = 'settling', error = NULL, updated_at = excluded.updated_at
         WHERE settlements.status IN ('pending', 'retry')`,
      )
      .run(auctionId.toString(), Date.now());
    return changed(result);
  }

  async markSettlementRetry(auctionId: bigint, error: string): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO settlements (auction_id, status, error, updated_at)
         VALUES (?, 'retry', ?, ?)
         ON CONFLICT (auction_id) DO UPDATE SET
           status = 'retry', transaction_hash = NULL, error = excluded.error,
           updated_at = excluded.updated_at`,
      )
      .run(auctionId.toString(), error, Date.now());
  }

  async markSettlementComplete(auctionId: bigint, transactionHash: string): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO settlements (auction_id, status, transaction_hash, updated_at)
         VALUES (?, 'settled', ?, ?)
         ON CONFLICT (auction_id) DO UPDATE SET
           status = 'settled', transaction_hash = excluded.transaction_hash,
           error = NULL, updated_at = excluded.updated_at`,
      )
      .run(auctionId.toString(), transactionHash, Date.now());
  }

  private updateSubmission(
    auctionId: bigint,
    bidHandle: bigint,
    status: SubmissionStatus,
    noteId: bigint | undefined,
    transactionHash: string | undefined,
    error: string | undefined,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE submissions SET status = ?, note_id = ?, result_tx_hash = ?, error = ?, updated_at = ?
         WHERE auction_id = ? AND bid_handle = ?`,
      )
      .run(
        status,
        noteId?.toString() ?? null,
        transactionHash ?? null,
        error ?? null,
        Date.now(),
        auctionId.toString(),
        bidHandle.toString(),
      );
    if (!changed(result)) throw new Error("submission is not recorded");
  }
}

function changed(result: StatementResultingChanges): boolean {
  return Number(result.changes) > 0;
}

function submissionFromRow(row: SubmissionRow): SubmissionRecord {
  return {
    auctionId: BigInt(row.auction_id),
    bidHandle: BigInt(row.bid_handle),
    transactionHash: row.source_tx_hash,
    blockNumber: row.block_number,
    status: row.status,
    ...(row.note_id === null ? {} : { noteId: BigInt(row.note_id) }),
    ...(row.result_tx_hash === null ? {} : { transactionHashResult: row.result_tx_hash }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}
