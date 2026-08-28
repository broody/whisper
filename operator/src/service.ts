import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Account, constants, type ProviderInterface } from "starknet";
import { deriveWhisperRevealPublicKey } from "@whisper-trade/sdk";

import { createOperatorApi } from "./api.ts";
import { WhisperSdkCapsuleCipher, type RevealPrivateKeyProvider } from "./capsule-cipher.ts";
import type { OperatorRuntimeConfig } from "./config.ts";
import { WhisperOperator } from "./engine.ts";
import {
  createOfficialVaultRuntime,
  type OfficialPrivacySdkModule,
  type VaultViewingKeyProvider,
} from "./official-sdk.ts";
import { SqliteOperatorStore } from "./sqlite-store.ts";
import { StarknetWhisperChain } from "./starknet-chain.ts";
import { OutsideExecutionSubmitter } from "./strk20-vault.ts";
import type { ProceedsRecipientProvider } from "./types.ts";
import { OperatorWorker } from "./worker.ts";
import { AuctionCoordinator } from "./auction-coordinator.ts";

export interface OperatorServiceDependencies {
  config: OperatorRuntimeConfig;
  provider: ProviderInterface;
  vaultAccount: Account;
  relayerAccount: Account;
  viewingKeyProvider: VaultViewingKeyProvider;
  revealKeyProvider: RevealPrivateKeyProvider;
  proceedsRecipients: ProceedsRecipientProvider;
  sdkModule?: OfficialPrivacySdkModule;
  onWorkerError?: (error: unknown, context: string) => void;
}

export interface OperatorService {
  chain: StarknetWhisperChain;
  operator: WhisperOperator;
  worker: OperatorWorker;
  api: ReturnType<typeof createOperatorApi>;
  store: SqliteOperatorStore;
  validate(): Promise<void>;
  ready(): Promise<void>;
  listen(): Promise<void>;
  registerVault(): Promise<{ transactionHash: string }>;
  close(): Promise<void>;
}

/** Assemble the deployable service while keeping all four credentials injected. */
export async function createOperatorService(
  dependencies: OperatorServiceDependencies,
): Promise<OperatorService> {
  const { config } = dependencies;
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const store = new SqliteOperatorStore(config.databasePath);
  try {
    const chain = new StarknetWhisperChain(
      dependencies.provider,
      config.whisperAddress,
      config.poolAddress,
    );
    const submitter = new OutsideExecutionSubmitter(
      dependencies.relayerAccount,
      dependencies.provider,
    );
    const runtime = await createOfficialVaultRuntime({
      account: {
        address: dependencies.vaultAccount.address,
        signer: dependencies.vaultAccount.signer,
      },
      viewingKeyProvider: dependencies.viewingKeyProvider,
      provingUrl: config.provingUrl,
      discoveryUrl: config.discoveryUrl,
      discoveryMode: config.discoveryMode,
      rpcUrl: config.rpcUrl,
      chainId: `0x${config.chainId.toString(16)}` as constants.StarknetChainId,
      poolAddress: config.poolAddress,
      whisperAddress: config.whisperAddress,
      vaultAddress: config.vaultAddress,
      replayTokenAddress: config.replayTokenAddress,
      submitter,
      provingBlockIdProvider: async () =>
        Math.max((await dependencies.provider.getBlockNumber()) - config.provingBlockLag, 0),
      ...(dependencies.sdkModule === undefined ? {} : { sdkModule: dependencies.sdkModule }),
    });
    const capsules = new WhisperSdkCapsuleCipher(
      {
        chainId: config.chainId,
        poolAddress: config.poolAddress,
        whisperAddress: config.whisperAddress,
      },
      dependencies.revealKeyProvider,
    );
    const operator = new WhisperOperator({
      chain,
      vault: runtime.vault,
      capsules,
      store,
      proceedsRecipients: dependencies.proceedsRecipients,
    });
    const worker = new OperatorWorker(operator, chain, chain, store, {
      deploymentBlock: config.deploymentBlock,
      pollIntervalMilliseconds: config.pollIntervalMilliseconds,
      ...(dependencies.onWorkerError === undefined
        ? {}
        : { onError: dependencies.onWorkerError }),
    });
    const validate = async () => {
      if (BigInt(dependencies.vaultAccount.address) !== config.vaultAddress) {
        throw new Error("vault account address does not match public configuration");
      }
      if (BigInt(await dependencies.provider.getChainId()) !== config.chainId) {
        throw new Error("RPC chain ID does not match operator configuration");
      }
      if (
        deriveWhisperRevealPublicKey(await dependencies.viewingKeyProvider.getViewingKey()) !==
        config.vaultPublicKey
      ) {
        throw new Error("vault viewing key does not match public configuration");
      }
      if (
        deriveWhisperRevealPublicKey(
          await dependencies.revealKeyProvider.getRevealPrivateKey(),
        ) !== config.revealPublicKey
      ) {
        throw new Error("capsule reveal key does not match public configuration");
      }
      await chain.assertConfiguredPool();
    };
    const ready = async () => {
      await validate();
      await runtime.vault.assertReplayNoteAvailable();
    };
    const api = createOperatorApi({
      store,
      publicConfig: {
        chainId: config.chainId,
        poolAddress: config.poolAddress,
        whisperAddress: config.whisperAddress,
        vaultAddress: config.vaultAddress,
        vaultPublicKey: config.vaultPublicKey,
        revealPublicKey: config.revealPublicKey,
      },
      readiness: ready,
      allowedOrigins: config.allowedOrigins,
      winnerReader: operator,
      ...(config.coordinatorToken === undefined
        ? {}
        : {
            coordinatorToken: config.coordinatorToken,
            coordinator: new AuctionCoordinator({
              provider: dependencies.provider,
              relayerAccount: dependencies.relayerAccount,
              store,
              whisperAddress: config.whisperAddress,
              vaultAddress: config.vaultAddress,
              vaultPublicKey: config.vaultPublicKey,
              revealPublicKey: config.revealPublicKey,
              proceedsRecipient: config.proceedsRecipient,
              getViewingKey: async () =>
                BigInt(await dependencies.viewingKeyProvider.getViewingKey()),
            }),
          }),
    });
    return {
      chain,
      operator,
      worker,
      api,
      store,
      validate,
      ready,
      listen: async () => {
        if (api.listening) return;
        await new Promise<void>((resolve, reject) => {
          api.once("error", reject);
          api.listen(config.apiPort, config.apiHost, () => {
            api.off("error", reject);
            resolve();
          });
        });
      },
      registerVault: () => runtime.vault.register(),
      close: async () => {
        if (api.listening) {
          await new Promise<void>((resolve, reject) =>
            api.close((error) => (error === undefined ? resolve() : reject(error))),
          );
        }
        store.close();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
