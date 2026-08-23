import {
  decryptWhisperBidCapsule,
  type FeltLike,
  type WhisperBidOpening,
  type WhisperEncryptedCapsule,
} from "@whisper-trade/sdk";

import type { CapsuleCipher } from "./types.ts";

export interface RevealPrivateKeyProvider {
  getRevealPrivateKey(): Promise<FeltLike>;
}

export interface WhisperCapsuleCipherConfig {
  chainId: FeltLike;
  poolAddress: FeltLike;
  whisperAddress: FeltLike;
}

/** Keeps reveal-key custody outside the auction engine and persistent database. */
export class WhisperSdkCapsuleCipher implements CapsuleCipher {
  constructor(
    private readonly config: WhisperCapsuleCipherConfig,
    private readonly keyProvider: RevealPrivateKeyProvider,
  ) {}

  async decrypt(
    envelope: WhisperEncryptedCapsule,
    context: { auctionId: bigint; revealCommitment: bigint },
  ): Promise<WhisperBidOpening> {
    return decryptWhisperBidCapsule(envelope, await this.keyProvider.getRevealPrivateKey(), {
      ...this.config,
      auctionId: context.auctionId,
      revealCommitment: context.revealCommitment,
    });
  }
}
