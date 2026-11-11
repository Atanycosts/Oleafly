import { invoke } from "@tauri-apps/api/core";
import { base64ToBytes, bytesToBase64 } from "@/lib/base64";

export interface DocxRecoveryIdentity {
  appProjectId: string;
  workbenchProjectId: string;
  baseBaselineId: string;
  sourceSha256: string;
}

export interface DocxRecoveryMetadata extends DocxRecoveryIdentity {
  recoveryKey: string;
  revision: number;
  updatedAt: string;
  contentSha256: string;
}

export interface DocxRecoverySnapshot extends DocxRecoveryMetadata {
  bytes: Uint8Array;
}

interface StoredDocxRecoverySnapshot extends DocxRecoveryMetadata {
  bytesBase64: string;
}

interface SaveRequest extends DocxRecoveryIdentity {
  recoveryKey: string;
  revision: number;
  updatedAt: string;
  contentBase64: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(source).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function docxRecoveryKey(identity: DocxRecoveryIdentity): Promise<string> {
  const stableIdentity = [
    identity.appProjectId,
    identity.workbenchProjectId,
    identity.baseBaselineId,
    identity.sourceSha256,
  ].map((value) => {
    const bytes = new TextEncoder().encode(value);
    return `${bytes.length}:${value}`;
  }).join("\n");
  return sha256Hex(new TextEncoder().encode(stableIdentity));
}

export async function saveDocxRecovery(
  identity: DocxRecoveryIdentity,
  revision: number,
  bytes: ArrayBuffer,
): Promise<DocxRecoveryMetadata> {
  const content = new Uint8Array(bytes);
  const request: SaveRequest = {
    ...identity,
    recoveryKey: await docxRecoveryKey(identity),
    revision,
    updatedAt: new Date().toISOString(),
    contentBase64: bytesToBase64(content),
  };
  return invoke<DocxRecoveryMetadata>("docx_recovery_save", { request });
}

export async function readDocxRecovery(identity: DocxRecoveryIdentity): Promise<DocxRecoverySnapshot | null> {
  const recoveryKey = await docxRecoveryKey(identity);
  const stored = await invoke<StoredDocxRecoverySnapshot | null>("docx_recovery_read", {
    request: { recoveryKey },
  });
  if (!stored) return null;
  const { bytesBase64, ...metadata } = stored;
  return { ...metadata, bytes: base64ToBytes(bytesBase64) };
}

export async function clearDocxRecovery(
  identity: DocxRecoveryIdentity,
  committedBytes: ArrayBuffer | Uint8Array,
): Promise<boolean> {
  const recoveryKey = await docxRecoveryKey(identity);
  const content = committedBytes instanceof Uint8Array ? committedBytes : new Uint8Array(committedBytes);
  const contentSha256 = await sha256Hex(content);
  return invoke<boolean>("docx_recovery_clear", {
    request: { recoveryKey, contentSha256 },
  });
}
