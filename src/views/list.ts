import { setIcon } from "obsidian";
import { TOOL_CONFIGS } from "../tool-configs";
import { TOOL_SVGS, renderToolIcon } from "../tool-icons";
import type { SkillStore } from "../store";
import type { SkillItem } from "../types";

export class ListPanel {
	private containerEl: HTMLElement;
	private store: SkillStore;
	private onSelect: (item: SkillItem) => void;
	private selectedId: string | null = null;
	private inputEl: HTMLInputElement | null = null;
	private deepToggleEl: HTMLButtonElement | null = null;
	private listEl: HTMLElement | null = null;

	constructor(
		containerEl: HTMLElement,
		store: SkillStore,
		onSelect: (item: SkillItem) => void
	) {
		this.containerEl = containerEl;
		this.store = store;
		this.onSelect = onSelect;
	}

	setSelected(id: string | null): void {
		this.selectedId = id;
	}

	render(): void {
		if (!this.inputEl) {
			this.containerEl.empty();
			this.containerEl.addClass("as-list");

			const searchContainer = this.containerEl.createDiv("as-search");
			this.inputEl = searchContainer.createEl("input", {
				type: "text",
				placeholder: "Search agent files...",
				cls: "as-search-input",
			});
			this.inputEl.addEventListener("input", () => {
				this.store.setSearch(this.inputEl!.value);
			});

			this.deepToggleEl = searchContainer.createEl("button", {
				cls: "as-deep-toggle",
				attr: { "aria-label": "Search file content in addition to metadata" },
			});
			setIcon(this.deepToggleEl, "search-code");
			this.deepToggleEl.addEventListener("click", () => {
				this.store.setDeepSearch(!this.store.deepSearch);
				this.updateDeepToggle();
			});

			this.listEl = this.containerEl.createDiv("as-list-items");
		}

		this.inputEl.value = this.store.searchQuery;
		this.inputEl.placeholder = this.getSearchPlaceholder();
		this.updateDeepToggle();
		this.renderList();
	}

	private updateDeepToggle(): void {
		if (!this.deepToggleEl) return;
		this.deepToggleEl.toggleClass("is-active", this.store.deepSearch);
		this.deepToggleEl.setAttribute(
			"aria-label",
			this.store.deepSearch
				? "Content search enabled — searching file content and metadata"
				: "Content search disabled — searching metadata only"
		);
	}


	private getSearchPlaceholder(): string {
		const f = this.store.filter;
		switch (f.kind) {
			case "type": {
				const labels: Record<string, string> = {
					skill: "skills", command: "commands", agent: "agents", rule: "rules", memory: "memories",
				};
				return `Search ${labels[f.type] || f.type}...`;
			}
			case "tool": {
				const tool = TOOL_CONFIGS.find((t) => t.id === f.toolId);
				return tool ? `Search ${tool.name} files...` : "Search agent files...";
			}
			case "favorites":
				return "Search favorites...";
			case "scope":
				return `Search ${f.scope} agent files...`;
			case "project":
				return "Search project files...";
			case "collection":
				return `Search ${f.name}...`;
			default:
				return "Search agent files...";
		}
	}

	private renderList(): void {
		if (!this.listEl) return;
		this.listEl.empty();

		if (this.store.scanning) {
			const el = this.listEl.createDiv("as-list-scanning");
			el.createDiv("as-scanning-spinner");
			el.createSpan({ text: "Scanning..." });
			return;
		}

		const items = this.store.filteredItems;

		if (items.length === 0) {
			this.listEl.createDiv({
				cls: "as-list-empty",
				text: "No agent files found",
			});
			return;
		}

		for (const item of items) {
			this.renderCard(this.listEl, item);
		}
	}

	private renderCard(container: HTMLElement, item: SkillItem): void {
		const card = container.createDiv("as-skill-card");
		if (item.id === this.selectedId) card.addClass("is-selected");

		const header = card.createDiv("as-skill-header");
		header.createSpan({ cls: "as-skill-name", text: item.name });

		if (item.scope === "project" && item.projectName) {
			header.createSpan({ cls: "as-project-badge", text: item.projectName });
		} else if (item.scope === "global") {
			const globeEl = header.createSpan("as-global-icon");
			setIcon(globeEl, "globe");
		}

		if (item.isFavorite) {
			const star = header.createSpan("as-skill-star");
			setIcon(star, "star");
		}

		if (item.description) {
			card.createDiv({
				cls: "as-skill-desc",
				text:
					item.description.length > 80
						? item.description.slice(0, 80) + "..."
						: item.description,
			});
		}

		const meta = card.createDiv("as-skill-meta");

		meta.createSpan({
			cls: `as-type-tag as-type-${item.type}`,
			text: item.type,
		});

		for (const toolId of item.tools) {
			const tool = TOOL_CONFIGS.find((t) => t.id === toolId);
			if (!tool) continue;
			const badge = meta.createSpan("as-tool-badge");
			badge.title = tool.name;
			badge.setAttribute("aria-label", tool.name);
			badge.setCssProps({ "--tool-color": tool.color });
			if (TOOL_SVGS[toolId]) {
				renderToolIcon(badge, toolId, 12);
			} else {
				badge.addClass("as-tool-badge-dot");
			}
		}

		if (item.usage) {
			if (item.usage.uses > 0) {
				meta.createSpan({
					cls: "as-usage-badge",
					text: `${item.usage.uses}`,
					attr: { "aria-label": `Used ${item.usage.uses} times` },
				});
			}
			if (item.usage.isStale) {
				meta.createSpan({ cls: "as-badge-stale", text: "stale" });
			}
			if (item.usage.isHeavy) {
				meta.createSpan({ cls: "as-badge-heavy", text: "heavy" });
			}
		}
		if (item.warnings?.oversized) {
			meta.createSpan({ cls: "as-badge-warn", text: "oversized" });
		}
		if (item.conflicts && item.conflicts.length > 0) {
			meta.createSpan({ cls: "as-badge-conflict", text: "conflict" });
		}
		if (item.isDiscovered) {
			meta.createSpan({ cls: "as-badge-discovered", text: "discovered" });
		}

		card.addEventListener("click", () => {
			this.selectedId = item.id;
			this.onSelect(item);
		});
	}
}
