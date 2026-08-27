import { pathToFileURL } from "node:url";

import { deriveWhisperRevealPublicKey } from "@whisper-trade/sdk";
import { Account, constants, RpcProvider } from "starknet";

import { loadOperatorRuntimeConfig } from "./config.ts";
import { createOfficialVaultRuntime } from "./official-sdk.ts";
import { loadOperatorSecretMaterial } from "./runtime-secrets.ts";
import { StarknetWhisperChain } from "./starknet-chain.ts";
import { SqliteOperatorStore } from "./sqlite-store.ts";
import { OutsideExecutionSubmitter } from "./strk20-vault.ts";

interface AbortArguments {
  auctionId: bigint;
  execute: boolean;
}

export async function runAuctionAbort(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  argumentsInput: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArguments(argumentsInput);
  const config = loadOperatorRuntimeConfig(environment);
  const secrets = loadOperatorSecretMaterial(environment, config);
  const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
  const chain = new StarknetWhisperChain(provider, config.whisperAddress, config.poolAddress);
  const store = new SqliteOperatorStore(config.databasePath);
  try {
    await validateRuntime(provider, chain, config, secrets);
    const auction = await chain.getAuction(args.auctionId);
    if (auction.vaultAddress !== config.vaultAddress) {
      throw new Error("auction vault does not match operator configuration");
    }
    if (auction.status === "aborted") {
      console.info(`Auction ${args.auctionId} is already aborted.`);
      return;
    }
    if (auction.status !== "bidding") throw new Error("auction is not abortable");
    const latestBlock = await provider.getBlock("latest");
    if (Number(latestBlock.timestamp) < auction.abortAfter) {
      throw new Error(`auction abort opens at ${new Date(auction.abortAfter * 1_000).toISOString()}`);
    }
    const recovery = await store.getRecovery(args.auctionId);
    if (recovery?.status !== "completed" || recovery.transactionHash === undefined) {
      throw new Error("auction does not have a completed rejected-bid recovery record");
    }
    const recoveryHash = positiveFelt("recovery transaction hash", recovery.transactionHash);
    console.info(
      `Verified abort plan for auction ${args.auctionId} using its completed recovery record.`,
    );
    if (!args.execute) {
      console.info("Dry run only. Re-run with --execute to submit the abort transaction.");
      return;
    }

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
    const result = await runtime.vault.abortAuction(args.auctionId, recoveryHash);
    const updated = await chain.getAuction(args.auctionId);
    if (updated.status !== "aborted") throw new Error("auction abort was not reflected onchain");
    console.info(`Abort confirmed: ${result.transactionHash}`);
  } finally {
    store.close();
  }
}

async function validateRuntime(
  provider: RpcProvider,
  chain: StarknetWhisperChain,
  config: ReturnType<typeof loadOperatorRuntimeConfig>,
  secrets: ReturnType<typeof loadOperatorSecretMaterial>,
): Promise<void> {
  if (BigInt(await provider.getChainId()) !== config.chainId) {
    throw new Error("RPC chain ID does not match operator configuration");
  }
  await chain.assertConfiguredPool();
  if (deriveWhisperRevealPublicKey(secrets.vaultViewingPrivateKey) !== config.vaultPublicKey) {
    throw new Error("vault viewing key does not match operator configuration");
  }
  if (deriveWhisperRevealPublicKey(secrets.capsuleRevealPrivateKey) !== config.revealPublicKey) {
    throw new Error("capsule reveal key does not match operator configuration");
  }
}

function parseArguments(values: readonly string[]): AbortArguments {
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
      auctionId = positiveFelt("auction ID", raw);
      index += 1;
      continue;
    }
    throw new Error(`unknown abort argument: ${value ?? ""}`);
  }
  if (auctionId === undefined) throw new Error("--auction-id is required");
  return { auctionId, execute };
}

function positiveFelt(name: string, value: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${name} must be a positive felt`);
  }
  if (parsed <= 0n || parsed >= constants.PRIME) {
    throw new Error(`${name} must be a positive felt`);
  }
  return parsed;
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown abort error";
  if (/proof|calldata|signed.?invocation|request\s*(body|payload)/i.test(error.message)) {
    return `${error.name}: sensitive request details suppressed`;
  }
  return error.message.length <= 500 ? error.message : `${error.message.slice(0, 497)}...`;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runAuctionAbort().catch((error: unknown) => {
    console.error(`Whisper abort failed: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
