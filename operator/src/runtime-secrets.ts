import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { OperatorRuntimeConfig } from "./config.ts";

export interface OperatorSecretMaterial {
  vaultPrivateKey: string;
  relayerAddress: string;
  relayerPrivateKey: string;
  vaultViewingPrivateKey: string;
  capsuleRevealPrivateKey: string;
}

/** Load local operator credentials without copying them into runtime configuration or logs. */
export function loadOperatorSecretMaterial(
  environment: Readonly<Record<string, string | undefined>>,
  config: OperatorRuntimeConfig,
): OperatorSecretMaterial {
  const accountPath = requiredSecretPath(environment, "WHISPER_ACCOUNT_FILE");
  const operatorPath = requiredSecretPath(environment, "WHISPER_OPERATOR_SECRETS_FILE");
  const accounts = readSecretJson(accountPath);
  const operator = readSecretJson(operatorPath);

  const accountNetwork =
    nonEmpty(environment.WHISPER_ACCOUNT_NETWORK) ??
    (environment.WHISPER_NETWORK === "sepolia" ? "alpha-sepolia" : undefined);
  if (accountNetwork === undefined) {
    throw new Error("WHISPER_ACCOUNT_NETWORK is required");
  }
  const vaultAccountName =
    nonEmpty(environment.WHISPER_VAULT_ACCOUNT_NAME) ??
    (environment.WHISPER_NETWORK === "sepolia" ? "whisper_sepolia_vault" : undefined);
  const relayerAccountName =
    nonEmpty(environment.WHISPER_RELAYER_ACCOUNT_NAME) ??
    (environment.WHISPER_NETWORK === "sepolia" ? "whisper_sepolia_relayer" : undefined);
  if (vaultAccountName === undefined || relayerAccountName === undefined) {
    throw new Error("vault and relayer account names are required");
  }

  const networkAccounts = requiredRecord(accounts, accountNetwork);
  const vaultAccount = requiredRecord(networkAccounts, vaultAccountName);
  const relayerAccount = requiredRecord(networkAccounts, relayerAccountName);
  assertFeltMatches("vault account address", requiredString(vaultAccount, "address"), config.vaultAddress);
  assertFeltMatches(
    "relayer account address",
    requiredString(relayerAccount, "address"),
    requiredString(operator, "relayer_address"),
  );
  assertFeltMatches("operator vault address", requiredString(operator, "vault_address"), config.vaultAddress);
  assertFeltMatches(
    "operator vault public key",
    requiredString(operator, "vault_viewing_public_key"),
    config.vaultPublicKey,
  );
  assertFeltMatches(
    "operator reveal public key",
    requiredString(operator, "capsule_reveal_public_key"),
    config.revealPublicKey,
  );
  assertFeltMatches(
    "operator Whisper address",
    requiredString(operator, "whisper_address"),
    config.whisperAddress,
  );

  return {
    vaultPrivateKey: requiredString(vaultAccount, "private_key"),
    relayerAddress: requiredString(operator, "relayer_address"),
    relayerPrivateKey: requiredString(relayerAccount, "private_key"),
    vaultViewingPrivateKey: requiredString(operator, "vault_viewing_private_key"),
    capsuleRevealPrivateKey: requiredString(operator, "capsule_reveal_private_key"),
  };
}

function requiredSecretPath(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = nonEmpty(environment[name]);
  if (value === undefined) throw new Error(`${name} is required`);
  if (value === "~") return homedir();
  return resolve(value.startsWith("~/") ? `${homedir()}/${value.slice(2)}` : value);
}

function readSecretJson(path: string): Record<string, unknown> {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("operator secret path must be a regular file");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("operator secret files must be owner-only (0600)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("operator secret file is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("operator secret file must contain an object");
  return parsed;
}

function requiredRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const record = value[key];
  if (!isRecord(record)) throw new Error(`operator secret field ${key} is missing`);
  return record;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`operator secret field ${key} is missing`);
  }
  return field;
}

function assertFeltMatches(name: string, actual: string, expected: string | bigint): void {
  try {
    if (BigInt(actual) === BigInt(expected)) return;
  } catch {
    // Fall through to the non-sensitive mismatch error.
  }
  throw new Error(`${name} does not match runtime configuration`);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
