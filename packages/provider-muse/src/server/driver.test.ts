import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { MuseDriver } from "./driver.ts";
import { MuseSettings } from "../settings.ts";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("The driver test must not make an HTTP request")),
    ),
  ),
  Layer.provideMerge(ProviderLatestVersions.layer),
);

const settings = Schema.decodeSync(MuseSettings);

const catalogJson = JSON.stringify({
  skills: [
    {
      id: "engineer",
      name: "engineer",
      display_name: "engineer",
      description: "Start a new project with the engineering standard.",
      short_description: null,
      scope: "user",
      path: "$CONFIG_DIR/skills/engineer/SKILL.md",
      activation: "on",
    },
  ],
});

it.layer(layerTest)("MuseDriver", (it) => {
  it.effect("reports the skills Muse holds for a workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "muse-driver-workspace-" });
      const binaryPath = writeFakeCli({
        directory: workspace,
        name: "muse",
        source: [
          "const args = process.argv.slice(2);",
          'if (args[0] === "skills") {',
          `  process.stdout.write(${JSON.stringify(catalogJson)});`,
          "  process.exit(0);",
          "}",
          'process.stdout.write("muse 1.4.11-R6667.1\\n");',
        ].join("\n"),
      });
      const instance = yield* MuseDriver.create({
        instanceId: ProviderInstanceId.make("muse_driver_test"),
        displayName: undefined,
        environment: [],
        enabled: true,
        config: settings({ enabled: true, binaryPath }),
      });
      const snapshot = yield* instance.snapshotForCwd!(workspace);
      expect(snapshot.skills.map((skill) => [skill.name, skill.scope])).toEqual([
        ["engineer", "personal"],
      ]);
    }).pipe(Effect.scoped),
  );
});
