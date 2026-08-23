export interface OperatorRuntimeConfig {
  chainId: bigint;
  rpcUrl: string;
  discoveryUrl: string;
  provingUrl: string;
  poolAddress: bigint;
  whisperAddress: bigint;
  vaultAddress: bigint;
  vaultPublicKey: bigint;
  revealPublicKey: bigint;
  databasePath: string;
  allowedOrigins: string[];
}

export function loadOperatorRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): OperatorRuntimeConfig {
  return {
    chainId: requiredFelt(environment, "WHISPER_CHAIN_ID"),
    rpcUrl: requiredUrl(environment, "WHISPER_RPC_URL"),
    discoveryUrl: requiredUrl(environment, "WHISPER_DISCOVERY_URL"),
    provingUrl: requiredUrl(environment, "WHISPER_PROVING_URL"),
    poolAddress: requiredFelt(environment, "WHISPER_POOL_ADDRESS"),
    whisperAddress: requiredFelt(environment, "WHISPER_CONTRACT_ADDRESS"),
    vaultAddress: requiredFelt(environment, "WHISPER_VAULT_ADDRESS"),
    vaultPublicKey: requiredFelt(environment, "WHISPER_VAULT_PUBLIC_KEY"),
    revealPublicKey: requiredFelt(environment, "WHISPER_REVEAL_PUBLIC_KEY"),
    databasePath: environment.WHISPER_DATABASE_PATH ?? "./data/whisper-operator.sqlite",
    allowedOrigins: parseOrigins(environment.WHISPER_ALLOWED_ORIGINS),
  };
}

function requiredFelt(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): bigint {
  const value = environment[name];
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
): string {
  const value = environment[name];
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
