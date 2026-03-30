import { readdir, readFile, stat as fsStat, realpath as fsRealpath } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { join, basename, dirname, extname } from "path";
import { homedir } from "os";
import { parseYaml } from "obsidian";
import { createHash } from "crypto";
import { TOOL_CONFIGS } from "./tool-configs";
import type { SkillItem, SkillPath, SkillType, NamingMode, ScanPattern, ScanContext, ChopsSettings, ProjectPathEntry } from "./types";

const IGNORED_FILES = new Set([
	"readme.md",
	"license",
	"license.md",
	"changelog.md",
	".ds_store",
	"thumbs.db",
]);

const GLOBAL_CTX: ScanContext = { scope: "global" };

function hashPath(p: string): string {
	return createHash("sha256").update(p).digest("hex").slice(0, 12);
}

async function exists(p: string): Promise<boolean> {
	try { await fsStat(p); return true; } catch { return false; }
}

function parseFrontmatter(raw: string): {
	frontmatter: Record<string, unknown>;
	content: string;
} {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {}, content: raw };
	}
	try {
		const parsed = parseYaml(match[1]);
		return {
			frontmatter: typeof parsed === "object" && parsed ? parsed : {},
			content: match[2],
		};
	} catch { /* empty */
		return { frontmatter: {}, content: raw };
	}
}

function extractName(
	frontmatter: Record<string, unknown>,
	content: string,
	filePath: string,
	namingMode: NamingMode = "auto"
): string {
	if (namingMode === "auto") {
		if (typeof frontmatter.name === "string" && frontmatter.name) {
			return frontmatter.name;
		}
		const h1 = content.match(/^#\s+(.+)$/m);
		if (h1) return h1[1].trim();
	}
	// shared fallback for both modes
	const name = basename(filePath, extname(filePath));
	if (name === "SKILL") return basename(join(filePath, ".."));
	return name;
}

async function scanDirectoryWithSkillMd(
	baseDir: string,
	type: SkillType,
	toolId: string,
	ctx: ScanContext = GLOBAL_CTX,
	namingMode: NamingMode = "auto"
): Promise<SkillItem[]> {
	let entries;
	try { entries = await readdir(baseDir, { withFileTypes: true }); } catch { return []; }
	const items: SkillItem[] = [];

	for (const entry of entries) {
		const fullPath = join(baseDir, entry.name);
		let isDir = entry.isDirectory();
		if (!isDir && entry.isSymbolicLink()) {
			try { isDir = (await fsStat(fullPath)).isDirectory(); } catch { continue; }
		}
		if (!isDir) continue;
		const skillFile = join(fullPath, "SKILL.md");
		if (!(await exists(skillFile))) continue;

		const item = await parseSkillFile(skillFile, type, toolId, "directory-with-skillmd", ctx, namingMode);
		if (item) items.push(item);
	}
	return items;
}

async function scanFlatMd(
	baseDir: string,
	type: SkillType,
	toolId: string,
	ctx: ScanContext = GLOBAL_CTX,
	namingMode: NamingMode = "auto"
): Promise<SkillItem[]> {
	let entries;
	try { entries = await readdir(baseDir, { withFileTypes: true }); } catch { return []; }
	const items: SkillItem[] = [];

	for (const entry of entries) {
		const fullPath = join(baseDir, entry.name);
		let isDir = entry.isDirectory();
		if (!isDir && entry.isSymbolicLink()) {
			try { isDir = (await fsStat(fullPath)).isDirectory(); } catch { continue; }
		}
		if (isDir) {
			const skillFile = join(fullPath, "SKILL.md");
			if (await exists(skillFile)) {
				const item = await parseSkillFile(skillFile, type, toolId, "flat-md", ctx, namingMode);
				if (item) items.push(item);
				continue;
			}
			let subEntries: string[];
			try { subEntries = await readdir(fullPath); } catch { continue; }
			const mdFiles = subEntries.filter(
				(f) => f.endsWith(".md") && !IGNORED_FILES.has(f.toLowerCase())
			);
			const preferred =
				mdFiles.find(
					(f) => f.toLowerCase() === `${entry.name.toLowerCase()}.md`
				) || mdFiles[0];
			if (preferred) {
				const item = await parseSkillFile(
					join(fullPath, preferred),
					type,
					toolId,
					"flat-md",
					ctx,
					namingMode
				);
				if (item) items.push(item);
			}
			continue;
		}

		const fname = entry.name.toLowerCase();
		if (!fname.endsWith(".md") || IGNORED_FILES.has(fname)) continue;
		const item = await parseSkillFile(join(baseDir, entry.name), type, toolId, "flat-md", ctx, namingMode);
		if (item) items.push(item);
	}
	return items;
}

async function scanMdc(
	baseDir: string,
	type: SkillType,
	toolId: string,
	ctx: ScanContext = GLOBAL_CTX,
	namingMode: NamingMode = "auto"
): Promise<SkillItem[]> {
	let entries;
	try { entries = await readdir(baseDir, { withFileTypes: true }); } catch { return []; }
	const items: SkillItem[] = [];

	for (const entry of entries) {
		if (!entry.name.endsWith(".mdc") && !entry.name.endsWith(".md")) continue;
		if (entry.isDirectory()) continue;
		const item = await parseSkillFile(join(baseDir, entry.name), type, toolId, "mdc", ctx, namingMode);
		if (item) items.push(item);
	}
	return items;
}

async function scanSingleFile(
	filePath: string,
	type: SkillType,
	toolId: string,
	ctx: ScanContext = GLOBAL_CTX
): Promise<SkillItem[]> {
	if (!(await exists(filePath))) return [];
	const item = await parseSkillFile(filePath, type, toolId, "single-file", ctx);
	return item ? [item] : [];
}

const IGNORED_DIRS = new Set([
	"node_modules", ".git", ".hg", ".svn", "dist", "build", ".next",
	".nuxt", ".output", "coverage", "__pycache__", ".venv", "venv",
	".tox", ".mypy_cache", ".pytest_cache", "vendor", "target",
	".gradle", ".idea", ".vscode",
]);

async function scanRecursiveFilename(
	projectRoot: string,
	filename: string,
	type: SkillType,
	toolId: string,
	ctx: ScanContext = GLOBAL_CTX
): Promise<SkillItem[]> {
	const items: SkillItem[] = [];

	async function walk(dir: string, currentName: string, currentDir: string): Promise<void> {
		let entries;
		try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
				const child = join(dir, entry.name);
				if (await exists(join(child, ".git"))) {
					const nestedName = basename(child);
					const nestedFile = join(child, filename);
					if (await exists(nestedFile)) {
						const item = await parseSkillFile(
							nestedFile, type, toolId, "recursive-filename",
							{ scope: ctx.scope, projectName: nestedName, projectDir: child }
						);
						if (item) items.push(item);
					}
					await walk(child, nestedName, child);
				} else {
					await walk(child, currentName, currentDir);
				}
				continue;
			}
			if (entry.name === filename) {
				const item = await parseSkillFile(
					join(dir, entry.name), type, toolId, "recursive-filename",
					{ scope: ctx.scope, projectName: currentName, projectDir: currentDir }
				);
				if (item) items.push(item);
			}
		}
	}

	const rootFile = join(projectRoot, filename);
	if (await exists(rootFile)) {
		const item = await parseSkillFile(rootFile, type, toolId, "recursive-filename", ctx);
		if (item) items.push(item);
	}

	let entries;
	try { entries = await readdir(projectRoot, { withFileTypes: true }); } catch { return items; }
	for (const entry of entries) {
		if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
		const child = join(projectRoot, entry.name);
		if (await exists(join(child, ".git"))) {
			const nestedName = basename(child);
			const nestedFile = join(child, filename);
			if (await exists(nestedFile)) {
				const item = await parseSkillFile(
					nestedFile, type, toolId, "recursive-filename",
					{ scope: ctx.scope, projectName: nestedName, projectDir: child }
				);
				if (item) items.push(item);
			}
			await walk(child, nestedName, child);
		} else {
			await walk(child, ctx.projectName || "", ctx.projectDir || "");
		}
	}

	return items;
}

async function discoverSkillFiles(
	projectDirs: string[],
	projectDisplayNames: Map<string, string>,
	existingIds: Set<string>,
	namingMode: NamingMode = "auto"
): Promise<SkillItem[]> {
	const items: SkillItem[] = [];
	const seen = new Set<string>();

	async function walk(dir: string, projDir: string, projName: string): Promise<void> {
		let entries;
		try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (IGNORED_DIRS.has(entry.name)) continue;
				await walk(join(dir, entry.name), projDir, projName);
				continue;
			}
			if (entry.name !== "SKILL.md") continue;
			const filePath = join(dir, entry.name);
			let realPath: string;
			try { realPath = await fsRealpath(filePath); } catch { realPath = filePath; }
			const id = hashPath(realPath);
			if (existingIds.has(id) || seen.has(id)) continue;
			seen.add(id);

			const ctx: ScanContext = { scope: "project", projectName: projName, projectDir: projDir };
			const item = await parseSkillFile(filePath, "skill", "discovered", "directory-with-skillmd", ctx, namingMode);
			if (item) {
				item.isDiscovered = true;
				items.push(item);
			}
		}
	}

	for (const projDir of projectDirs) {
		const projName = projectDisplayNames.get(projDir) || basename(projDir);
		await walk(projDir, projDir, projName);
	}
	return items;
}

async function parseSkillFile(
	filePath: string,
	type: SkillType,
	toolId: string,
	pattern: ScanPattern = "directory-with-skillmd",
	ctx: ScanContext = GLOBAL_CTX,
	namingMode: NamingMode = "auto"
): Promise<SkillItem | null> {
	try {
		const raw = await readFile(filePath, "utf-8");
		const fileStat = await fsStat(filePath);
		const { frontmatter, content } = parseFrontmatter(raw);
		let name = extractName(frontmatter, content, filePath, namingMode);

		// For project-scoped root files, use the actual filename.
		// For nested instances (e.g. src/api/CLAUDE.md), show relative path.
		if (ctx.scope === "project" && ctx.projectDir) {
			const fname = basename(filePath);
			const rootFiles = ["CLAUDE.md", ".cursorrules", ".windsurfrules", ".aider.conf.yml", "codex.md", "copilot-instructions.md"];
			if (rootFiles.includes(fname)) {
				const fileDir = dirname(filePath);
				if (fileDir === ctx.projectDir) {
					name = fname;
				} else {
					name = filePath.slice(ctx.projectDir.length + 1);
				}
			}
		}

		const description =
			typeof frontmatter.description === "string"
				? frontmatter.description
				: "";

		let realPath: string;
		try {
			realPath = await fsRealpath(filePath);
		} catch { /* empty */
			realPath = filePath;
		}

		return {
			id: hashPath(realPath),
			name,
			description,
			type,
			tools: [toolId],
			scope: ctx.scope,
			projectDir: ctx.projectDir,
			projectName: ctx.projectName,
			filePath,
			realPath,
			dirPath: join(filePath, ".."),
			content: raw,
			frontmatter,
			lastModified: fileStat.mtimeMs,
			fileSize: fileStat.size,
			isFavorite: false,
			isDiscovered: false,
			collections: [],
		};
	} catch { /* empty */
		return null;
	}
}

async function scanPath(
	sp: SkillPath,
	toolId: string,
	ctx: ScanContext = GLOBAL_CTX,
	namingMode: NamingMode = "auto"
): Promise<SkillItem[]> {
	switch (sp.pattern) {
		case "directory-with-skillmd":
			return scanDirectoryWithSkillMd(sp.baseDir, sp.type, toolId, ctx, namingMode);
		case "flat-md":
			return scanFlatMd(sp.baseDir, sp.type, toolId, ctx, namingMode);
		case "mdc":
			return scanMdc(sp.baseDir, sp.type, toolId, ctx, namingMode);
		case "single-file":
			return scanSingleFile(sp.baseDir, sp.type, toolId, ctx);
		case "recursive-filename":
			return scanRecursiveFilename(
				dirname(sp.baseDir), basename(sp.baseDir),
				sp.type, toolId, ctx
			);
	}
}

const PROJECT_MARKERS = [".git", ".claude", ".cursor", ".windsurf", ".codex", ".github", ".amp"];

async function isProjectDir(dir: string): Promise<boolean> {
	const results = await Promise.all(PROJECT_MARKERS.map(m => exists(join(dir, m))));
	return results.some(Boolean);
}

const MAX_SCAN_DEPTH = 10;

async function findProjectDirs(dir: string, remainingDepth: number, results: string[]): Promise<void> {
	if (!(await exists(dir))) return;

	// depth -1 means unlimited; cap at MAX_SCAN_DEPTH to prevent runaway recursion
	const unlimited = remainingDepth < 0;
	if (!unlimited && remainingDepth === 0) {
		if (await isProjectDir(dir)) results.push(dir);
		return;
	}

	const effectiveDepth = unlimited ? MAX_SCAN_DEPTH : remainingDepth;

	const countBefore = results.length;
	let entries;
	try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (IGNORED_DIRS.has(entry.name)) continue;
		const child = join(dir, entry.name);
		if (await isProjectDir(child)) {
			results.push(child);
			// Continue recursing into project dirs to find nested projects
			if (unlimited || effectiveDepth > 1) {
				await findProjectDirs(child, unlimited ? -1 : effectiveDepth - 1, results);
			}
		} else if (unlimited || effectiveDepth > 1) {
			await findProjectDirs(child, unlimited ? -1 : effectiveDepth - 1, results);
		}
	}
	const foundChildren = results.length > countBefore;

	if (!foundChildren && await isProjectDir(dir)) {
		results.push(dir);
	}
}

function resolvePath(p: string): string {
	if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
	return p;
}

async function resolveProjectDirs(configuredPaths: ProjectPathEntry[]): Promise<string[]> {
	const dirs: string[] = [];
	for (const entry of configuredPaths) {
		await findProjectDirs(resolvePath(entry.path), entry.depth, dirs);
	}
	return dirs;
}

export async function scanAll(settings: ChopsSettings): Promise<Map<string, SkillItem>> {
	const namingMode = settings.namingMode || "auto";
	const items = new Map<string, SkillItem>();

	function addItem(item: SkillItem, toolId: string): void {
		const existing = items.get(item.id);
		if (existing) {
			if (!existing.tools.includes(toolId)) {
				existing.tools.push(toolId);
			}
			return;
		}

		item.isFavorite = settings.favorites.includes(item.id);
		for (const [colName, colIds] of Object.entries(settings.collections)) {
			if (colIds.includes(item.id)) {
				item.collections.push(colName);
			}
		}
		items.set(item.id, item);
	}

	// Resolve configured project directories
	const projectDirs = await resolveProjectDirs(settings.projectPaths);

	// Disambiguate duplicate project folder names by prefixing with parent
	const projectDisplayNames = new Map<string, string>();
	const nameCount = new Map<string, number>();
	for (const dir of projectDirs) {
		const name = basename(dir);
		nameCount.set(name, (nameCount.get(name) || 0) + 1);
	}
	for (const dir of projectDirs) {
		const name = basename(dir);
		if ((nameCount.get(name) || 0) > 1) {
			const parent = basename(dirname(dir));
			projectDisplayNames.set(dir, `${parent}/${name}`);
		} else {
			projectDisplayNames.set(dir, name);
		}
	}

	for (const tool of TOOL_CONFIGS) {
		if (!tool.isInstalled()) continue;
		const toolSettings = settings.tools[tool.id];
		if (toolSettings && !toolSettings.enabled) continue;

		// Scan global (user-level) paths
		const allPaths = [...tool.paths, ...tool.agentPaths];
		for (const sp of allPaths) {
			for (const item of await scanPath(sp, tool.id, GLOBAL_CTX, namingMode)) {
				addItem(item, tool.id);
			}
		}

		// Scan project-level paths using configured projectPaths
		if (tool.projectPaths.length > 0 && projectDirs.length > 0) {
			for (const projDir of projectDirs) {
				const projName = projectDisplayNames.get(projDir) || basename(projDir);
				const ctx: ScanContext = { scope: "project", projectName: projName, projectDir: projDir };
				for (const pp of tool.projectPaths) {
					const fullPath = join(projDir, pp.relDir);
					const sp: SkillPath = { baseDir: fullPath, type: pp.type, pattern: pp.pattern };
					for (const item of await scanPath(sp, tool.id, ctx, namingMode)) {
						addItem(item, tool.id);
					}
				}
			}
		}
	}

	// Discover SKILL.md files in non-standard locations
	if (settings.discoverSkills && projectDirs.length > 0) {
		const discovered = await discoverSkillFiles(projectDirs, projectDisplayNames, new Set(items.keys()), namingMode);
		for (const item of discovered) {
			item.isFavorite = settings.favorites.includes(item.id);
			for (const [colName, colIds] of Object.entries(settings.collections)) {
				if (colIds.includes(item.id)) {
					item.collections.push(colName);
				}
			}
			items.set(item.id, item);
		}
	}

	// Legacy: custom scan paths (e.g. vault path)
	for (const projectPath of settings.customScanPaths) {
		if (!(await exists(projectPath))) continue;
		const projName = basename(projectPath);
		const ctx: ScanContext = { scope: "project", projectName: projName, projectDir: projectPath };
		for (const tool of TOOL_CONFIGS) {
			if (!tool.isInstalled()) continue;
			for (const pp of tool.projectPaths) {
				const fullPath = join(projectPath, pp.relDir);
				const sp: SkillPath = { baseDir: fullPath, type: pp.type, pattern: pp.pattern };
				for (const item of await scanPath(sp, tool.id, ctx, namingMode)) {
					addItem(item, tool.id);
				}
			}
		}
	}

	return items;
}

export function getInstalledTools(): string[] {
	return TOOL_CONFIGS.filter((t) => t.isInstalled()).map((t) => t.id);
}

// --- Sync helpers for getWatchPaths (runs infrequently at watcher setup) ---

function isProjectDirSync(dir: string): boolean {
	for (const marker of PROJECT_MARKERS) {
		if (existsSync(join(dir, marker))) return true;
	}
	return false;
}

function findProjectDirsSync(dir: string, remainingDepth: number, results: string[]): void {
	if (!existsSync(dir)) return;
	const unlimited = remainingDepth < 0;
	if (!unlimited && remainingDepth === 0) {
		if (isProjectDirSync(dir)) results.push(dir);
		return;
	}
	const effectiveDepth = unlimited ? MAX_SCAN_DEPTH : remainingDepth;
	const countBefore = results.length;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			if (IGNORED_DIRS.has(entry.name)) continue;
			const child = join(dir, entry.name);
			if (isProjectDirSync(child)) {
				results.push(child);
				if (unlimited || effectiveDepth > 1) {
					findProjectDirsSync(child, unlimited ? -1 : effectiveDepth - 1, results);
				}
			} else if (unlimited || effectiveDepth > 1) {
				findProjectDirsSync(child, unlimited ? -1 : effectiveDepth - 1, results);
			}
		}
	} catch { /* empty */ }
	if (results.length === countBefore && isProjectDirSync(dir)) {
		results.push(dir);
	}
}

function resolveProjectDirsSync(configuredPaths: ProjectPathEntry[]): string[] {
	const dirs: string[] = [];
	for (const entry of configuredPaths) {
		findProjectDirsSync(resolvePath(entry.path), entry.depth, dirs);
	}
	return dirs;
}

export function getWatchPaths(settings?: ChopsSettings): string[] {
	const pathSet = new Set<string>();
	for (const tool of TOOL_CONFIGS) {
		if (!tool.isInstalled()) continue;
		const toolSettings = settings?.tools[tool.id];
		if (toolSettings && !toolSettings.enabled) continue;

		for (const sp of [...tool.paths, ...tool.agentPaths]) {
			if (existsSync(sp.baseDir)) {
				pathSet.add(sp.baseDir);
			}
		}

		// Add project-level watch paths from configured projectPaths
		if (settings && tool.projectPaths.length > 0) {
			const projectDirs = resolveProjectDirsSync(settings.projectPaths);
			for (const projDir of projectDirs) {
				for (const pp of tool.projectPaths) {
					const fullPath = join(projDir, pp.relDir);
					if (pp.pattern === "single-file") {
						const parentDir = dirname(fullPath);
						if (existsSync(parentDir)) pathSet.add(parentDir);
					} else if (pp.pattern === "recursive-filename") {
						if (existsSync(projDir)) pathSet.add(projDir);
					} else if (existsSync(fullPath)) {
						pathSet.add(fullPath);
					}
				}
			}
		}
	}

	return Array.from(pathSet);
}
