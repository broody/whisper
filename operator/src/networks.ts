export interface OperatorNetworkPreset {
  chainId: bigint;
  rpcUrl: string;
  discoveryUrl: string;
  provingUrl: string;
  poolAddress: bigint;
}

/**
 * Publicly reachable StarkWare development infrastructure for Sepolia.
 * These services have no published availability commitment, so production
 * and mainnet deployments must provide their own explicit endpoints.
 */
export const SEPOLIA_OPERATOR_NETWORK = Object.freeze({
  chainId: 0x534e5f5345504f4c4941n,
  rpcUrl: "https://starknet-sepolia-rpc.publicnode.com",
  discoveryUrl: "https://discovery-service.alpha-sepolia.sw-dev.io",
  provingUrl: "https://transaction-prover.alpha-sepolia.sw-dev.io",
  poolAddress: 0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91n,
}) satisfies OperatorNetworkPreset;

export function resolveOperatorNetworkPreset(
  name: string | undefined,
): OperatorNetworkPreset | undefined {
  if (name === undefined || name.trim() === "") return undefined;
  if (name === "sepolia") return SEPOLIA_OPERATOR_NETWORK;
  throw new Error("WHISPER_NETWORK must be sepolia or omitted for explicit configuration");
}
