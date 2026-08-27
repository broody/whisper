import { pathToFileURL } from "node:url";

import { deriveWhisperRevealPublicKey } from "@whisper-trade/sdk";
import { Account, constants, RpcProvider } from "starknet";

import { WhisperSdkCapsuleCipher } from "./capsule-cipher.ts";
import { loadOperatorRuntimeConfig } from "./config.ts";
import { createOfficialVaultRuntime } from "./official-sdk.ts";
import { AuctionRecovery } from "./recovery.ts";
import { loadOperatorSecretMaterial } from "./runtime-secrets.ts";
import { StarknetWhisperChain } from "./starknet-chain.ts";
import { SqliteOperatorStore } from "./sqlite-store.ts";
import { OutsideExecutionSubmitter } from "./strk20-vault.ts";

interface RecoveryArguments {
  auctionId: bigint;
  execute: boolean;
}

export async function runAuctionRecovery(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  argumentsInput: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArguments(argumentsInput);
  const config = loadOperatorRuntimeConfig(environment);
  const secrets = loadOperatorSecretMaterial(environment, config);
  const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
  const vaultAccount = new Account({
    provider,
    address: `0x${config.vaultAddress.toString(16)}`,
    signer: secrets.vaultPrivateKey,
  });
  const relayerAccount = new Account({
    provider,
    address: secrets.relayerAddress,
    signer: secrets.relayerPrivateKey,
  });
  const chain = new StarknetWhisperChain(provider, config.whisperAddress, config.poolAddress);
  const store = new SqliteOperatorStore(config.databasePath);
  try {
    await validateRuntime(provider, chain, config, secrets, args.auctionId);
    const runtime = await createOfficialVaultRuntime({
      account: { address: vaultAccount.address, signer: vaultAccount.signer },
      viewingKeyProvider: { getViewingKey: async () => secrets.vaultViewingPrivateKey },
      provingUrl: config.provingUrl,
      discoveryUrl: config.discoveryUrl,
      discoveryMode: config.discoveryMode,
      rpcUrl: config.rpcUrl,
      chainId: `0x${config.chainId.toString(16)}` as constants.StarknetChainId,
      poolAddress: config.poolAddress,
      whisperAddress: config.whisperAddress,
      vaultAddress: config.vaultAddress,
      replayTokenAddress: config.replayTokenAddress,
      submitter: new OutsideExecutionSubmitter(relayerAccount, provider),
      provingBlockIdProvider: async () =>
        Math.max((await provider.getBlockNumber()) - config.provingBlockLag, 0),
    });
    const recovery = new AuctionRecovery({
      chain,
      vault: runtime.vault,
      capsules: new WhisperSdkCapsuleCipher(
        {
          chainId: config.chainId,
          poolAddress: config.poolAddress,
          whisperAddress: config.whisperAddress,
        },
        { getRevealPrivateKey: async () => secrets.capsuleRevealPrivateKey },
      ),
      store,
    });
    const existing = await store.getRecovery(args.auctionId);
    if (existing?.status === "completed") {
      if (existing.transactionHash === undefined) {
        throw new Error("completed auction recovery is missing its transaction hash");
      }
      console.info(`Recovery already completed: ${existing.transactionHash}`);
      return;
    }
    if (existing?.status === "recovering") {
      throw new Error("auction recovery is already in progress; reconcile it before retrying");
    }
    const plan = await recovery.plan(args.auctionId);
    console.info(
      `Verified recovery plan for auction ${args.auctionId}: ${plan.refunds.length} rejected bid note(s).`,
    );
    if (!args.execute) {
      console.info("Dry run only. Re-run with --execute to submit the private refund transaction.");
      return;
    }
    const result = await recovery.recoverPlan(plan);
    console.info(
      `Recovery ${result.alreadyCompleted ? "already completed" : "confirmed"}: ${result.transactionHash}`,
    );
  } finally {
    store.close();
  }
}

async function validateRuntime(
  provider: RpcProvider,
  chain: StarknetWhisperChain,
  config: ReturnType<typeof loadOperatorRuntimeConfig>,
  secrets: ReturnType<typeof loadOperatorSecretMaterial>,
  auctionId: bigint,
): Promise<void> {
  if (BigInt(await provider.getChainId()) !== config.chainId) {
    throw new Error("RPC chain ID does not match operator configuration");
  }
  await chain.assertConfiguredPool();
  const auction = await chain.getAuction(auctionId);
  if (auction.vaultAddress !== config.vaultAddress) {
    throw new Error("auction vault does not match operator configuration");
  }
  if (deriveWhisperRevealPublicKey(secrets.vaultViewingPrivateKey) !== config.vaultPublicKey) {
    throw new Error("vault viewing key does not match operator configuration");
  }
  if (deriveWhisperRevealPublicKey(secrets.capsuleRevealPrivateKey) !== config.revealPublicKey) {
    throw new Error("capsule reveal key does not match operator configuration");
  }
}

function parseArguments(values: readonly string[]): RecoveryArguments {
  let auctionId: bigint | undefined;
  let execute = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--execute") {
      execute = true;
      continue;
    }
    if (value === "--auction-id") {
      const raw = values[index + 1];
      if (raw === undefined) throw new Error("--auction-id requires a value");
      auctionId = positiveBigInt("auction ID", raw);
      index += 1;
      continue;
    }
    throw new Error(`unknown recovery argument: ${value ?? ""}`);
  }
  if (auctionId === undefined) throw new Error("--auction-id is required");
  return { auctionId, execute };
}

function positiveBigInt(name: string, value: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${name} must be a positive integer`);
  }
  if (parsed <= 0n) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown recovery error";
  if (/proof|calldata|signed.?invocation|request\s*(body|payload)/i.test(error.message)) {
    return `${error.name}: sensitive request details suppressed`;
  }
  return error.message.length <= 500 ? error.message : `${error.message.slice(0, 497)}...`;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runAuctionRecovery().catch((error: unknown) => {
    console.error(`Whisper recovery failed: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
