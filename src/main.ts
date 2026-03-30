import { Plugin, type FileSystemAdapter } from "obsidian";
import { AgentfilesView, VIEW_TYPE } from "./views/main-view";
import { SkillStore } from "./store";
import { SkillWatcher } from "./watcher";
import { getWatchPaths } from "./scanner";
import { AgentfilesSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type ChopsSettings, type SkillItem } from "./types";

const CACHE_KEY = "agentfiles-scan-cache";

export default class AgentfilesPlugin extends Plugin {
	settings: ChopsSettings = DEFAULT_SETTINGS;
	store: SkillStore = new SkillStore();
	private watcher: SkillWatcher | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addVaultPath();

		this.registerView(VIEW_TYPE, (leaf) =>
			new AgentfilesView(
				leaf,
				this.store,
				this.settings,
				() => this.saveSettings()
			)
		);

		this.addRibbonIcon("cpu", "Agentfiles", () => this.activateView());

		this.addCommand({
			id: "open",
			name: "Open",
			callback: () => this.activateView(),
		});

		this.addSettingTab(new AgentfilesSettingTab(this.app, this));

		this.loadScanCache();
		this.refreshStore();
		this.store.setDeepSearch(this.settings.deepSearchDefault ?? true);
		this.startWatcher();
	}

	private addVaultPath(): void {
		const adapter = this.app.vault.adapter as FileSystemAdapter;
		if (!adapter.getBasePath) return;
		const vaultPath = adapter.getBasePath();
		if (!this.settings.customScanPaths.includes(vaultPath)) {
			this.settings.customScanPaths.push(vaultPath);
		}
	}

	onunload(): void {
		this.stopWatcher();
	}

	refreshStore(showSpinner = false): void {
		if (showSpinner) {
			this.store.setScanning();
		}
		this.store.refresh(this.settings).then((updated) => {
			if (updated) this.saveScanCache();
		});
	}

	private loadScanCache(): void {
		try {
			const raw = localStorage.getItem(CACHE_KEY);
			if (!raw) return;
			const items: SkillItem[] = JSON.parse(raw);
			if (Array.isArray(items) && items.length > 0) {
				this.store.loadFromCache(items);
			}
		} catch { /* corrupt cache, ignore */ }
	}

	private saveScanCache(): void {
		try {
			const items = this.store.allItems.map(
				({ content, frontmatter, usage, warnings, conflicts, ...rest }) => ({
					...rest,
					content: "",
					frontmatter: {},
				})
			);
			localStorage.setItem(CACHE_KEY, JSON.stringify(items));
		} catch { /* quota exceeded, ignore */ }
	}

	startWatcher(): void {
		if (!this.settings.watchEnabled) return;
		this.watcher = new SkillWatcher(this.settings.watchDebounceMs, () =>
			this.refreshStore()
		);
		this.watcher.watchPaths(getWatchPaths(this.settings));
	}

	stopWatcher(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
	}

	restartWatcher(): void {
		this.stopWatcher();
		this.startWatcher();
	}

	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

		// Migrate projectPaths from string[] to ProjectPathEntry[]
		if (
			Array.isArray(this.settings.projectPaths) &&
			this.settings.projectPaths.length > 0 &&
			typeof this.settings.projectPaths[0] === "string"
		) {
			this.settings.projectPaths = (this.settings.projectPaths as unknown as string[]).map(
				(p) => ({ path: p, depth: 1 })
			);
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
