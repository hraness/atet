export type SkillTarget = "codex" | "claude" | "agents";
export type SkillScope = "user" | "project";
export declare function bundledSkillPath(): string;
export declare function installSkill(options: {
    readonly target: SkillTarget;
    readonly scope: SkillScope;
    readonly projectDirectory?: string;
    readonly force?: boolean;
}): Promise<string>;
