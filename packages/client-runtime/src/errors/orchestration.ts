import {
  OrchestrationDispatchCommandError,
  OrchestrationV2CompressThreadError,
  type OrchestrationV2CompressRefusal,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isCompressThreadError = Schema.is(OrchestrationV2CompressThreadError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

export function wasBootstrapThreadNotCreated(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "not-created"
  );
}

/** Why the server refused a compress or its undo; undefined for any other failure. */
export function compressRefusalReason(error: unknown): OrchestrationV2CompressRefusal | undefined {
  return isCompressThreadError(error) ? error.reason : undefined;
}

const COMPRESS_REFUSAL_MESSAGES = {
  busy: msg("This thread has a turn in progress; /compress runs only when the thread is idle."),
  "background-work": msg(
    "The current session is still running background agents or commands, and a fresh session would end them. Wait for them to finish, or use /compact instead.",
  ),
  "transfer-pending": msg(
    "A fork or merge is still being applied to this thread; send a message first.",
  ),
  unsupported: msg("/compress is available only on Claude threads."),
  "nothing-to-compress": msg("There is nothing to compress since the last fresh session."),
  "not-due": msg("This thread does not need compressing yet."),
  "not-undoable": msg("This compress can no longer be undone."),
} satisfies Record<OrchestrationV2CompressRefusal, string>;

/** The refusal in the active language, or null when the failure is not a refusal. */
export function compressRefusalMessage(
  error: unknown,
  resolve: MFunctionType = mFallback,
): string | null {
  const reason = compressRefusalReason(error);
  return reason === undefined ? null : resolve(COMPRESS_REFUSAL_MESSAGES[reason]);
}
