import { msg } from "gt-react";
import {
  compressRefusalMessage,
  compressRefusalReason,
  thrownErrorMessage,
} from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** T3's `/compress` and its Undo, for an environment that serves them. */
export function useThreadCompress(environmentId: EnvironmentId | null) {
  const compress = useAtomCommand(orchestrationEnvironment.compressThread, {
    reportFailure: false,
  });
  const undo = useAtomCommand(orchestrationEnvironment.undoThreadCompress, {
    reportFailure: false,
  });
  const permitted = useAtomValue(
    orchestrationEnvironment.compressThread.permissionAtom(environmentId),
  );
  const serverConfigs = useServerConfigs();
  const supported =
    environmentId !== null &&
    serverConfigs.get(environmentId)?.environment.capabilities.threadCompress === true;
  const canCompress = permitted && supported;

  /** Resolves true once the compress run started; refusals show a toast. */
  const compressThread = async (
    threadId: ThreadId,
    options: { readonly focus?: string; readonly onCompact?: () => void } = {},
  ): Promise<boolean> => {
    if (!canCompress || environmentId === null) return false;
    const focus = options.focus?.trim() ?? "";
    const result = await compress({
      environmentId,
      input: { threadId, trigger: "manual", ...(focus === "" ? {} : { focus }) },
    });
    if (result._tag === "Success") return true;
    if (isAtomCommandInterrupted(result)) return false;
    const error = squashAtomCommandFailure(result);
    const onCompact = options.onCompact;
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(msg("Could not compress context")),
        description: compressRefusalMessage(error, m) ?? thrownErrorMessage(error, m) ?? undefined,
        ...(compressRefusalReason(error) === "background-work" && onCompact !== undefined
          ? {
              actionProps: {
                children: m(msg("Compact instead")),
                onClick: () => {
                  toastManager.close(toastId);
                  onCompact();
                },
              },
            }
          : {}),
      }),
    );
    return false;
  };

  /** Starts an automatic compress ahead of a send; any refusal leaves the send unchanged. */
  const compressBeforeSend = async (threadId: ThreadId): Promise<boolean> => {
    if (!canCompress || environmentId === null) return false;
    const result = await compress({ environmentId, input: { threadId, trigger: "automatic" } });
    return result._tag === "Success";
  };

  const undoThreadCompress = async (threadId: ThreadId) => {
    if (!canCompress || environmentId === null) return;
    const result = await undo({ environmentId, input: { threadId } });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(msg("Could not undo the compress")),
        description: compressRefusalMessage(error, m) ?? thrownErrorMessage(error, m) ?? undefined,
      }),
    );
  };

  return { canCompress, compressThread, compressBeforeSend, undoThreadCompress };
}
