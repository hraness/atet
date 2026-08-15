// @bun
// src/skill-install.ts
import { cp, mkdir, rm } from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

// src/fs.ts
import { access } from "fs/promises";
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// src/skill-install.ts
function bundledSkillPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../skills/atet");
}
function targetRoot(target, scope, projectDirectory) {
  const directory = target === "codex" ? ".codex" : target === "claude" ? ".claude" : ".agents";
  return scope === "user" ? join(homedir(), directory, "skills") : join(projectDirectory, directory, "skills");
}
async function installSkill(options) {
  const source = bundledSkillPath();
  if (!await pathExists(source))
    throw new Error(`Bundled skill is missing: ${source}`);
  const root = targetRoot(options.target, options.scope, resolve(options.projectDirectory ?? process.cwd()));
  const legacy = join(root, "diagram");
  if (await pathExists(legacy)) {
    throw new Error(`Legacy diagram skill found at ${legacy}. Remove or move that directory, then rerun "atet skill install --target ${options.target} --scope ${options.scope}". Atet will not install both skills side by side.`);
  }
  const destination = join(root, "atet");
  if (await pathExists(destination)) {
    if (!options.force) {
      throw new Error(`Skill already exists at ${destination}; pass --force to replace it`);
    }
    await rm(destination, { recursive: true, force: true });
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true });
  return destination;
}

export { pathExists, bundledSkillPath, installSkill };
