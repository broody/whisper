import {
  buildWhisperAcceptBidAction,
  buildWhisperSettlementAction,
  type ComputeAndInvokeBuilder,
} from "@whisper-trade/sdk";
import {
  Account,
  OutsideExecutionVersion,
  type Call,
  type OutsideExecutionOptions,
  type ProviderInterface,
} from "starknet";

import type { SettlementPlan, TransactionResult, VaultNote, VaultPort } from "./types.ts";

interface UpstreamNote {
  id: string | number | bigint;
  amount: bigint;
  created?: number;
  sender: string | number | bigint;
}

interface UpstreamNoteMap {
  get(token: bigint): UpstreamNote[] | undefined;
}

interface UpstreamTokenBuilder {
  inputs(...notes: unknown[]): this;
  transfer(...outputs: { recipient: bigint; amount: bigint }[]): this;
}

interface UpstreamBuilder {
  with(token: bigint, operations: (builder: UpstreamTokenBuilder) => void): this;
  computeAndInvoke(builder: ComputeAndInvokeBuilder): this;
  execute(): Promise<{ callAndProof: CallAndProof }>;
}

export interface PrivateTransfersLike {
  discoverNotes(input: { tokens: bigint[] }): Promise<{ notes: UpstreamNoteMap }>;
  build(options?: {
    autoDiscover?: { notes?: "refresh"; channels?: "refresh" };
    autoSetup?: boolean;
  }): UpstreamBuilder;
}

export interface CallAndProof {
  call: Call;
  proof: {
    data: string;
    proofFacts: string[];
  };
}

export interface ProofSubmitter {
  submit(callAndProof: CallAndProof): Promise<TransactionResult>;
}

/** Adapter over the official Privacy SDK's structural interface. */
export class Strk20VaultClient implements VaultPort {
  constructor(
    private readonly transfers: PrivateTransfersLike,
    private readonly submitter: ProofSubmitter,
    private readonly whisperAddress: string,
  ) {}

  async discoverNotes(paymentToken: bigint): Promise<VaultNote[]> {
    const result = await this.transfers.discoverNotes({ tokens: [paymentToken] });
    return (result.notes.get(paymentToken) ?? []).map((note) => ({
      id: BigInt(note.id),
      token: paymentToken,
      amount: note.amount,
      ...(note.created === undefined ? {} : { createdBlock: note.created }),
      sender: BigInt(note.sender),
      opaque: note,
    }));
  }

  async acceptBid(
    auctionId: bigint,
    bidHandle: bigint,
    noteId: bigint,
  ): Promise<TransactionResult> {
    const result = await this.transfers
      .build()
      .computeAndInvoke(
        buildWhisperAcceptBidAction({
          whisperAddress: this.whisperAddress,
          auctionId,
          bidHandle,
          noteId,
        }),
      )
      .execute();
    return this.submitter.submit(result.callAndProof);
  }

  async settle(plan: SettlementPlan): Promise<TransactionResult> {
    let builder = this.transfers.build({
      autoDiscover: { notes: "refresh", channels: "refresh" },
      autoSetup: true,
    });
    if (plan.notes.length > 0 || plan.outputs.length > 0) {
      builder = builder.with(plan.auction.paymentToken, (token) => {
        if (plan.notes.length > 0) token.inputs(...plan.notes.map((note) => note.opaque));
        if (plan.outputs.length > 0) {
          token.transfer(
            ...plan.outputs.map((output) => ({
              recipient: output.recipient,
              amount: output.amount,
            })),
          );
        }
      });
    }
    const result = await builder
      .computeAndInvoke(
        buildWhisperSettlementAction({
          whisperAddress: this.whisperAddress,
          auctionId: plan.auction.id,
          acceptedBidsHash: plan.auction.acceptedBidsHash,
          revealedBids: plan.reveals,
          winnerBidHandle: plan.winnerBidHandle,
          revealsRoot: plan.revealsRoot,
          outputsRoot: plan.outputsRoot,
          settlementHash: plan.settlementHash,
        }),
      )
      .execute();
    return this.submitter.submit(result.callAndProof);
  }
}

export interface OutsideExecutionSubmitterOptions {
  validityWindowSeconds?: number;
}

/** Relays the proof-backed pool call from a separate Starknet account. */
export class OutsideExecutionSubmitter implements ProofSubmitter {
  private readonly validityWindowSeconds: number;

  constructor(
    private readonly relayer: Account,
    private readonly provider: ProviderInterface,
    options: OutsideExecutionSubmitterOptions = {},
  ) {
    this.validityWindowSeconds = options.validityWindowSeconds ?? 300;
  }

  async submit(callAndProof: CallAndProof): Promise<TransactionResult> {
    const now = Math.floor(Date.now() / 1_000);
    const options: OutsideExecutionOptions = {
      caller: this.relayer.address,
      execute_after: now - 30,
      execute_before: now + this.validityWindowSeconds,
    };
    const outsideTransaction = await this.relayer.getOutsideTransaction(
      options,
      callAndProof.call,
      OutsideExecutionVersion.V2,
    );
    const response = await this.relayer.executeFromOutside(outsideTransaction, {
      proofFacts: callAndProof.proof.proofFacts,
      proof: callAndProof.proof.data,
    });
    const receipt = await this.provider.waitForTransaction(response.transaction_hash);
    if (!receipt.isSuccess()) {
      const reason = "revert_reason" in receipt ? String(receipt.revert_reason) : "unknown";
      throw new Error(`private pool transaction reverted: ${reason}`);
    }
    return { transactionHash: response.transaction_hash };
  }
}
