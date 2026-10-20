/**
 * Muse Code keeps its Agent Skills in a store of its own, but it reads the
 * standard roots as well: `~/.agents/skills` and `<workspace>/.agents/skills`.
 * MSP's `skill/list` is scoped to a live session, and the composer needs the
 * catalog before a session exists, so discovery reads the same catalog the
 * Muse CLI shows through `muse skills list`.
 */

import { type ServerProviderSkill } from "@t3tools/contracts";
import { MuseSettings } from "../settings.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";

import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { makeMuseEnvironment } from "./sdk.ts";

/** One row of `muse skills list --json`. */
const MuseSkillEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  short_description: Schema.optional(Schema.NullOr(Schema.String)),
  scope: Schema.String,
  path: Schema.optional(Schema.NullOr(Schema.String)),
  activation: Schema.optional(Schema.NullOr(Schema.String)),
});
export type MuseSkillEntry = typeof MuseSkillEntry.Type;

const MuseSkillCatalog = Schema.Struct({ skills: Schema.Array(MuseSkillEntry) });

const decodeMuseSkillCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(MuseSkillCatalog));

/** The catalog is a read of the CLI, so a slow host must not stall the composer. */
const MUSE_SKILLS_TIMEOUT_MS = 10_000;

/**
 * Muse prefixes bundled and plugin ids with their scope (`bundled:blender`,
 * `plugin:acme:deploy`). The bare id is the shortcut `skill/list` accepts and
 * the token the composer inserts, so it is the name T3 shows.
 */
export function museSkillSelector(entry: MuseSkillEntry): string {
  const id = entry.id.trim();
  const prefix = `${entry.scope.trim()}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** T3's scope vocabulary, which the composer renders as a badge. */
const MUSE_SKILL_SCOPES: Record<string, string> = {
  user: "personal",
  project: "project",
  bundled: "system",
  plugin: "other",
};

/** Muse's bundled skills carry paragraphs of prose; the composer shows a summary. */
const MAX_SKILL_DESCRIPTION_LENGTH = 400;

function summarizeSkillDescription(description: string): string {
  const collapsed = description.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= MAX_SKILL_DESCRIPTION_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_SKILL_DESCRIPTION_LENGTH - 3).trimEnd()}...`;
}

export function museSkillsToServerProviderSkills(
  entries: ReadonlyArray<MuseSkillEntry>,
): ReadonlyArray<ServerProviderSkill> {
  const skills: ServerProviderSkill[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = museSkillSelector(entry);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    // Muse's activation is three-state: `on`, `userInvocableOnly` (the model
    // may not start it, the user may) and `off`.
    const activation = entry.activation?.trim().toLowerCase() ?? "on";
    const enabled = activation !== "off";
    const description = entry.description?.trim();
    const shortDescription = entry.short_description?.trim();
    const displayName = entry.display_name?.trim();
    const path = entry.path?.trim() || name;
    skills.push({
      name,
      path,
      enabled,
      scope: MUSE_SKILL_SCOPES[entry.scope.trim().toLowerCase()] ?? "other",
      ...(displayName && displayName !== name ? { displayName } : {}),
      ...(description ? { description: summarizeSkillDescription(description) } : {}),
      ...(shortDescription
        ? { shortDescription: summarizeSkillDescription(shortDescription) }
        : {}),
      ...(activation === "userinvocableonly" ? { userInvocationOnly: true } : {}),
      ...(enabled ? {} : { userInvocable: false }),
    });
  }
  return skills.toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * Reads the skill catalog Muse itself shows. A Muse that cannot list its
 * skills leaves the composer without them, which is the state T3 Code had
 * before, so a failed read is not a provider failure.
 */
export const discoverMuseSkills = Effect.fn("discoverMuseSkills")(function* (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv | undefined,
  cwd?: string,
) {
  if (!settings.enabled) return [];
  const museEnvironment = environment ?? makeMuseEnvironment();
  // Muse leaves the project scope out of the catalog for an untrusted
  // workspace, and T3 runs Muse sessions with the workspace trusted.
  const args = ["skills", "list", "--source", "all", "--json", "--trust-workspace"];
  if (cwd) args.push("--workspace", cwd);
  const listed = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, args, {
      env: museEnvironment,
    });
    return yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: museEnvironment,
        shell: spawnCommand.shell,
        ...(cwd ? { cwd } : {}),
      }),
    );
  }).pipe(Effect.timeoutOption(MUSE_SKILLS_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(listed)) return [];
  const output = Option.getOrElse(listed.success, () => null);
  if (!output || output.code !== 0) return [];
  const catalog = yield* decodeMuseSkillCatalog(output.stdout).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (!catalog) return [];
  return museSkillsToServerProviderSkills(catalog.skills);
});
