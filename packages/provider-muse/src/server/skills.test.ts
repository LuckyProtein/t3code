import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import {
  discoverMuseSkills,
  museSkillSelector,
  museSkillsToServerProviderSkills,
} from "./skills.ts";

const settings = Schema.decodeSync(MuseSettings);

const catalogRow = (extra: Record<string, unknown> = {}) => ({
  id: "engineer",
  name: "engineer",
  display_name: "engineer",
  description: "Start a new project with the engineering standard.",
  short_description: null,
  scope: "user",
  source: { type: "local" },
  path: "$CONFIG_DIR/skills/engineer/SKILL.md",
  activation: "on",
  diagnostics: [],
  provenance: null,
  context_cost: { startup_bytes: 1, startup_estimated_tokens: 1 },
  ...extra,
});

const fakeSkillsCli = (source: string, directory?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const target =
      directory ?? (yield* fs.makeTempDirectoryScoped({ prefix: "muse-skills-test-" }));
    return {
      binaryPath: writeFakeCli({ directory: target, name: "muse", source }),
      workspace: target,
    };
  });

describe("Muse skills", () => {
  it("reads the shortcut a skill is invoked by", () => {
    expect(museSkillSelector({ id: "bundled:blender", scope: "bundled" })).toBe("blender");
    expect(museSkillSelector({ id: "plugin:acme:deploy", scope: "plugin" })).toBe("acme:deploy");
    expect(museSkillSelector({ id: "engineer", scope: "user" })).toBe("engineer");
    expect(museSkillSelector({ id: "review", scope: "project" })).toBe("review");
  });

  it("maps Muse's catalog rows onto composer skills", () => {
    const skills = museSkillsToServerProviderSkills([
      catalogRow(),
      catalogRow({ id: "bundled:blender", scope: "bundled", name: "blender" }),
      catalogRow({
        id: "plugin:acme:deploy",
        scope: "plugin",
        name: "plugin:acme:deploy",
        path: "plugin://acme/skills/deploy/SKILL.md",
      }),
      catalogRow({ id: "review", scope: "project", path: ".agents/skills/review/SKILL.md" }),
    ]);
    expect(skills.map((skill) => [skill.name, skill.scope, skill.enabled])).toEqual([
      ["acme:deploy", "other", true],
      ["blender", "system", true],
      ["engineer", "personal", true],
      ["review", "project", true],
    ]);
    expect(skills[2]?.path).toBe("$CONFIG_DIR/skills/engineer/SKILL.md");
    expect(skills[2]?.description).toBe("Start a new project with the engineering standard.");
  });

  it("keeps a skill the user may start but the model may not out of the agent's reach", () => {
    const [skill] = museSkillsToServerProviderSkills([
      catalogRow({ activation: "userInvocableOnly" }),
    ]);
    expect(skill?.enabled).toBe(true);
    expect(skill?.userInvocationOnly).toBe(true);
    expect(skill?.userInvocable).toBeUndefined();
  });

  it("drops a skill Muse switched off", () => {
    const [skill] = museSkillsToServerProviderSkills([catalogRow({ activation: "off" })]);
    expect(skill?.enabled).toBe(false);
    expect(skill?.userInvocable).toBe(false);
  });

  it("summarizes a long description instead of shipping Muse's prose verbatim", () => {
    const [skill] = museSkillsToServerProviderSkills([
      catalogRow({ description: "word ".repeat(200) }),
    ]);
    expect(skill?.description?.length).toBeLessThanOrEqual(400);
    expect(skill?.description?.endsWith("...")).toBe(true);
  });

  it.effect("lists the skills Muse itself shows for a workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({
        prefix: "muse-skills-workspace-",
      });
      const { binaryPath } = yield* fakeSkillsCli(
        [
          "const args = process.argv.slice(2);",
          `const expected = ${JSON.stringify([
            "skills",
            "list",
            "--source",
            "all",
            "--json",
            "--trust-workspace",
            "--workspace",
            workspace,
          ])};`,
          "if (expected.some((value, index) => args[index] !== value)) {",
          '  process.stderr.write(`unexpected args: ${args.join(" ")}\\n`);',
          "  process.exit(11);",
          "}",
          `process.stdout.write(JSON.stringify({ skills: [${JSON.stringify(catalogRow())}] }));`,
        ].join("\n"),
        workspace,
      );
      const skills = yield* discoverMuseSkills(
        settings({ enabled: true, binaryPath }),
        undefined,
        workspace,
      );
      expect(skills.map((skill) => skill.name)).toEqual(["engineer"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports no skills when Muse cannot list them", () =>
    Effect.gen(function* () {
      const { binaryPath, workspace } = yield* fakeSkillsCli("process.exit(2);");
      const skills = yield* discoverMuseSkills(
        settings({ enabled: true, binaryPath }),
        undefined,
        workspace,
      );
      expect(skills).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports no skills when the catalog cannot be read", () =>
    Effect.gen(function* () {
      const { binaryPath, workspace } = yield* fakeSkillsCli('process.stdout.write("not json");');
      const skills = yield* discoverMuseSkills(
        settings({ enabled: true, binaryPath }),
        undefined,
        workspace,
      );
      expect(skills).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not run Muse for a disabled provider", () =>
    Effect.gen(function* () {
      const skills = yield* discoverMuseSkills(settings({ enabled: false }), {}, "/work");
      expect(skills).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
