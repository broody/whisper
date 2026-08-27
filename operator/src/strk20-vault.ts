import {
  buildWhisperAcceptBidAction,
  buildWhisperSettlementAction,
  type ComputeAndInvokeBuilder,
} from "@whisper-trade/sdk";
import {
  Account,
  type BlockIdentifier,
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
  register(): this;
  with(token: bigint, operations: (builder: UpstreamTokenBuilder) => void): this;
  computeAndInvoke(builder: ComputeAndInvokeBuilder): this;
  execute(options?: { provingBlockId?: BlockIdentifier }): Promise<{ callAndProof: CallAndProof }>;
}

export interface PrivateTransfersLike {
  discoverNotes(input: {
    tokens: bigint[];
    blockIdentifier?: BlockIdentifier;
  }): Promise<{ notes: UpstreamNoteMap }>;
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
  private replayRotation: Promise<void> = Promise.resolve();

  constructor(
    private readonly transfers: PrivateTransfersLike,
    private readonly submitter: ProofSubmitter,
    private readonly whisperAddress: string,
    private readonly vaultAddress: bigint,
    private readonly vaultPublicKey: bigint,
    private readonly replayTokenAddress: bigint,
    private readonly provingBlockIdProvider?: () => Promise<BlockIdentifier>,
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

  async register(): Promise<TransactionResult> {
    const result = await this.execute(this.transfers.build().register());
    return this.submitter.submit(result.callAndProof);
  }

  async acceptBid(
    auctionId: bigint,
    bidHandle: bigint,
    noteId: bigint,
  ): Promise<TransactionResult> {
    return this.withReplayRotation(async () => {
      const provingBlockId = await this.provingBlockId();
      const replayNote = await this.discoverReplayNote(noteId, provingBlockId);
      const result = await this.execute(
        this.transfers
          .build({
            autoDiscover: { channels: "refresh" },
            autoSetup: true,
          })
          .with(this.replayTokenAddress, (token) => {
            token.inputs(replayNote).transfer({
              recipient: this.vaultPublicKey,
              amount: replayNote.amount,
            });
          })
          .computeAndInvoke(
            buildWhisperAcceptBidAction({
              whisperAddress: this.whisperAddress,
              auctionId,
              bidHandle,
              noteId,
            }),
          ),
        provingBlockId,
      );
      return this.submitter.submit(result.callAndProof);
    });
  }

  async assertReplayNoteAvailable(): Promise<void> {
    await this.discoverReplayNote(0n, await this.provingBlockId());
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
    const result = await this.execute(
      builder
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
        ),
    );
    return this.submitter.submit(result.callAndProof);
  }

  private async discoverReplayNote(
    excludedNoteId: bigint,
    provingBlockId: BlockIdentifier | undefined,
  ): Promise<UpstreamNote> {
    const result = await this.transfers.discoverNotes({
      tokens: [this.replayTokenAddress],
      ...(provingBlockId === undefined ? {} : { blockIdentifier: provingBlockId }),
    });
    const candidates = (result.notes.get(this.replayTokenAddress) ?? [])
      .filter(
        (note) =>
          BigInt(note.id) !== excludedNoteId &&
          BigInt(note.sender) === this.vaultAddress &&
          note.amount > 0n,
      )
      .sort(compareReplayNotes);
    const note = candidates[0];
    if (note === undefined) {
      throw new Error("no mature vault-owned replay note is available");
    }
    return note;
  }

  private async provingBlockId(): Promise<BlockIdentifier | undefined> {
    return this.provingBlockIdProvider?.();
  }

  private async execute(
    builder: UpstreamBuilder,
    provingBlockId?: BlockIdentifier,
  ): Promise<{ callAndProof: CallAndProof }> {
    const blockId = provingBlockId ?? (await this.provingBlockId());
    if (blockId === undefined) return builder.execute();
    return builder.execute({ provingBlockId: blockId });
  }

  private async withReplayRotation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.replayRotation;
    let release: () => void = () => undefined;
    this.replayRotation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function compareReplayNotes(left: UpstreamNote, right: UpstreamNote): number {
  const leftCreated = left.created ?? Number.MAX_SAFE_INTEGER;
  const rightCreated = right.created ?? Number.MAX_SAFE_INTEGER;
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;
  const leftID = BigInt(left.id);
  const rightID = BigInt(right.id);
  return leftID < rightID ? -1 : leftID > rightID ? 1 : 0;
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
