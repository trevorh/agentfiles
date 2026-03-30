import { PluginSettingTab, Setting, type App } from "obsidian";
import { basename } from "path";
import { TOOL_CONFIGS } from "./tool-configs";
import { displayPath } from "./types";
import type AgentfilesPlugin from "./main";

export class AgentfilesSettingTab extends PluginSettingTab {
	plugin: AgentfilesPlugin;
	private scanTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(app: App, plugin: AgentfilesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private debouncedRescan(): void {
		if (this.scanTimer) clearTimeout(this.scanTimer);
		this.scanTimer = setTimeout(async () => {
			await this.plugin.saveSettings();
			this.plugin.refreshStore(true);
			this.plugin.restartWatcher();
		}, 800);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("File watching")
			.setDesc("Automatically detect changes to skill files")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.watchEnabled)
					.onChange(async (value) => {
						this.plugin.settings.watchEnabled = value;
						await this.plugin.saveSettings();
						this.plugin.restartWatcher();
					})
			);

		new Setting(containerEl)
			.setName("Watch debounce (ms)")
			.setDesc("Delay before re-scanning after file changes")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.watchDebounceMs))
					.onChange(async (value) => {
						const n = parseInt(value);
						if (!isNaN(n) && n >= 100) {
							this.plugin.settings.watchDebounceMs = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Display names")
			.setDesc("How skill and command names are displayed in the list")
			.addDropdown((drop) =>
				drop
					.addOptions({
						auto: "Auto (frontmatter / heading / filename)",
						filename: "Filename only",
					})
					.setValue(this.plugin.settings.namingMode || "auto")
					.onChange(async (value) => {
						this.plugin.settings.namingMode = value as "auto" | "filename";
						await this.plugin.saveSettings();
						this.plugin.refreshStore();
					})
			);

		new Setting(containerEl)
			.setName("Content search by default")
			.setDesc(
				"Search file content in addition to metadata when the view opens"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.deepSearchDefault ?? true)
					.onChange(async (value) => {
						this.plugin.settings.deepSearchDefault = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Discover skill files")
			.setDesc(
				"Recursively find SKILL.md files in project directories, even in non-standard locations"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.discoverSkills ?? true)
					.onChange(async (value) => {
						this.plugin.settings.discoverSkills = value;
						await this.plugin.saveSettings();
						this.plugin.refreshStore();
					})
			);

		new Setting(containerEl).setName("Projects").setHeading();

		const desc = containerEl.createDiv("as-projects-desc");
		desc.createEl("p", { text: "Global tool directories (e.g. ~/.claude/skills) are always scanned." });
		desc.createEl("p", { text: "Add project directories below to also scan for project-level files like .claude/commands and .cursorrules." });
		desc.createEl("p", { text: "Scan depth controls how many levels deep to search for project roots." });

		const addDir = async (dir: string) => {
			if (!dir) return;
			const exists = this.plugin.settings.projectPaths.some(
				(e) => e.path === dir
			);
			if (!exists) {
				this.plugin.settings.projectPaths.push({ path: dir, depth: 1 });
				await this.plugin.saveSettings();
				this.plugin.refreshStore(true);
				this.plugin.restartWatcher();
				this.display();
			}
		};

		const box = containerEl.createDiv("as-projects-box");

		for (let i = 0; i < this.plugin.settings.projectPaths.length; i++) {
			const entry = this.plugin.settings.projectPaths[i];
			const name = entry.path === "~" ? "Home directory" : basename(entry.path);
			const isUnlimited = entry.depth < 0;

			if (i > 0) box.createEl("hr", { cls: "as-projects-divider" });

			const row = box.createDiv("as-project-row");
			const info = row.createDiv("as-project-info");
			info.createDiv({ cls: "as-project-name", text: name });
			info.createDiv({ cls: "as-project-path", text: displayPath(entry.path) });

			const controls = row.createDiv("as-project-controls");

			// Depth spinner
			const spinnerEl = controls.createDiv("as-depth-spinner");
			const depthInput = spinnerEl.createEl("input", {
				type: "number",
				cls: "as-depth-input",
				attr: { min: "0", max: "10", step: "1" },
			});
			depthInput.value = isUnlimited ? "1" : String(entry.depth);
			depthInput.disabled = isUnlimited;
			depthInput.addEventListener("change", () => {
				const n = parseInt(depthInput.value);
				if (!isNaN(n) && n >= 0) {
					entry.depth = n;
					this.debouncedRescan();
				}
			});

			// "All subdirectories" toggle
			const allLabel = controls.createEl("label", { cls: "as-depth-all-label" });
			const allCheckbox = allLabel.createEl("input", { type: "checkbox" });
			allCheckbox.checked = isUnlimited;
			allLabel.appendText("All subdirs");
			allCheckbox.addEventListener("change", () => {
				if (allCheckbox.checked) {
					entry.depth = -1;
					depthInput.disabled = true;
				} else {
					entry.depth = parseInt(depthInput.value) || 1;
					depthInput.disabled = false;
				}
				this.debouncedRescan();
			});

			const removeBtn = controls.createEl("button", { cls: "as-project-remove", attr: { "aria-label": "Remove" } });
			removeBtn.setText("Remove");
			removeBtn.addEventListener("click", async () => {
				this.plugin.settings.projectPaths =
					this.plugin.settings.projectPaths.filter(
						(e) => e.path !== entry.path
					);
				await this.plugin.saveSettings();
				this.plugin.refreshStore(true);
				this.plugin.restartWatcher();
				this.display();
			});
		}

		// Always-present "Add" row at the bottom
		if (this.plugin.settings.projectPaths.length > 0) {
			box.createEl("hr", { cls: "as-projects-divider" });
		}

		const addRow = box.createDiv("as-project-row as-project-add-row");
		const addInfo = addRow.createDiv("as-project-info");
		addInfo.createDiv({ cls: "as-project-name", text: "Add project directory" });

		const addControls = addRow.createDiv("as-project-controls");

		// Try native folder picker, fall back to text input
		let hasNativeDialog = false;
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const remote = require("@electron/remote");
			if (remote?.dialog) hasNativeDialog = true;
		} catch { /* not available */ }

		if (hasNativeDialog) {
			const browseBtn = addControls.createEl("button", { cls: "as-project-browse" });
			browseBtn.setText("Browse");
			browseBtn.addEventListener("click", async () => {
				try {
					// eslint-disable-next-line @typescript-eslint/no-var-requires
					const { dialog } = require("@electron/remote");
					const result = await dialog.showOpenDialog({
						properties: ["openDirectory"],
						title: "Select a project directory",
					});
					if (!result.canceled && result.filePaths.length > 0) {
						await addDir(result.filePaths[0]);
					}
				} catch { /* dialog failed, ignore */ }
			});
		} else {
			const pathInput = addControls.createEl("input", {
				type: "text",
				cls: "as-project-path-input",
				attr: { placeholder: "/path/to/projects" },
			});
			const addBtn = addControls.createEl("button", { cls: "as-project-browse" });
			addBtn.setText("Add");
			addBtn.addEventListener("click", async () => {
				await addDir(pathInput.value?.trim() || "");
			});
		}

		new Setting(containerEl).setName("Tools").setHeading();

		for (const tool of TOOL_CONFIGS) {
			const installed = tool.isInstalled();
			const toolSettings = this.plugin.settings.tools[tool.id] || {
				enabled: true,
				customPaths: [],
			};

			new Setting(containerEl)
				.setName(tool.name)
				.setDesc(installed ? "Installed" : "Not detected")
				.addToggle((toggle) =>
					toggle
						.setValue(installed && toolSettings.enabled)
						.setDisabled(!installed)
						.onChange(async (value) => {
							this.plugin.settings.tools[tool.id] = {
								...toolSettings,
								enabled: value,
							};
							await this.plugin.saveSettings();
							this.plugin.refreshStore();
						})
				);
		}
	}
}
