import { pathToFileURL } from "node:url";

import { Account, RpcProvider } from "starknet";

import { loadOperatorRuntimeConfig } from "./config.ts";
import { OperatorCircuitBreakerError } from "./engine.ts";
import { loadOperatorSecretMaterial } from "./runtime-secrets.ts";
import { createOperatorService } from "./service.ts";

export async function runOperator(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const config = loadOperatorRuntimeConfig(environment);
  const secrets = loadOperatorSecretMaterial(environment, config);
  const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
  const service = await createOperatorService({
    config,
    provider,
    vaultAccount: new Account({
      provider,
      address: `0x${config.vaultAddress.toString(16)}`,
      signer: secrets.vaultPrivateKey,
    }),
    relayerAccount: new Account({
      provider,
      address: secrets.relayerAddress,
      signer: secrets.relayerPrivateKey,
    }),
    viewingKeyProvider: {
      getViewingKey: async () => secrets.vaultViewingPrivateKey,
    },
    revealKeyProvider: {
      getRevealPrivateKey: async () => secrets.capsuleRevealPrivateKey,
    },
    proceedsRecipients: {
      getProceedsRecipient: async () => config.proceedsRecipient,
    },
    onWorkerError: (error, context) => {
      console.error(`Whisper operator ${context} failed: ${safeError(error)}`);
    },
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await service.validate();
    await service.listen();
    console.info(`Whisper operator listening on http://${config.apiHost}:${config.apiPort}`);
    await service.worker.run(controller.signal);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await service.close();
  }
}

function safeError(error: unknown): string {
  const baseError = isRecord(error) && isRecord(error.baseError) ? error.baseError : undefined;
  const baseMessage = baseError?.message;
  if (typeof baseMessage === "string") {
    const code = baseError?.code;
    return `${typeof code === "string" || typeof code === "number" ? `${code}: ` : ""}${truncate(baseMessage)}`;
  }
  if (error instanceof Error) {
    if (/proof|calldata|signed.?invocation|request\s*(body|payload)/i.test(error.message)) {
      return `${error.name}: sensitive request details suppressed`;
    }
    return truncate(error.message);
  }
  return "unknown operator error";
}

function truncate(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runOperator().catch((error: unknown) => {
    console.error(`Whisper operator failed: ${safeError(error)}`);
    process.exitCode = error instanceof OperatorCircuitBreakerError ? 78 : 1;
  });
}
