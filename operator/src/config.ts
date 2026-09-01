import { resolveOperatorNetworkPreset } from "./networks.ts";

export interface OperatorRuntimeConfig {
  chainId: bigint;
  rpcUrl: string;
  discoveryMode: "indexer" | "contract";
  discoveryUrl: string;
  provingUrl: string;
  poolAddress: bigint;
  whisperAddress: bigint;
  vaultAddress: bigint;
  vaultPublicKey: bigint;
  revealPublicKey: bigint;
  replayTokenAddress: bigint;
  proceedsRecipient: bigint;
  databasePath: string;
  allowedOrigins: string[];
  deploymentBlock: number;
  provingBlockLag: number;
  provingTimeoutMilliseconds: number;
  apiHost: string;
  apiPort: number;
  pollIntervalMilliseconds: number;
  coordinatorToken?: string;
}

export function loadOperatorRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): OperatorRuntimeConfig {
  const network = resolveOperatorNetworkPreset(environment.WHISPER_NETWORK);
  const vaultAddress = requiredFelt(environment, "WHISPER_VAULT_ADDRESS");
  const vaultPublicKey = requiredFelt(environment, "WHISPER_VAULT_PUBLIC_KEY");
  const proceedsRecipient = requiredFelt(
    environment,
    "WHISPER_PROCEEDS_RECIPIENT",
    vaultAddress,
  );
  if (proceedsRecipient === vaultPublicKey && proceedsRecipient !== vaultAddress) {
    throw new Error(
      "WHISPER_PROCEEDS_RECIPIENT must be a Starknet account address, not WHISPER_VAULT_PUBLIC_KEY",
    );
  }
  return {
    chainId: requiredFelt(environment, "WHISPER_CHAIN_ID", network?.chainId),
    rpcUrl: requiredUrl(environment, "WHISPER_RPC_URL", network?.rpcUrl),
    discoveryMode: parseDiscoveryMode(
      environment.WHISPER_DISCOVERY_MODE,
      network?.discoveryMode ?? "indexer",
    ),
    discoveryUrl: requiredUrl(environment, "WHISPER_DISCOVERY_URL", network?.discoveryUrl),
    provingUrl: requiredUrl(environment, "WHISPER_PROVING_URL", network?.provingUrl),
    poolAddress: requiredFelt(environment, "WHISPER_POOL_ADDRESS", network?.poolAddress),
    whisperAddress: requiredFelt(environment, "WHISPER_CONTRACT_ADDRESS"),
    vaultAddress,
    vaultPublicKey,
    revealPublicKey: requiredFelt(environment, "WHISPER_REVEAL_PUBLIC_KEY"),
    replayTokenAddress: requiredFelt(
      environment,
      "WHISPER_REPLAY_TOKEN_ADDRESS",
      network?.replayTokenAddress,
    ),
    proceedsRecipient,
    databasePath: environment.WHISPER_DATABASE_PATH ?? "./data/whisper-operator.sqlite",
    allowedOrigins: parseOrigins(environment.WHISPER_ALLOWED_ORIGINS),
    deploymentBlock: requiredInteger(environment, "WHISPER_DEPLOYMENT_BLOCK", { minimum: 0 }),
    provingBlockLag: optionalInteger(environment.WHISPER_PROVING_BLOCK_LAG, 10, {
      minimum: 0,
      maximum: 10_000,
    }),
    provingTimeoutMilliseconds: optionalInteger(
      environment.WHISPER_PROVING_TIMEOUT_MS,
      30_000,
      { minimum: 1_000, maximum: 86_400_000 },
    ),
    apiHost: environment.WHISPER_API_HOST ?? "127.0.0.1",
    apiPort: optionalInteger(environment.WHISPER_API_PORT, 8081, { minimum: 1, maximum: 65_535 }),
    pollIntervalMilliseconds: optionalInteger(environment.WHISPER_POLL_INTERVAL_MS, 10_000, {
      minimum: 250,
    }),
    ...(nonEmpty(environment.WHISPER_COORDINATOR_TOKEN) === undefined
      ? {}
      : { coordinatorToken: nonEmpty(environment.WHISPER_COORDINATOR_TOKEN)! }),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function parseDiscoveryMode(
  value: string | undefined,
  fallback: "indexer" | "contract",
): "indexer" | "contract" {
  const mode = value ?? fallback;
  if (mode !== "indexer" && mode !== "contract") {
    throw new Error("WHISPER_DISCOVERY_MODE must be indexer or contract");
  }
  return mode;
}

function requiredFelt(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback?: bigint,
): bigint {
  const value = environment[name] ?? fallback?.toString();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${name} must be bigint-compatible`);
  }
  if (parsed <= 0n) throw new Error(`${name} must be positive`);
  return parsed;
}

function requiredUrl(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback?: string,
): string {
  const value = environment[name] ?? fallback;
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return url.toString();
}

function parseOrigins(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((origin) => new URL(origin.trim()).origin);
}

function requiredInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  bounds: { minimum: number; maximum?: number },
): number {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return optionalInteger(value, Number.NaN, bounds, name);
}

function optionalInteger(
  value: string | undefined,
  fallback: number,
  bounds: { minimum: number; maximum?: number },
  name = "integer setting",
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < bounds.minimum ||
    (bounds.maximum !== undefined && parsed > bounds.maximum)
  ) {
    throw new Error(`${name} is outside the supported range`);
  }
  return parsed;
}
