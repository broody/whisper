import type { BigNumberish, SignerInterface, constants } from "starknet";
import type { FeltLike } from "@whisper-trade/sdk";

import {
  Strk20VaultClient,
  type PrivateTransfersLike,
  type ProofSubmitter,
} from "./strk20-vault.ts";

const OFFICIAL_SDK_PACKAGE = "@starkware-libs/starknet-privacy-sdk";

export interface VaultViewingKeyProvider {
  getViewingKey(): Promise<FeltLike>;
}

export interface OfficialPrivacySdkModule {
  createPrivateTransfers(input: {
    account: { address: BigNumberish; signer: SignerInterface };
    viewingKeyProvider: VaultViewingKeyProvider;
    provingProvider: {
      url: string;
      chainId: constants.StarknetChainId;
      nodeUrl: string;
    };
    discoveryProvider: { url: string };
    poolContractAddress: BigNumberish;
  }): PrivateTransfersLike;
}

export interface OfficialVaultRuntimeOptions {
  account: { address: BigNumberish; signer: SignerInterface };
  viewingKeyProvider: VaultViewingKeyProvider;
  provingUrl: string;
  discoveryUrl: string;
  rpcUrl: string;
  chainId: constants.StarknetChainId;
  poolAddress: bigint;
  whisperAddress: bigint;
  submitter: ProofSubmitter;
  /** Test/embedding override; production loads the optional peer package. */
  sdkModule?: OfficialPrivacySdkModule;
}

export interface OfficialVaultRuntime {
  transfers: PrivateTransfersLike;
  vault: Strk20VaultClient;
}

/** Compose the official SDK without putting the vault viewing key into application state. */
export async function createOfficialVaultRuntime(
  options: OfficialVaultRuntimeOptions,
): Promise<OfficialVaultRuntime> {
  const sdk = options.sdkModule ?? (await loadOfficialPrivacySdk());
  const transfers = sdk.createPrivateTransfers({
    account: options.account,
    viewingKeyProvider: options.viewingKeyProvider,
    provingProvider: {
      url: requiredHttpUrl("provingUrl", options.provingUrl),
      chainId: options.chainId,
      nodeUrl: requiredHttpUrl("rpcUrl", options.rpcUrl),
    },
    discoveryProvider: { url: requiredHttpUrl("discoveryUrl", options.discoveryUrl) },
    poolContractAddress: options.poolAddress,
  });
  return {
    transfers,
    vault: new Strk20VaultClient(
      transfers,
      options.submitter,
      `0x${options.whisperAddress.toString(16)}`,
    ),
  };
}

async function loadOfficialPrivacySdk(): Promise<OfficialPrivacySdkModule> {
  try {
    const loaded = (await import(OFFICIAL_SDK_PACKAGE)) as unknown as OfficialPrivacySdkModule;
    if (typeof loaded.createPrivateTransfers !== "function") {
      throw new Error("package does not export createPrivateTransfers");
    }
    return loaded;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown module error";
    throw new Error(
      `Unable to load ${OFFICIAL_SDK_PACKAGE}; configure GitHub Packages and install 0.14.3-rc.5: ${detail}`,
    );
  }
}

function requiredHttpUrl(name: string, value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return parsed.toString();
}
