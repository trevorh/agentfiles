import { Events } from "obsidian";
import { basename } from "path";
import type { SkillItem, SidebarFilter, ChopsSettings } from "./types";
import { scanAll } from "./scanner";
import { getSkillkitStatsWithDaily, getSkillConflicts, getSkillWarnings, isSkillkitAvailable } from "./skillkit";

export class SkillStore extends Events {
	private items: Map<string, SkillItem> = new Map();
	private _filter: SidebarFilter = { kind: "all" };
	private _searchQuery = "";
	private _deepSearch = true;
	private _scanning = false;
	private _scanGen = 0;

	get filter(): SidebarFilter {
		return this._filter;
	}

	get searchQuery(): string {
		return this._searchQuery;
	}

	get deepSearch(): boolean {
		return this._deepSearch;
	}

	get scanning(): boolean {
		return this._scanning;
	}

	get allItems(): SkillItem[] {
		return Array.from(this.items.values());
	}

	get filteredItems(): SkillItem[] {
		let result = this.allItems;

		const f = this._filter;
		switch (f.kind) {
			case "favorites":
				result = result.filter((i) => i.isFavorite);
				break;
			case "tool":
				result = result.filter((i) => i.tools.includes(f.toolId));
				break;
			case "type":
				result = result.filter((i) => i.type === f.type);
				break;
			case "collection":
				result = result.filter((i) => i.collections.includes(f.name));
				break;
			case "scope":
				result = result.filter((i) => i.scope === f.scope);
				break;
			case "project":
				result = result.filter(
					(i) =>
						i.scope === "project" &&
						i.projectDir === f.projectPath
				);
				break;
		}

		if (this._searchQuery) {
			const q = this._searchQuery.toLowerCase();
			result = result.filter(
				(i) =>
					i.name.toLowerCase().includes(q) ||
					i.description.toLowerCase().includes(q) ||
					i.type.toLowerCase().includes(q) ||
					(i.projectName && i.projectName.toLowerCase().includes(q)) ||
					(this._deepSearch && i.content.toLowerCase().includes(q))
			);
		}

		return result.sort((a, b) => a.name.localeCompare(b.name));
	}

	getItem(id: string): SkillItem | undefined {
		return this.items.get(id);
	}

	get hasSkillkit(): boolean {
		return isSkillkitAvailable();
	}

	async refresh(settings: ChopsSettings): Promise<boolean> {
		const gen = ++this._scanGen;
		const items = await scanAll(settings);
		if (gen !== this._scanGen) return false; // stale scan, discard
		this.items = items;
		this.enrichWithSkillkit();
		this._scanning = false;
		this.trigger("updated");
		return true;
	}

	loadFromCache(cached: SkillItem[]): void {
		if (this.items.size > 0) return; // real data already loaded
		const map = new Map<string, SkillItem>();
		for (const item of cached) map.set(item.id, item);
		this.items = map;
		this.trigger("updated");
	}

	setScanning(): void {
		this._scanning = true;
		this.trigger("updated");
	}

	private enrichWithSkillkit(): void {
		if (!isSkillkitAvailable()) return;
		const stats = getSkillkitStatsWithDaily();
		const conflicts = getSkillConflicts();
		const warnings = getSkillWarnings();

		const oversizedSet = new Set(warnings.oversized.map((w) => w.name));
		const longDescSet = new Set(warnings.longDesc.map((w) => w.name));
		const oversizedMap = new Map(warnings.oversized.map((w) => [w.name, w.lines]));
		const longDescMap = new Map(warnings.longDesc.map((w) => [w.name, w.chars]));

		for (const item of this.items.values()) {
			const dirName = item.filePath.split("/").slice(-2, -1)[0];
			const baseName = item.name.toLowerCase().replace(/\s+/g, "-");

			const match = stats.get(item.name) || stats.get(dirName) || stats.get(baseName);
			if (match) {
				match.isHeavy = item.content.length > 5000;
				item.usage = match;
			} else {
				item.usage = {
					uses: 0,
					lastUsed: null,
					daysSinceUsed: null,
					isStale: false,
					isHeavy: item.content.length > 5000,
				};
			}

			const lineCount = item.content.split("\n").length;
			const descLen = item.description.length;
			item.warnings = {
				oversized: oversizedSet.has(item.name) || lineCount > 500,
				longDesc: longDescSet.has(item.name) || descLen > 1024,
				lineCount: oversizedMap.get(item.name) ?? lineCount,
				descChars: longDescMap.get(item.name) ?? descLen,
			};

			item.conflicts = conflicts.get(item.name) || conflicts.get(dirName) || [];
		}
	}

	setFilter(filter: SidebarFilter): void {
		this._filter = filter;
		this.trigger("updated");
	}

	setSearch(query: string): void {
		this._searchQuery = query;
		this.trigger("updated");
	}

	setDeepSearch(enabled: boolean): void {
		this._deepSearch = enabled;
		this.trigger("updated");
	}

	toggleFavorite(id: string, settings: ChopsSettings): void {
		const item = this.items.get(id);
		if (!item) return;
		item.isFavorite = !item.isFavorite;
		if (item.isFavorite) {
			if (!settings.favorites.includes(id)) settings.favorites.push(id);
		} else {
			settings.favorites = settings.favorites.filter((f) => f !== id);
		}
		this.trigger("updated");
	}

	getToolCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const item of this.items.values()) {
			for (const tool of item.tools) {
				counts.set(tool, (counts.get(tool) || 0) + 1);
			}
		}
		return counts;
	}

	getTypeCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const item of this.items.values()) {
			counts.set(item.type, (counts.get(item.type) || 0) + 1);
		}
		return counts;
	}

	getScopeCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const item of this.items.values()) {
			counts.set(item.scope, (counts.get(item.scope) || 0) + 1);
		}
		return counts;
	}

	getProjectCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const item of this.items.values()) {
			if (item.scope === "project" && item.projectDir) {
				counts.set(item.projectDir, (counts.get(item.projectDir) || 0) + 1);
			}
		}
		return counts;
	}

	getProjectDisplayName(projectDir: string): string {
		for (const item of this.items.values()) {
			if (item.projectDir === projectDir && item.projectName) {
				return item.projectName;
			}
		}
		return basename(projectDir);
	}
}
