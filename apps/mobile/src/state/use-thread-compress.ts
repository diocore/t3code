import { useAtomValue } from "@effect/atom-react";
import { compressRefusalMessage, compressRefusalReason } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import * as Dialog from "../components/ui/Dialog";
import { m } from "../i18n/messages";
import { orchestrationEnvironment } from "./orchestration";
import { useAtomCommand } from "./use-atom-command";

/** T3's `/compress` and its Undo, for an environment that serves them. */
export function useThreadCompress(input: {
  readonly environmentId: EnvironmentId | null;
  readonly supported: boolean;
}) {
  const compress = useAtomCommand(orchestrationEnvironment.compressThread, {
    reportFailure: false,
  });
  const undo = useAtomCommand(orchestrationEnvironment.undoThreadCompress, {
    reportFailure: false,
  });
  const permitted = useAtomValue(
    orchestrationEnvironment.compressThread.permissionAtom(input.environmentId),
  );
  const canCompress = input.environmentId !== null && input.supported && permitted;

  const compressThread = async (
    threadId: ThreadId,
    options: { readonly focus: string; readonly onCompact: () => void },
  ) => {
    if (!canCompress || input.environmentId === null) return;
    const focus = options.focus.trim();
    const result = await compress({
      environmentId: input.environmentId,
      input: {
        threadId,
        trigger: "manual",
        creationSource: "mobile",
        ...(focus === "" ? {} : { focus }),
      },
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    const title = m(msg("Could not compress context"));
    const message =
      compressRefusalMessage(error, m) ?? m(msg("The thread could not be compressed."));
    if (compressRefusalReason(error) === "background-work") {
      Dialog.confirm({
        title,
        message,
        confirmText: m(msg("Compact instead")),
        onConfirm: options.onCompact,
      });
      return;
    }
    Dialog.alert(title, message);
  };

  const undoThreadCompress = async (threadId: ThreadId) => {
    if (!canCompress || input.environmentId === null) return;
    const result = await undo({ environmentId: input.environmentId, input: { threadId } });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    Dialog.alert(
      m(msg("Could not undo the compress")),
      compressRefusalMessage(error, m) ?? m(msg("The compress could not be undone.")),
    );
  };

  return { canCompress, compressThread, undoThreadCompress };
}
