import { homedir } from "os";
import { join } from "path";
import { realpathSync, lstatSync } from "fs";

const HOME = homedir();
const SHORTABLE_DIRS = ["Documents"];

let _symlinkMap: Map<string, string> | null = null;

function getSymlinkMap(): Map<string, string> {
	if (_symlinkMap) return _symlinkMap;
	_symlinkMap = new Map();
	for (const dir of SHORTABLE_DIRS) {
		const logical = join(HOME, dir);
		try {
			const stat = lstatSync(logical);
			if (stat.isSymbolicLink()) {
				const real = realpathSync(logical);
				_symlinkMap.set(real, logical);
			}
		} catch { /* missing dir is fine */ }
	}
	return _symlinkMap;
}

export function displayPath(filePath: string): string {
	for (const [real, logical] of getSymlinkMap()) {
		if (filePath.startsWith(real + "/") || filePath === real) {
			filePath = logical + filePath.slice(real.length);
			break;
		}
	}
	if (filePath.startsWith(HOME + "/") || filePath === HOME) {
		filePath = "~" + filePath.slice(HOME.length);
	}
	return filePath;
}

export interface ToolConfig {
	id: string;
	name: string;
	color: string;
	icon: string;
	svg?: string;
	paths: SkillPath[];
	agentPaths: SkillPath[];
	projectPaths: ProjectSkillPath[];
	isInstalled: () => boolean;
}

export interface SkillPath {
	baseDir: string;
	type: SkillType;
	pattern: ScanPattern;
}

export interface ProjectSkillPath {
	relDir: string;
	type: SkillType;
	pattern: ScanPattern;
}

export type SkillType = "skill" | "command" | "agent" | "rule" | "memory";
export type ScanPattern = "directory-with-skillmd" | "flat-md" | "mdc" | "single-file" | "recursive-filename";

export type SkillScope = "global" | "project";

export interface ScanContext {
	scope: SkillScope;
	projectName?: string;
	projectDir?: string;
}

export interface ProjectPathEntry {
	path: string;
	depth: number;
}

export interface SkillItem {
	id: string;
	name: string;
	description: string;
	type: SkillType;
	tools: string[];
	scope: SkillScope;
	projectDir?: string;
	projectName?: string;
	filePath: string;
	realPath: string;
	dirPath: string;
	content: string;
	frontmatter: Record<string, unknown>;
	lastModified: number;
	fileSize: number;
	isFavorite: boolean;
	isDiscovered: boolean;
	collections: string[];
	usage?: {
		uses: number;
		lastUsed: string | null;
		daysSinceUsed: number | null;
		isStale: boolean;
		isHeavy: boolean;
		daily?: { date: string; count: number }[];
	};
	warnings?: {
		oversized: boolean;
		longDesc: boolean;
		lineCount: number;
		descChars: number;
	};
	conflicts?: { skillName: string; similarity: number }[];
	traces?: {
		traceId: string;
		timestamp: string;
		tokens: number;
		cost: number;
		duration: number;
		model: string;
	}[];
}

export type SidebarFilter =
	| { kind: "all" }
	| { kind: "favorites" }
	| { kind: "tool"; toolId: string }
	| { kind: "type"; type: SkillType }
	| { kind: "collection"; name: string }
	| { kind: "scope"; scope: SkillScope }
	| { kind: "project"; projectPath: string };

export type NamingMode = "auto" | "filename";

export interface ChopsSettings {
	tools: Record<string, { enabled: boolean; customPaths: string[] }>;
	watchEnabled: boolean;
	watchDebounceMs: number;
	deepSearchDefault: boolean;
	favorites: string[];
	collections: Record<string, string[]>;
	customScanPaths: string[];
	namingMode: NamingMode;
	projectPaths: ProjectPathEntry[];
	discoverSkills: boolean;
}

export const DEFAULT_SETTINGS: ChopsSettings = {
	tools: {},
	watchEnabled: true,
	watchDebounceMs: 500,
	deepSearchDefault: true,
	favorites: [],
	collections: {},
	customScanPaths: [],
	namingMode: "auto",
	projectPaths: [],
	discoverSkills: true,
};
