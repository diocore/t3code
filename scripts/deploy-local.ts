#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const SERVER_LAUNCHD_LABEL = "dev.pras.t3code";
const DESKTOP_APP_NAME = "T3 Code (Beta)";
const INSTALLED_DESKTOP_APP = `/Applications/${DESKTOP_APP_NAME}.app`;

export class DeployCommandFailedError extends Schema.TaggedError<DeployCommandFailedError>()(
  "DeployCommandFailedError",
  { command: Schema.String, exitCode: Schema.Int },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

const run = Effect.fn("deploy.run")(function* (command: string, args: ReadonlyArray<string>) {
  yield* Effect.scoped(spawnToCompletion(command, args));
});

const spawnToCompletion = Effect.fn("deploy.spawnToCompletion")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, [...args], { stdout: "inherit", stderr: "inherit" }),
  );
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* new DeployCommandFailedError({
      command: [command, ...args].join(" "),
      exitCode,
    });
  }
});

const capture = Effect.fn("deploy.capture")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make(command, [...args]));
});

const pull = Effect.fn("deploy.pull")(function* () {
  yield* run("git", ["pull", "--ff-only", "origin", "main"]);
});

const buildServer = run("vp", ["run", "--filter", "./apps/server", "build"]);
const buildWeb = run("vp", ["run", "--filter", "./apps/web", "build"]);

const restartServer = Effect.fn("deploy.restartServer")(function* () {
  const uid = (yield* capture("id", ["-u"])).trim();
  yield* run("launchctl", ["kickstart", "-k", `gui/${uid}/${SERVER_LAUNCHD_LABEL}`]);
});

const installDesktopApp = Effect.fn("deploy.installDesktopApp")(function* () {
  const path = yield* Path.Path;
  const builtApp = path.join(process.cwd(), "release/mac-arm64", `${DESKTOP_APP_NAME}.app`);
  yield* run("osascript", ["-e", `tell application "${DESKTOP_APP_NAME}" to quit`]);
  yield* run("ditto", [builtApp, INSTALLED_DESKTOP_APP]);
  yield* run("open", [INSTALLED_DESKTOP_APP]);
});

const confirmRestart = Flag.Boolean("yes").pipe(
  Flag.withDescription("Restart without the reminder that this ends running threads."),
  Flag.withDefault(false),
);

const backend = Command.make("backend", { yes: confirmRestart }, ({ yes }) =>
  Effect.gen(function* () {
    if (!yes) {
      return yield* Effect.fail(
        new DeployCommandFailedError({
          command: "deploy-local backend",
          exitCode: 2,
        }),
      ).pipe(
        Effect.tapError(() =>
          Effect.logError(
            "Restarting the server ends every running thread, including this one. Re-run with --yes.",
          ),
        ),
      );
    }
    yield* pull();
    yield* buildServer;
    yield* restartServer();
  }),
).pipe(Command.withDescription("Pull main, build the server, restart it via launchd."));

const frontend = Command.make("frontend", {}, () =>
  Effect.gen(function* () {
    yield* pull();
    yield* buildWeb;
    yield* buildServer;
  }),
).pipe(
  Command.withDescription(
    "Pull main, build the web client and bundle it into the server's dist/client. No restart.",
  ),
);

const app = Command.make("app", {}, () =>
  Effect.gen(function* () {
    yield* pull();
    yield* run("vp", ["run", "dist:desktop:dmg:arm64"]);
    yield* installDesktopApp();
  }),
).pipe(
  Command.withDescription(
    `Pull main, package the desktop app, replace ${INSTALLED_DESKTOP_APP} and relaunch it.`,
  ),
);

const command = Command.make("deploy-local").pipe(
  Command.withDescription("Deploy this checkout to the local T3 Code install."),
  Command.withSubcommands([backend, frontend, app]),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
