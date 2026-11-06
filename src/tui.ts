/// <reference lib="es2024.promise" />
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  BoxRenderable,
  MarkdownRenderable,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  DiffRenderable,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  SyntaxStyle,
  TextAttributes,
  TextRenderable,
  TreeSitterClient,
  type ClipboardService,
  type CliRenderer,
  type KeyEvent,
  bold,
  bg,
  fg,
  t,
  type Selection,
} from "@opentui/core";
import { applyPreparedChange, discardPreparedChange, findSkills, prepareAdd, type PreparedSkillChange, type SkillSearchResult } from "./actions/skillsCli.js";
import { prepareReplacement, prepareUpdate } from "./actions/update.js";
import { assertApprovedSkillsRoot, fingerprintSkill, recoverSkills, withSkillsLock, type ApprovedSkillsRoot } from "./actions/boundary.js";
import { removeManagedSkill } from "./actions/remove.js";
import { openFile, openRepository } from "./actions/open.js";
import { disableSkill, enableSkill } from "./actions/toggle.js";
import { formatSkillSource } from "./state/format.js";
import {
  addRemoteApproved, commitSelected, discoverGit, fetchApproved, getFileDiff, getStatus,
  initializeSkillsRepo, previewAddRemote, previewCommit, previewFetch, previewInitialize, previewPull, previewPush, pullApproved,
  pushApproved, recoverSkillsGit, redactGitUrl, type GitDiscovery,
} from "./actions/git.js";
import type { SkillScope, SkillState } from "./state/filter.js";
import { filterSkills } from "./state/filter.js";
import { countSkillFileLines, listSkillFiles, readSkillFile, readSkillSource, readSkillText, scanSkills } from "./state/repo.js";
import type { Skill, SkillFile } from "./state/types.js";
import { readInstalledSource } from "./state/upstreamProvenance.js";
import { checkForUpdates } from "./actions/checkUpdates.js";
import { SoftwareUpdateService, type SoftwareUpdateCheck, type UpdateComponent } from "./actions/softwareUpdates.js";
import { prepareUpdateHandoff, resolveGlobalUpdate, type GlobalUpdateInstallation, type PreparedUpdateHandoff, type UpdateTarget } from "./actions/appUpdateHandoff.js";
import type { SkillsRootSelection } from "./onboarding.js";
import { escapeTerminalMultiline, escapeTerminalSingleLine, quoteTerminalPath } from "./terminalText.js";

const colors = {
  background: "#24273A",
  panel: "#1E2030",
  selection: "#494D64",
  border: "#5B6078",
  text: "#CAD3F5",
  muted: "#A5ADCB",
  accent: "#C6A0F6",
  enabled: "#A6DA95",
  disabled: "#ED8796",
  warning: "#EED49F",
};


const markdownStyle = SyntaxStyle.fromStyles({
  "markup.heading.1": { fg: RGBA.fromHex(colors.accent), bold: true },
  default: { fg: RGBA.fromHex(colors.text) },
});

export interface SkillsManagerTuiOptions {
  fileOpener?: (file: string) => Promise<void>;
  clipboard?: ClipboardService;
}

type ContextAction = "open" | "toggle" | "update" | "delete";

interface ContextMenu {
  x: number;
  y: number;
  kind: "skill" | "file";
}

const RIGHT_MOUSE_BUTTON = 2;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Keep this one-time launch command in sync with appUpdateWorker.ts recoveryCommand.
function manualRecoveryCommand(skillsDir: string, revision: string): string {
  const appRevision = revision === "main" || /^[0-9a-f]{40}$/i.test(revision) ? revision : "main";
  if (escapeTerminalSingleLine(skillsDir) === skillsDir) {
    return `npx --yes github:ederheisler/skills-manager#${appRevision} --skills-dir ${shellQuote(skillsDir)}`;
  }
  const octal = [...Buffer.from(skillsDir)].map((byte) => `\\0${byte.toString(8).padStart(3, "0")}`).join("");
  return `SM_SKILLS_DIR=$(printf '%b.' '${octal}'); SM_SKILLS_DIR=\${SM_SKILLS_DIR%.}; npx --yes github:ederheisler/skills-manager#${appRevision} --skills-dir "$SM_SKILLS_DIR"`;
}

function registryOrigin(registry: string): string {
  try { return new URL(registry).origin; } catch { return "unknown"; }
}

function shortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function checkSummary(check: SoftwareUpdateCheck | undefined, component: UpdateComponent, attempted: boolean): string {
  if (!check) return attempted ? "Check result unavailable" : "Not checked";
  if (check.status === "match") return "Up-to-date";
  if (check.status === "different") {
    const state = component === "app" ? "Different from main" : "Different version";
    const latest = component === "app" ? check.available?.slice(0, 7) : check.available;
    return `${state}${latest ? ` · Latest: ${latest}` : ""}`;
  }
  return `${check.status === "unknown" ? "Cannot compare" : "Check failed"}${check.message ? `: ${check.message}` : ""}`;
}

interface FrontmatterItem {
  key: string;
  value: string;
}
function formatFrontmatter(skill: Skill | null | undefined): FrontmatterItem[] {
  if (!skill?.frontmatter) return [{ key: "frontmatter", value: "unavailable" }];
  const formatScalar = (key: string, value: unknown): FrontmatterItem[] =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [{ key, value: String(value) }]
      : [];
  const items = Object.entries(skill.frontmatter).flatMap(([key, value]) => {
    if (key === "metadata" && value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value).flatMap(([metadataKey, metadataValue]) => formatScalar(metadataKey, metadataValue));
    }
    return formatScalar(key, value);
  });
  return [
    ...items.filter((item) => item.key === "name"),
    { key: "source", value: formatSkillSource(skill) },
    ...items.filter((item) => item.key !== "name" && item.key !== "description"),
    ...items.filter((item) => item.key === "description"),
  ];
}


type Mode = "browse" | "search" | "add" | "replace-source" | "search-results" | "git" | "commit-message" | "remote-name" | "remote-url" | "fetch-remote" | "fetch-branch" | "confirm" | "help" | "software-updates";
type DetailRendering = "markdown" | "raw";

interface GitFile {
  status: string;
  path: string;
}

interface Confirmation {
  title: string;
  lines: string[];
  returnMode: "browse" | "git" | "search-results" | "software-updates";
  approve: () => Promise<void>;
  cancel?: () => Promise<void>;
  after?: () => Promise<void>;
  informational?: boolean;
  approveLabel?: string;
  explicitKeyApproval?: boolean;
}

export interface ApplicationUpdateHandoff {
  prepared: PreparedUpdateHandoff;
  recoveryCommand: string;
}

class MeasuredTextRenderable extends TextRenderable {
  rowsAt(width: number): number {
    return Math.max(1, this.textBufferView.measureForDimensions(Math.max(1, width), 10_000)?.lineCount ?? this.lineCount);
  }

  columns(): number {
    return this.textBufferView.measureForDimensions(0, 10_000)?.widthColsMax ?? 0;
  }
}


export class SkillsManagerTui {
  #skills: Skill[] = [];
  #selectedIndex = 0;
  #mode: Mode = "browse";
  #helpReturnMode: "browse" | "git" = "browse";
  #helpOverlay: BoxRenderable | null = null;
  #helpContent: ScrollBoxRenderable | null = null;
  #helpDialog: BoxRenderable | null = null;
  #helpLayout: BoxRenderable | null = null;
  #helpColumns: BoxRenderable[] = [];
  #helpFooter: TextRenderable | null = null;
  #helpDetailScrollTop = 0;
  #helpMetadataScrollTop = 0;
  #screen: BoxRenderable | null = null;
  #headerLabel: MeasuredTextRenderable | null = null;
  #headerShortcuts: BoxRenderable | null = null;
  #headerShortcutText: TextRenderable | null = null;
  #input = "";
  #scope: SkillScope = "all";
  #state: SkillState = "all";
  #status = "Loading skills...";
  #git: GitDiscovery | null = null;
  #gitStatus = "";
  #gitResult = "";
  #gitFiles: GitFile[] = [];
  #gitSelectedIndex = 0;
  #gitStatusFilter = "all";
  #gitDiff = "";
  #gitFullContext = false;
  #confirmation: Confirmation | null = null;
  #confirmationContent: ScrollBoxRenderable | null = null;
  #confirmCancelButton: TextRenderable | null = null;
  #confirmApproveButton: TextRenderable | null = null;
  #busy = false;
  #revision = 0;
  #fileRevision = 0;
  #destroyed = false;
  #remoteName = "";
  #fetchRemote = "";
  #replacementSkill: Skill | null = null;
  #selectedText = "";
  #selectedSource = "";
  #selectedLineCount: number | null = null;
  #skillFiles: SkillFile[] = [];
  #selectedFileIndex = 0;
  #detailRendering: DetailRendering = "markdown";
  #root: BoxRenderable;
  #detailContent: ScrollBoxRenderable | null = null;
  #metadataContent: ScrollBoxRenderable | null = null;
  #entryText: TextRenderable | null = null;
  #noticeText: TextRenderable | null = null;
  #entryInput: InputRenderable | null = null;
  #confirmationSelection: "approve" | "cancel" = "cancel";
  #searchResults: SkillSearchResult[] = [];
  #searchResultIndex = 0;
  #message = "";
  #transientMessage = "";
  #transientMessageTimer: ReturnType<typeof setTimeout> | undefined;
  #searchFilter = "";
  #searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  #availableUpdates = new Set<string>();
  #updateRevision = 0;
  #contextMenu: ContextMenu | null = null;
  #contextMenuAction: ContextAction = "open";
  #clipboard: ClipboardService | null = null;
  #treeSitterClient: TreeSitterClient | null = null;
  #parserWorkspace: string | null = null;
  #skillsDir: string;
  #selection: SkillsRootSelection;
  #softwareUpdates: SoftwareUpdateService;
  #softwareUpdateSelection: UpdateComponent = "app";
  #softwareChecks = new Map<UpdateComponent, symbol>();
  #softwareCheckErrors: Partial<Record<UpdateComponent, string>> = {};
  #softwareBadge: TextRenderable | null = null;
  #softwareContent: ScrollBoxRenderable | null = null;
  #preparingHandoff = false;
  #handoffPending = false;
  #pendingActions = new Set<Promise<void>>();
  #startPromise: Promise<void> | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #exit = Promise.withResolvers<ApplicationUpdateHandoff | null>();

  constructor(
    private readonly renderer: CliRenderer,
    selection: SkillsRootSelection,
    private readonly options: SkillsManagerTuiOptions = {},
  ) {
    this.#selection = { ...selection };
    this.#skillsDir = selection.path;
    this.#softwareUpdates = new SoftwareUpdateService(this.#skillsDir, { onChange: () => this.#softwareUpdatesChanged() });
    this.#root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: colors.background,
    });
    try {
      this.#clipboard = options.clipboard ?? createClipboard({
        host: createHostClipboard(),
        terminal: createRendererClipboardAdapter(renderer),
      });
    } catch (error) {
      this.#message = `Clipboard unavailable: ${errorMessage(error)}`;
    }
    renderer.root.add(this.#root);
    renderer.keyInput.on("keypress", this.#onKeyPress);
    renderer.on("selection", this.#onSelection);
    renderer.on("resize", this.#onResize);
    renderer.once("destroy", () => {
      this.#exit.resolve(null);
      void this.shutdown().catch((error) => {
        process.stderr.write(`Application cleanup failed: ${escapeTerminalSingleLine(redactGitUrl(errorMessage(error)))}\n`);
      });
    });
  }

  start(): Promise<void> {
    if (!this.#startPromise) this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    if (this.#busy || this.#destroyed) return;
    this.#busy = true;
    let markdownError: unknown;
    try {
      await this.#softwareUpdates.start();
      if (this.#destroyed) return;
      try {
        if (!this.#treeSitterClient) await this.#initializeMarkdown();
      } catch (error) {
        markdownError = error;
      }
      if (this.#destroyed) return;
      await this.#recoverInstallation();
      await this.#reload();
      if (markdownError) this.#message = [this.#message, `Markdown highlighting unavailable: ${errorMessage(markdownError)}`].filter(Boolean).join(" ");
      this.#status = "";
    } finally {
      this.#busy = false;
      if (!this.#destroyed) this.#render();
    }
  }

  waitForExit(): Promise<ApplicationUpdateHandoff | null> {
    return this.#exit.promise;
  }

  shutdown(): Promise<void> {
    if (!this.#shutdownPromise) this.#shutdownPromise = this.#shutdown();
    return this.#shutdownPromise;
  }

  async #shutdown(): Promise<void> {
    this.#destroyed = true;
    this.#revision++;
    this.#updateRevision++;
    this.renderer.keyInput.off("keypress", this.#onKeyPress);
    this.renderer.off("selection", this.#onSelection);
    this.renderer.off("resize", this.#onResize);
    clearTimeout(this.#transientMessageTimer);
    clearTimeout(this.#searchDebounceTimer);
    const cancel = this.#confirmation?.cancel;
    this.#confirmation = null;
    const failures: unknown[] = [];
    const settle = async (action: () => Promise<void>): Promise<void> => {
      try { await action(); } catch (error) { failures.push(error); }
    };
    await Promise.all([
      settle(() => this.#softwareUpdates.dispose()),
      ...(cancel ? [settle(cancel)] : []),
    ]);
    await this.#startPromise?.catch(() => {});
    while (this.#pendingActions.size) await Promise.all([...this.#pendingActions]);
    const client = this.#treeSitterClient;
    const workspace = this.#parserWorkspace;
    this.#treeSitterClient = null;
    this.#parserWorkspace = null;
    await Promise.all([
      settle(async () => { await this.#clipboard?.dispose(); }),
      settle(async () => {
        if (client) await client.destroy();
        if (workspace) await rm(workspace, { recursive: true, force: true });
      }),
    ]);
    if (failures.length) throw new Error(failures.map(errorMessage).join("; "));
  }

  #track(action: Promise<void>): void {
    const pending = action.catch((error) => this.#showError(error)).finally(() => this.#pendingActions.delete(pending));
    this.#pendingActions.add(pending);
  }

  async #initializeMarkdown(): Promise<void> {
    const workspace = await mkdtemp(path.join(tmpdir(), "skills-manager-markdown-"));
    if (this.#destroyed) {
      await rm(workspace, { recursive: true, force: true });
      return;
    }
    try {
      this.#treeSitterClient = new TreeSitterClient({ dataPath: workspace });
      this.#parserWorkspace = workspace;
    } catch (error) {
      await rm(workspace, { recursive: true, force: true });
      throw error;
    }
  }

  async #recoverInstallation(): Promise<void> {
    if (this.#selection.identity === null) {
      this.#message = [this.#message, "Directory not yet approved: create it and restart the app before making changes."].filter(Boolean).join(" ");
      return;
    }
    const root = this.#approvedRoot();
    const notices: string[] = this.#message ? [this.#message] : [];
    try {
      const notice = await recoverSkills(root);
      if (notice) notices.push(notice);
    } catch (error) {
      this.#message = [...notices, `Recovery requires attention: ${errorMessage(error)}`].join(" ");
      return;
    }
    try {
      const notice = await recoverSkillsGit(root);
      if (notice) notices.push(notice);
    } catch (error) {
      notices.push(`Git recovery requires attention: ${errorMessage(error)}`);
    }
    this.#message = notices.join(" ");
  }

  #approvedRoot(): ApprovedSkillsRoot {
    const { path: rootPath, identity } = this.#selection;
    if (identity === null) throw new Error("Directory is not approved. Create it and restart the app before making changes.");
    return { path: rootPath, identity };
  }

  #onKeyPress = (key: KeyEvent): void => {
    this.#track(this.#handleKey(key));
  };

  #onResize = (): void => {
    if (this.#destroyed) return;
    this.#resizeHeaderShortcuts();
    if (this.#mode === "help") this.#resizeHelpDialog();
    else if (this.#mode === "software-updates" || this.#mode === "confirm") this.#render();
  };

  #resizeHeaderShortcuts(): void {
    if (!this.#headerLabel || !this.#headerShortcuts || !this.#headerShortcutText) return;
    const space = this.renderer.width - this.#headerLabel.columns() - 1;
    this.#headerShortcuts.visible = space >= "scope · enabled".length;
    this.#headerShortcutText.content = space >= "up/down navigate · space select · / search · scope · enabled".length
      ? t`up/down navigate · space select · / search · ${fg(colors.accent)(bold("s"))}cope · ${fg(colors.accent)(bold("e"))}nabled`
      : t`${fg(colors.accent)(bold("s"))}cope · ${fg(colors.accent)(bold("e"))}nabled`;
  }

  #onSelection = (selection: Selection): void => {
    if (this.#mode === "help") return;
    const text = selection.getSelectedText();
    if (text === "") return;
    const revision = this.#revision;
    this.#track((async () => {
      let reason = "host unavailable";
      let tryTerminal = true;
      if (this.#clipboard) {
        try {
          const result = await this.#clipboard.writeText(text, { destination: "best-available" });
          if (revision !== this.#revision || this.#destroyed) return;
          if (result.host.status === "written") return;
          if (result.terminal.status === "attempted") {
            this.#showInlineNotice("Clipboard sent to terminal; acceptance is not confirmed.");
            return;
          }
          reason = `host: ${result.host.status}, terminal: ${result.terminal.status}`;
          tryTerminal = result.terminal.status === "not-attempted";
        } catch (error) {
          reason = errorMessage(error);
        }
      }
      if (revision !== this.#revision || this.#destroyed) return;
      if (tryTerminal) {
        try {
          if (this.renderer.copyToClipboardOSC52(text)) {
            this.#showInlineNotice("Clipboard sent to terminal; acceptance is not confirmed.");
            return;
          }
          reason += "; terminal unavailable";
        } catch (error) {
          reason += `; terminal: ${errorMessage(error)}`;
        }
      }
      this.#showInlineNotice(`Clipboard unavailable (${reason}). Selection remains available.`);
    })());
  };

  #showInlineNotice(message: string): void {
    if (this.#destroyed) return;
    clearTimeout(this.#transientMessageTimer);
    this.#transientMessage = "";
    this.#message = message;
    if (this.#noticeText) this.#noticeText.content = escapeTerminalSingleLine(message);
  }

  async #handleKey(key: KeyEvent): Promise<void> {
    if (key.name === "q" && (this.#preparingHandoff || this.#handoffPending || (this.#mode === "software-updates" && this.#busy))) {
      this.renderer.destroy();
      return;
    }
    if (this.#busy || this.#destroyed || this.#handoffPending) return;
    if (this.#mode === "help") {
      key.stopPropagation();
      if (key.name === "escape" || key.name === "?" || key.sequence === "?") {
        this.#mode = this.#helpReturnMode;
        this.#helpOverlay?.destroyRecursively();
        this.#helpOverlay = null;
        this.#helpContent = null;
        this.#helpDialog = null;
        this.#helpLayout = null;
        this.#helpColumns = [];
        this.#helpFooter = null;
        this.#detailContent?.scrollTo(this.#helpDetailScrollTop);
        this.#metadataContent?.scrollTo(this.#helpMetadataScrollTop);
        if (this.#screen) this.#screen.opacity = 1;
        this.#syncSoftwareBadge();
      } else if (key.name === "pageup" || key.name === "pagedown") {
        this.#helpContent?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
      } else if (key.name === "up" || key.name === "down") {
        this.#helpContent?.scrollBy(key.name === "up" ? -1 : 1);
      }
      return;
    }
    if (this.#mode === "confirm") {
      if (key.name === "pageup" || key.name === "pagedown") {
        this.#confirmationContent?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
      } else if (key.name === "up" || key.name === "down") {
        this.#confirmationContent?.scrollBy(key.name === "up" ? -1 : 1);
      } else if (key.name === "left" || key.name === "right" || key.name === "tab") {
        if (!this.#confirmation?.informational && !this.#confirmation?.explicitKeyApproval) {
          this.#confirmationSelection = this.#confirmationSelection === "cancel" ? "approve" : "cancel";
          if (this.#confirmCancelButton) {
            this.#confirmCancelButton.fg = this.#confirmationSelection === "cancel" ? colors.enabled : colors.muted;
            this.#confirmCancelButton.bg = this.#confirmationSelection === "cancel" ? colors.selection : colors.panel;
          }
          if (this.#confirmApproveButton) {
            this.#confirmApproveButton.fg = this.#confirmationSelection === "approve" ? colors.enabled : colors.muted;
            this.#confirmApproveButton.bg = this.#confirmationSelection === "approve" ? colors.selection : colors.panel;
          }
        }
      } else if (key.name === "y" || (key.name === "return" && !this.#confirmation?.explicitKeyApproval && this.#confirmationSelection === "approve")) {
        await this.#finishConfirmation(true);
      } else if (key.name === "escape" || (key.name === "return" && !this.#confirmation?.explicitKeyApproval)) {
        await this.#finishConfirmation(false);
      }
      return;
    }
    if (this.#mode === "software-updates") {
      if (key.name === "escape") {
        this.#mode = "browse";
        this.#render();
      } else if (key.name === "up" || key.name === "k" || key.name === "1") {
        this.#softwareUpdateSelection = "app";
        this.#render();
      } else if (key.name === "down" || key.name === "j" || key.name === "2") {
        this.#softwareUpdateSelection = "cli";
        this.#render();
      } else if (key.name === "pageup" || key.name === "pagedown") {
        this.#softwareContent?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
      } else if (key.name === "c") {
        this.#message = "";
        this.#startSoftwareCheck(this.#softwareUpdateSelection);
        this.#render();
      } else if (key.name === "return") await this.#toggleSoftwareAutomatic(this.#softwareUpdateSelection);
      else if (key.name === "r") await this.#reviewSoftwareHandoff("all");
      else if (key.name === "f") await this.#reviewSoftwareHandoff("cli");
      return;
    }
    if (key.name === "q" && this.#mode === "browse") {
      this.renderer.destroy();
      return;
    }
    if (key.name === "escape") {
      if (this.#mode === "commit-message" || this.#mode === "remote-name" || this.#mode === "remote-url" || this.#mode === "fetch-remote" || this.#mode === "fetch-branch") {
        this.#leavePrompt();
      } else if (this.#mode === "browse" && this.#searchFilter !== "") {
        this.#searchFilter = "";
        this.#selectedIndex = 0;
        await this.#loadSelectedText();
        this.#render();
      } else {
        clearTimeout(this.#searchDebounceTimer);
        this.#mode = "browse";
        this.#input = "";
        this.#searchFilter = "";
        this.#status = "";
        this.#contextMenu = null;
        this.#render();
      }
      return;
    }
    if (this.#contextMenu) {
      if (key.name === "up" || key.name === "k") this.#moveContextMenuSelection(-1);
      else if (key.name === "down" || key.name === "j") this.#moveContextMenuSelection(1);
      else if (key.name === "return") await this.#runContextMenuAction(this.#contextMenuAction);
      return;
    }
    if ((this.#mode === "browse" || this.#mode === "git") && (key.name === "?" || key.sequence === "?")) {
      key.stopPropagation();
      this.#helpReturnMode = this.#mode;
      this.#helpDetailScrollTop = this.#detailContent?.scrollTop ?? 0;
      this.#helpMetadataScrollTop = this.#metadataContent?.scrollTop ?? 0;
      this.#mode = "help";
      if (this.#screen) this.#screen.opacity = 0.1;
      this.#helpOverlay = this.#createHelpDialog();
      this.#root.add(this.#helpOverlay);
      return;
    }
    if (this.#mode === "search" || this.#mode === "add" || this.#mode === "replace-source" || this.#mode === "remote-name" || this.#mode === "remote-url" || this.#mode === "fetch-remote" || this.#mode === "fetch-branch") {
      await this.#handleTextEntry(key);
      return;
    }
    if (this.#mode === "commit-message") {
      if (key.name === "return") await this.#prepareCommit();
      return;
    }
    if (this.#mode === "search-results") {
      if (key.name === "return") await this.#installSelectedSearchResult();
      else if (key.name === "o") await this.#openSelectedSearchRepository();
      else if (key.name === "up" || key.name === "k") this.#moveSearchResult(-1);
      else if (key.name === "down" || key.name === "j") this.#moveSearchResult(1);
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      this.#detailContent?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
      return;
    }
    if (this.#mode === "git") {
      if (key.name === "j" || key.name === "down") await this.#moveSelection(1);
      else if (key.name === "k" || key.name === "up") await this.#moveSelection(-1);
      else if (key.name === "s") await this.#cycleGitStatus();
      else if (key.name === "t") await this.#toggleGitFullContext();
      else if (key.name === "r") await this.#refreshGit();
      else if (key.name === "i" && this.#git?.kind === "none") await this.#prepareInit();
      else if (key.name === "n" && (this.#git?.kind === "leaf" || this.#git?.kind === "parent") && this.#git.remotes.length === 0) this.#beginEntry("remote-name");
      else if (key.name === "c") this.#beginEntry("commit-message");
      else if (key.name === "f") await this.#beginFetch();
      else if (key.name === "p") await this.#preparePush();
      else if (key.name === "l") await this.#preparePull();
      return;
    }
    if (key.name === "," || key.name === ".") {
      this.#metadataContent?.scrollBy(key.name === "," ? -1 : 1);
      return;
    }
    if (((key.option || key.meta) && (key.name === "down" || key.name === "up"))
      || (key.ctrl && (key.name === "n" || key.name === "p"))
      || key.name === "[" || key.name === "]") {
      await this.#moveFileSelection(key.name === "down" || key.name === "n" || key.name === "]" ? 1 : -1);
    } else if (key.name === "j" || key.name === "down") await this.#moveSelection(1);
    else if (key.name === "k" || key.name === "up") await this.#moveSelection(-1);
    else if (key.name === "t") this.#toggleDetailRendering();
    else if (key.name === "s") await this.#cycleScope();
    else if (key.name === "/") this.#beginEntry("search");
    else if (key.name === "e") await this.#cycleState();
    else if (key.name === "a") this.#beginEntry("add");
    else if ((key.name === "delete" || key.name === "d") && this.#selected) await this.#prepareRemove();
    else if (key.name === "space" && this.#selected && !this.#selected.orphaned) await this.#prepareToggle();
    else if (key.name === "o" && this.#selected && !this.#selected.orphaned) await this.#openSelected();
    else if (key.name === "p") await this.#updateAll();
    else if (key.name === "u" && this.#selected && !this.#selected.orphaned) await this.#updateSelected();
    else if (key.name === "v") await this.#reviewUpdateCheck();
    else if (key.name === "x") {
      this.#mode = "software-updates";
      this.#message = "";
      this.#startSoftwareCheck("app");
      this.#startSoftwareCheck("cli");
      this.#render();
    }
    else if (key.name === "r") await this.#reload();
    else if (key.name === "g") {
      this.#mode = "git";
      this.#gitResult = "";
      await this.#refreshGit();
    }
  }

  async #handleTextEntry(key: KeyEvent): Promise<void> {
    if (key.name === "return") {
      if (this.#mode === "search") {
        clearTimeout(this.#searchDebounceTimer);
        this.#searchFilter = this.#input;
        this.#mode = "browse";
        this.#selectedIndex = 0;
        await this.#loadSelectedText();
        this.#render();
      } else if (this.#mode === "add") {
        await this.#searchSkills();
      } else if (this.#mode === "replace-source") {
        await this.#prepareExplicitReplacement();
      } else if (this.#mode === "remote-name") {
        if (this.#input.trim() === "") return;
        this.#remoteName = this.#input.trim();
        this.#beginEntry("remote-url");
      } else if (this.#mode === "remote-url") {
        await this.#prepareRemote();
      } else if (this.#mode === "fetch-remote") {
        const remote = this.#input.trim();
        if (!this.#git?.remotes.includes(remote)) {
          this.#showError("Choose one of the configured remotes shown in the prompt.");
          return;
        }
        this.#fetchRemote = remote;
        if (!this.#git.branch) this.#beginEntry("fetch-branch");
        else await this.#prepareFetch(remote);
      } else if (this.#mode === "fetch-branch") {
        const branch = this.#input.trim();
        if (branch) await this.#prepareFetch(this.#fetchRemote || undefined, branch);
      }
      return;
    }

    if (key.name === "backspace") this.#input = this.#input.slice(0, -1);
    else if (key.sequence.length === 1 && !key.ctrl && !key.meta) this.#input += key.sequence;
    else return;
    this.#updateEntryText();
    if (this.#mode === "search") this.#scheduleSearchFilter();
  }

  #beginEntry(mode: "search" | "add" | "replace-source" | "commit-message" | "remote-name" | "remote-url" | "fetch-remote" | "fetch-branch"): void {
    if ((mode === "commit-message" || mode === "remote-name" || mode === "remote-url" || mode === "fetch-remote" || mode === "fetch-branch")
      && this.#git?.kind !== "leaf" && this.#git?.kind !== "parent") {
      this.#showError("Git actions require an available repository.");
      return;
    }
    this.#mode = mode;
    this.#input = "";
    this.#render();
  }

  #updateEntryText(): void {
    if (!this.#entryText) {
      this.#render();
      return;
    }
    this.#entryText.content = escapeTerminalSingleLine(this.#footerText());
  }

  #scheduleSearchFilter(): void {
    clearTimeout(this.#searchDebounceTimer);
    this.#searchDebounceTimer = setTimeout(() => {
      this.#track(this.#applySearchFilter());
    }, 150);
  }

  async #applySearchFilter(): Promise<void> {
    if (this.#mode !== "search") return;
    this.#searchFilter = this.#input;
    this.#selectedIndex = 0;
    await this.#loadSelectedText();
    this.#render();
  }

  #leavePrompt(): void {
    clearTimeout(this.#searchDebounceTimer);
    this.#mode = this.#mode === "commit-message" || this.#mode === "remote-name" || this.#mode === "remote-url"
      || this.#mode === "fetch-remote" || this.#mode === "fetch-branch" ? "git" : "browse";
    this.#input = "";
    this.#render();
  }

  #showError(error: unknown): void {
    if (this.#destroyed) return;
    this.#status = "";
    this.#transientMessage = "";
    this.#message = redactGitUrl(errorMessage(error));
    this.#render();
  }

  async #runExclusive(action: () => Promise<void>): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      await action();
    } catch (error) {
      this.#showError(error);
    } finally {
      this.#busy = false;
      if (!this.#destroyed) this.#render();
    }
  }

  #confirm(confirmation: Confirmation): void {
    if (this.#destroyed) {
      if (confirmation.cancel) this.#track(confirmation.cancel().catch((error) => {
        process.stderr.write(`Prepared change cleanup failed: ${escapeTerminalSingleLine(redactGitUrl(errorMessage(error)))}\n`);
      }));
      return;
    }
    this.#confirmation = confirmation;
    this.#confirmationSelection = "cancel";
    this.#mode = "confirm";
    this.#render();
  }

  async #finishConfirmation(approve: boolean): Promise<void> {
    const confirmation = this.#confirmation;
    if (!confirmation || this.#busy) return;
    this.#confirmation = null;
    this.#mode = confirmation.returnMode;
    await this.#runExclusive(approve && !confirmation.informational ? confirmation.approve : confirmation.cancel ?? (async () => {}));
    if (!this.#destroyed && confirmation.after) await confirmation.after();
  }

  #softwareUpdatesChanged(): void {
    if (this.#destroyed || this.#busy) return;
    if (this.#mode === "software-updates") this.#render();
    else if (this.#mode !== "help" && this.#mode !== "confirm") this.#syncSoftwareBadge();
  }

  #softwareBadgeText(): string {
    const different: string[] = [];
    if (this.#softwareUpdates.results.app?.status === "different") different.push("skills-manager");
    if (this.#softwareUpdates.results.cli?.status === "different") different.push("Vercel skills CLI");
    const notices = different.length ? [`Different ${different.join(" and ")} · x review`] : [];
    const failed: string[] = [];
    if (this.#softwareUpdates.results.app?.status === "unavailable" || this.#softwareCheckErrors.app) failed.push("App");
    if (this.#softwareUpdates.results.cli?.status === "unavailable" || this.#softwareCheckErrors.cli) failed.push("Vercel skills CLI");
    if (failed.length) notices.push(`${failed.join(" and ")} update check failed · x review`);
    if (this.#softwareUpdates.errors.length) notices.push("Update settings need attention · x review");
    return notices.join(" · ");
  }

  #syncSoftwareBadge(): void {
    if (this.#softwareBadge) this.#softwareBadge.content = this.#softwareBadgeText();
  }


  #startSoftwareCheck(component: UpdateComponent): void {
    if (this.#softwareChecks.has(component)) return;
    delete this.#softwareCheckErrors[component];
    const token = Symbol();
    const revision = this.#revision;
    this.#softwareChecks.set(component, token);
    this.#track((async () => {
      if (component === "cli") {
        await this.#softwareUpdates.refreshRegistry();
        if (this.#destroyed || revision !== this.#revision) return;
        const registry = this.#softwareUpdates.registry;
        if (registryOrigin(registry) === "unknown") throw new Error("npm registry unavailable.");
        await this.#softwareUpdates.check(component, registry);
      } else {
        await this.#softwareUpdates.check(component);
      }
    })().catch((error) => {
      if (!this.#destroyed && revision === this.#revision) this.#softwareCheckErrors[component] = `Check failed: ${redactGitUrl(errorMessage(error))}`;
    }).finally(() => {
      if (this.#softwareChecks.get(component) === token) this.#softwareChecks.delete(component);
      this.#softwareUpdatesChanged();
    }));
  }

  async #toggleSoftwareAutomatic(component: UpdateComponent): Promise<void> {
    if (this.#softwareUpdates.preferences[component]) {
      await this.#runExclusive(() => this.#softwareUpdates.setAutomatic(component, false));
      return;
    }
    const label = component === "app" ? "skills-manager" : "Vercel skills CLI";
    const registry = component === "cli" ? this.#softwareUpdates.registry : undefined;
    const host = component === "app" ? "https://api.github.com" : registryOrigin(registry ?? "");
    if (host === "unknown") {
      this.#softwareNotice("The npm registry could not be established. Automatic CLI checks remain off.");
      return;
    }
    this.#confirm({
      title: `Enable automatic ${label} checks`,
      lines: [
        `Check ${label} now and at most once a day.`,
        `Connects to ${host}; the server sees your IP address.`,
      ],
      explicitKeyApproval: true,
      approveLabel: "enable",
      returnMode: "software-updates",
      approve: async () => this.#softwareUpdates.setAutomatic(component, true, registry),
    });
  }

  #softwareNotice(message: string): void {
    this.#confirm({
      title: "Application updates",
      lines: [message],
      returnMode: "software-updates",
      informational: true,
      approve: async () => {},
    });
  }

  async #reviewSoftwareHandoff(target: UpdateTarget): Promise<void> {
    if (this.#pendingActions.size > this.#softwareChecks.size) {
      this.#softwareNotice("Another action is still finishing. Wait for it to complete before starting an update.");
      return;
    }
    await this.#runExclusive(async () => {
      this.#status = "Resolving npm registry for the update review...";
      this.#render();
      try {
        await this.#softwareUpdates.refreshRegistry();
      } finally {
        this.#status = "";
      }
    });
    if (this.#destroyed) return;
    const registry = this.#softwareUpdates.registry;
    const origin = registryOrigin(registry);
    if (origin === "unknown") {
      this.#softwareNotice("The npm registry could not be established. The update cannot start.");
      return;
    }
    const resolution: { installation?: GlobalUpdateInstallation; error?: string } = {};
    await this.#runExclusive(async () => {
      this.#status = "Resolving global installation for the update review...";
      this.#render();
      try {
        resolution.installation = await resolveGlobalUpdate();
      } catch (error) {
        resolution.error = errorMessage(error);
      } finally {
        this.#status = "";
      }
    });
    if (this.#destroyed) return;
    if (!resolution.installation) {
      this.#softwareNotice(resolution.error || "The global installation could not be established. The update cannot start.");
      return;
    }
    const approvedInstallation = resolution.installation;
    const build = { ...this.#softwareUpdates.build };
    const reproducible = !build.dirty && build.source !== "unknown" && /^[0-9a-f]{40}$/i.test(build.commit ?? "");
    const switchToMain = target === "all" || !reproducible;
    const selection = { ...this.#selection };
    const skillsDir = this.#skillsDir;
    const recoveryCommand = manualRecoveryCommand(skillsDir, switchToMain ? "main" : build.commit!);
    this.#confirm({
      title: target === "all" ? "Update app and CLI" : switchToMain ? "Update Vercel skills CLI · switch to main" : "Update Vercel skills CLI",
      approveLabel: approvedInstallation.mode === "install" ? "install" : "update",
      lines: [
        target === "all"
          ? "Updates the app to GitHub main and the Vercel skills CLI, then restarts."
          : switchToMain
            ? "Switches the app to GitHub main and updates the Vercel skills CLI, then restarts."
            : `Keeps the current app version${build.commit ? ` (${build.commit.slice(0, 7)})` : ""}, updates the Vercel skills CLI, then restarts.`,
        ...(switchToMain ? ["GitHub main may advance after this review."] : []),
        approvedInstallation.mode === "install"
          ? `Install globally: skills-manager in npm prefix ${quoteTerminalPath(approvedInstallation.prefix)}; this checkout is not changed.`
          : `Update global installation: skills-manager in npm prefix ${quoteTerminalPath(approvedInstallation.prefix)}.`,
        `Skills directory: ${quoteTerminalPath(skillsDir)}`,
        `Downloads from GitHub and ${origin}.`,
        "npm install scripts run with your user permissions.",
        "The app will restart from the global installation.",
      ],
      returnMode: "software-updates",
      approve: async () => {
        this.#preparingHandoff = true;
        try {
          this.#status = "Preparing update; q quits without starting it.";
          this.#render();
          if (selection.identity !== null) await assertApprovedSkillsRoot(selection);
          const prepared = await prepareUpdateHandoff({
            target, skillsDir, build, registry, installation: approvedInstallation, allowSwitchToMain: switchToMain,
            excludedRoots: this.#softwareUpdates.knownSkillsRoots,
          });
          let transferred = false;
          try {
            if (selection.identity !== null) await assertApprovedSkillsRoot(selection);
            if (this.#destroyed) return;
            this.#handoffPending = true;
            this.#exit.resolve({ prepared, recoveryCommand });
            transferred = true;
          } finally {
            if (!transferred) {
              try {
                await prepared.cleanup();
              } catch (error) {
                const notice = `Could not clean update workspace ${quoteTerminalPath(prepared.workspace)}: ${redactGitUrl(errorMessage(error))}`;
                if (this.#destroyed) process.stderr.write(`${escapeTerminalSingleLine(notice)}\n`);
                throw new Error(notice);
              }
            }
          }
        } finally {
          this.#status = "";
          this.#preparingHandoff = false;
        }
      },
    });
  }

  #showTransient(message: string): void {
    this.#transientMessage = message;
    clearTimeout(this.#transientMessageTimer);
    this.#transientMessageTimer = setTimeout(() => {
      this.#transientMessage = "";
      this.#transientMessageTimer = undefined;
      this.#render();
    }, 5_000);
    this.#render();
  }


  async #cycleScope(): Promise<void> {
    this.#scope = this.#scope === "all" ? "source" : this.#scope === "source" ? "local" : "all";
    this.#selectedIndex = 0;
    await this.#loadSelectedText();
    this.#render();
  }

  async #cycleState(): Promise<void> {
    this.#state = this.#state === "all" ? "enabled" : this.#state === "enabled" ? "disabled" : "all";
    this.#selectedIndex = 0;
    await this.#loadSelectedText();
    this.#render();
  }

  get #visibleSkills(): Skill[] {
    return filterSkills(this.#skills, this.#searchFilter, this.#scope, this.#state);
  }
  get #selected(): Skill | null {
    return this.#visibleSkills[this.#selectedIndex] ?? null;
  }

  get #selectedFile(): SkillFile | null {
    return this.#skillFiles[this.#selectedFileIndex] ?? null;
  }

  async #reload(): Promise<void> {
    const revision = this.#revision;
    const skillsDir = this.#skillsDir;
    try {
      const skills = await scanSkills(skillsDir);
      if (revision !== this.#revision || this.#destroyed) return;
      this.#skills = skills;
      this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#visibleSkills.length - 1));
      await this.#loadSelectedText();
    } catch (error) {
      if (revision !== this.#revision || this.#destroyed) return;
      this.#message = `Cannot scan ${skillsDir}: ${errorMessage(error)}`;
    }
    if (revision !== this.#revision || this.#destroyed) return;
    await this.#refreshGit();
  }

  async #checkForUpdates(skills: readonly Skill[]): Promise<void> {
    const revision = ++this.#updateRevision;
    const installation = this.#revision;
    this.#status = "Checking for updates...";
    this.#render();
    const report = await checkForUpdates(skills);
    if (revision !== this.#updateRevision || installation !== this.#revision || this.#destroyed) return;
    this.#status = "";
    this.#availableUpdates = new Set(report.updated);
    this.#confirm({
      title: "Update check",
      lines: [
        "Checks upstream changes, not your local edits.",
        report.updated.length ? `Updates available: ${report.updated.map((id) => this.#skills.find((skill) => skill.id === id)?.name ?? id).join(", ")}` : report.unavailable.length ? "No updates identified; some checks were unavailable." : "No updates found.",
        ...report.unavailable.map(({ name, reason }) => `${name}: unavailable - ${reason}`),
      ],
      returnMode: "browse",
      informational: true,
      approve: async () => {},
    });
  }

  async #loadSelectedText(): Promise<void> {
    const revision = ++this.#fileRevision;
    const skillPath = this.#selected?.path ?? "";
    let files: SkillFile[];
    try {
      files = skillPath ? await listSkillFiles(skillPath) : [];
    } catch (error) {
      if (revision !== this.#fileRevision || this.#destroyed) return;
      files = [];
      this.#message = `Cannot inspect files for ${skillPath}: ${errorMessage(error)}`;
    }
    if (revision !== this.#fileRevision || this.#destroyed) return;
    this.#skillFiles = files;
    this.#selectedFileIndex = Math.max(0, files.findIndex((file) => file.path === "SKILL.md"));
    await this.#loadSelectedFile();
  }

  async #loadSelectedFile(): Promise<void> {
    const revision = ++this.#fileRevision;
    const skillPath = this.#selected?.path ?? "";
    const file = this.#selectedFile;
    if (!file || file.kind !== "file") {
      this.#selectedText = "";
      this.#selectedSource = "";
      this.#selectedLineCount = null;
      return;
    }
    let text: string;
    let source: string;
    let lineCount: number | null;
    try {
      const content = file.path === "SKILL.md"
        ? Promise.all([readSkillText(skillPath), readSkillSource(skillPath)])
        : readSkillFile(skillPath, file.path).then((value) => [value, value] as const);
      [[text, source], lineCount] = await Promise.all([
        content,
        countSkillFileLines(skillPath, file.path).catch(() => null),
      ]);
    } catch (error) {
      if (revision !== this.#fileRevision || this.#destroyed) return;
      this.#selectedText = "";
      this.#selectedSource = "";
      this.#selectedLineCount = null;
      this.#message = `Cannot read ${file.path}: ${errorMessage(error)}`;
      return;
    }
    if (revision !== this.#fileRevision || this.#destroyed) return;
    this.#selectedText = text;
    this.#selectedSource = source;
    this.#selectedLineCount = lineCount;
  }

  #toggleDetailRendering(): void {
    this.#detailRendering = this.#detailRendering === "markdown" ? "raw" : "markdown";
    this.#render();
  }

  async #moveSelection(delta: number): Promise<void> {
    if (this.#mode === "git") {
      const files = this.#visibleGitFiles;
      if (files.length === 0) return;
      this.#gitSelectedIndex = Math.max(0, Math.min(files.length - 1, this.#gitSelectedIndex + delta));
      await this.#loadGitDiff();
      this.#render();
      return;
    }
    const visible = this.#visibleSkills;
    if (visible.length === 0) return;
    this.#selectedIndex = Math.max(0, Math.min(visible.length - 1, this.#selectedIndex + delta));
    await this.#loadSelectedText();
    this.#render();
  }

  #contextMenuActions(): readonly ContextAction[] {
    if (this.#contextMenu?.kind === "file") return ["open"];
    return this.#selected?.orphaned ? [] : ["open", "toggle", "update", "delete"];
  }

  #moveContextMenuSelection(delta: number): void {
    const actions = this.#contextMenuActions();
    if (actions.length === 0) return;
    const current = actions.indexOf(this.#contextMenuAction);
    this.#contextMenuAction = actions[(current + delta + actions.length) % actions.length]!;
    this.#render();
  }

  async #openContextMenu(index: number, x: number, y: number): Promise<void> {
    if (this.#busy || this.#mode !== "browse") return;
    const revision = this.#revision;
    await this.#selectIndex(index);
    if (revision !== this.#revision || this.#busy || this.#mode !== "browse" || this.#selectedIndex !== index) return;
    if (this.#selected?.orphaned) {
      this.#showError("Orphaned metadata has no installed path and cannot be changed.");
      return;
    }
    this.#contextMenu = { x, y, kind: "skill" };
    this.#contextMenuAction = "open";
    this.#render();
  }

  async #openFileContextMenu(index: number, x: number, y: number): Promise<void> {
    if (this.#busy || this.#mode !== "browse") return;
    const revision = this.#revision;
    await this.#selectFile(index);
    if (revision !== this.#revision || this.#busy || this.#mode !== "browse" || this.#selectedFileIndex !== index) return;
    this.#contextMenu = { x, y, kind: "file" };
    this.#contextMenuAction = "open";
    this.#render();
  }

  async #runContextMenuAction(action: ContextAction): Promise<void> {
    if (this.#busy || this.#mode !== "browse") return;
    this.#contextMenu = null;
    if (action === "open") await this.#openSelected();
    else if (action === "toggle") await this.#prepareToggle();
    else if (action === "update") await this.#updateSelected();
    else await this.#prepareRemove();
  }

  async #prepareToggle(): Promise<void> {
    const skill = this.#selected;
    if (!skill || skill.orphaned) return;
    await this.#runExclusive(async () => {
      const root = this.#approvedRoot();
      await assertApprovedSkillsRoot(root);
      const fingerprint = await fingerprintSkill(root, skill.name, skill.path);
      await assertApprovedSkillsRoot(root);
      const destination = skill.enabled
        ? path.join(root.path, ".disabled_skills", skill.name)
        : path.join(root.path, skill.name);
      this.#confirm({
        title: skill.enabled ? "Disable skill" : "Enable skill",
        approveLabel: skill.enabled ? "disable" : "enable",
        lines: [
          `From: ${quoteTerminalPath(skill.path)}`,
          `To: ${quoteTerminalPath(destination)}`,
          `Entry: ${skill.entryKind}${skill.linkTarget !== null ? ` -> ${quoteTerminalPath(skill.linkTarget)}` : ""}`,
          "Moves only this entry; dependent links may dangle until it returns.",
        ],
        returnMode: "browse",
        approve: async () => {
          await (skill.enabled ? disableSkill(root, skill.name, fingerprint) : enableSkill(root, skill.name, fingerprint));
          await this.#reload();
          this.#showTransient(`${skill.enabled ? "Disabled" : "Enabled"} ${skill.name}.`);
        },
      });
    });
  }

  async #prepareRemove(): Promise<void> {
    const skill = this.#selected;
    if (!skill) return;
    if (skill.orphaned || !skill.path) {
      this.#showError("Cannot remove an unassociated metadata record; the upstream lock is read-only.");
      return;
    }
    await this.#runExclusive(async () => {
      const root = this.#approvedRoot();
      await assertApprovedSkillsRoot(root);
      const fingerprint = await fingerprintSkill(root, skill.name, skill.path);
      await assertApprovedSkillsRoot(root);
      this.#confirm({
        title: "Remove skill",
        approveLabel: "remove",
        lines: [
          `Path: ${quoteTerminalPath(skill.path)}`,
          `Entry: ${skill.entryKind}${skill.linkTarget !== null ? ` -> ${quoteTerminalPath(skill.linkTarget)}` : ""}`,
          "Ownership: unknown. Local changes: unknown without a trusted baseline.",
          "A link is unlinked, not followed. Removal is irreversible after recovery cleanup.",
          "Durability depends on filesystem support; recovery may require attention after interruption.",
        ],
        returnMode: "browse",
        approve: async () => {
          await removeManagedSkill(root, skill.name, skill.path, fingerprint);
          await this.#reload();
          this.#showTransient(`Removed ${skill.name}.`);
        },
      });
    });
  }

  async #openSelected(): Promise<void> {
    const skill = this.#selected;
    const file = this.#selectedFile;
    if (!skill || file?.kind !== "file") return;
    const filePath = path.join(skill.path, file.path);
    const revision = this.#revision;
    try {
      await (this.options.fileOpener ?? openFile)(filePath);
      if (revision === this.#revision && !this.#destroyed) this.#showTransient(`Opened ${file.path}.`);
    } catch (error) {
      if (revision === this.#revision && !this.#destroyed) this.#showError(`Cannot open ${filePath}: ${errorMessage(error)}`);
    }
  }

  #reviewSources(skills: readonly Skill[], approve: (root: ApprovedSkillsRoot, snapshots: Skill[]) => Promise<void>): void {
    const root = this.#approvedRoot();
    const revision = this.#revision;
    const snapshots = skills.map((skill) => ({
      ...skill,
      lockEntry: skill.lockEntry ? structuredClone(skill.lockEntry) : null,
      provenance: { ...skill.provenance },
    }));
    const groups = new Map<string, string[]>();
    for (const skill of snapshots) {
      const entry = skill.lockEntry;
      const name = quoteTerminalPath(skill.path ? path.relative(root.path, skill.path) : skill.name);
      if (!entry || skill.provenance.kind !== "source") continue;
      const destination = entry.sourceUrl;
      const details = `${name} - ${quoteTerminalPath(redactGitUrl(entry.skillPath))}${entry.ref && entry.ref !== "HEAD" ? ` @ ${quoteTerminalPath(redactGitUrl(entry.ref))}` : ""}`;
      const group = groups.get(destination) ?? [];
      group.push(details);
      groups.set(destination, group);
    }
    const lines = [
      `Installation: ${quoteTerminalPath(root.path)}`,
      "Saved sources are unverified. Preparation contacts these sources and stages temporary files; installed skills change only after a later review.",
      ...Array.from(groups, ([destination, members]) => [
        quoteTerminalPath(redactGitUrl(destination).replace(/#.*$/, "#[redacted]")),
        ...members.map((member) => `  ${member}`),
      ]).flat(),
    ];
    this.#confirm({
      title: "Review saved sources",
      approveLabel: "continue",
      lines,
      returnMode: "browse",
      approve: async () => {
        if (this.#destroyed || revision !== this.#revision) throw new Error("Selected installation changed since source review.");
        await assertApprovedSkillsRoot(root);
        await approve(root, snapshots);
      },
    });
  }

  async #reviewUpdateCheck(): Promise<void> {
    const root = this.#approvedRoot();
    const snapshots = this.#skills.map((skill) => ({
      ...skill,
      lockEntry: skill.lockEntry ? structuredClone(skill.lockEntry) : null,
      provenance: { ...skill.provenance },
    }));
    await this.#runExclusive(async () => {
      for (const skill of snapshots) {
        if (!skill.lockEntry || skill.provenance.kind !== "source") continue;
        const current = await readInstalledSource(root.path, skill.path, skill.name, root);
        if (!isDeepStrictEqual(current, skill.lockEntry)) throw new Error("The saved source changed since approval.");
      }
      await assertApprovedSkillsRoot(root);
      await this.#checkForUpdates(snapshots);
    });
  }

  async #updateSelected(): Promise<void> {
    const skill = this.#selected;
    if (!skill || skill.orphaned) return;
    if (skill.provenance.kind !== "source" || !skill.lockEntry) {
      this.#replacementSkill = skill;
      this.#beginEntry("replace-source");
      return;
    }
    this.#reviewSources([skill], async (root, snapshots) => {
      const approved = snapshots[0]!;
      this.#status = `Preparing update for ${approved.name}...`;
      this.#render();
      const change = await prepareUpdate(root, approved, approved.lockEntry!);
      this.#status = "";
      this.#reviewPrepared([change], "browse");
    });
  }

  async #prepareExplicitReplacement(): Promise<void> {
    const source = this.#input.trim();
    const skill = this.#replacementSkill;
    if (!source || !skill) return;
    await this.#runExclusive(async () => {
      this.#status = `Preparing replacement for ${skill.name}...`;
      this.#render();
      const change = await prepareReplacement(this.#approvedRoot(), skill, source);
      this.#status = "";
      this.#reviewPrepared([change], "browse");
    });
  }

  async #updateAll(): Promise<void> {
    const candidates = this.#skills.filter((skill) => !skill.orphaned && skill.provenance.kind === "source" && skill.lockEntry);
    if (candidates.length === 0) {
      this.#showError("No skills have a saved source. Select a skill and supply a source to review a replacement.");
      return;
    }
    const skipped = this.#skills.filter((skill) => !skill.orphaned && (skill.provenance.kind !== "source" || !skill.lockEntry)).map((skill) => skill.name);
    this.#reviewSources(candidates, async (root, snapshots) => {
      const changes: PreparedSkillChange[] = [];
      this.#status = "Preparing updates...";
      this.#render();
      try {
        for (const skill of snapshots) changes.push(await prepareUpdate(root, skill, skill.lockEntry!));
      } catch (error) {
        try {
          await this.#discardPrepared(changes);
        } catch (cleanupError) {
          throw new Error(`${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`);
        }
        throw error;
      }
      this.#status = "";
      this.#reviewPrepared(changes, "browse", skipped.length ? [`Skipped without a saved source: ${skipped.join(", ")}. Select a skill and press u to supply a source.`] : []);
    });
  }

  async #discardPrepared(changes: readonly PreparedSkillChange[]): Promise<void> {
    const errors: string[] = [];
    for (const change of changes) {
      try {
        await discardPreparedChange(change);
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }
    if (errors.length) throw new Error(errors.join("; "));
  }

  #reviewPrepared(changes: PreparedSkillChange[], returnMode: "browse" | "search-results", extraLines: string[] = []): void {
    const root = this.#approvedRoot();
    this.#confirm({
      title: "Review prepared skill changes",
      approveLabel: "apply changes",
      lines: [
        `Installation: ${quoteTerminalPath(root.path)}`,
        "Ownership and local-edit baseline may be unknown. No change is made without approval.",
        ...extraLines,
        ...changes.flatMap((change) => [
          `Source: ${redactGitUrl(change.source)}`,
          ...change.changes.flatMap((entry) => [
            `${entry.action}: ${quoteTerminalPath(entry.destination)} (${entry.enabled ? "enabled" : "disabled"})`,
            ...entry.files.map((file) => `  ${quoteTerminalPath(file)}`),
            ...entry.review.split("\n"),
          ]),
        ]),
      ],
      returnMode,
      cancel: () => this.#discardPrepared(changes),
      approve: async () => {
        let applied = 0;
        let attempted = 0;
        let failure: unknown;
        try {
          await withSkillsLock(root, async () => {
            for (const change of changes) {
              attempted++;
              await applyPreparedChange(change);
              applied++;
            }
          });
        } catch (error) {
          failure = error;
        }
        try {
          await this.#discardPrepared(changes);
        } catch (error) {
          failure = new Error(`${failure ? `${errorMessage(failure)}; ` : ""}cleanup failed: ${errorMessage(error)}`);
        }
        const changedPaths = new Set(changes.flatMap((change) => change.changes.map((entry) => entry.destination)));
        const changedIds = this.#skills.filter((skill) => changedPaths.has(skill.path)).map((skill) => skill.id);
        this.#updateRevision++;
        await this.#reload();
        if (failure) throw new Error(`${applied}/${changes.length} completed; ${attempted} attempted. An attempted change may have been applied; inspect the installation and recovery state. ${errorMessage(failure)}`);
        for (const id of changedIds) this.#availableUpdates.delete(id);
        this.#mode = "browse";
        this.#showTransient(`Applied ${applied} reviewed change${applied === 1 ? "" : "s"}.`);
      },
    });
  }

  async #searchSkills(): Promise<void> {
    const query = this.#input.trim();
    if (!query) return;
    await this.#runExclusive(async () => {
      this.#status = `Searching skills for ${query}...`;
      this.#render();
      this.#searchResults = await findSkills(query);
      this.#searchResultIndex = 0;
      this.#status = "";
      this.#mode = "search-results";
      this.#render();
    });
  }

  #moveSearchResult(delta: number): void {
    if (this.#searchResults.length === 0) return;
    this.#searchResultIndex = (this.#searchResultIndex + delta + this.#searchResults.length) % this.#searchResults.length;
    this.#render();
  }

  async #openSelectedSearchRepository(): Promise<void> {
    const result = this.#searchResults[this.#searchResultIndex];
    if (!result) return;
    const url = /^https?:\/\//i.test(result.repository)
      ? result.repository
      : /^[\w.-]+\/[\w.-]+$/.test(result.repository) ? `https://github.com/${result.repository}` : "";
    if (!url) {
      this.#showError(`No supported repository URL for ${result.repository}.`);
      return;
    }
    const revision = this.#revision;
    try {
      await openRepository(url);
      if (revision === this.#revision && !this.#destroyed) this.#showTransient(`Opened ${url}.`);
    } catch (error) {
      if (revision === this.#revision && !this.#destroyed) this.#showError(`Cannot open ${url}: ${errorMessage(error)}`);
    }
  }

  async #installSelectedSearchResult(index = this.#searchResultIndex): Promise<void> {
    if (this.#busy || this.#mode !== "search-results") return;
    const result = this.#searchResults[index];
    if (!result) return;
    await this.#runExclusive(async () => {
      this.#status = `Preparing ${result.identifier}...`;
      this.#render();
      const change = await prepareAdd(this.#approvedRoot(), result.identifier);
      this.#status = "";
      this.#reviewPrepared([change], "search-results");
    });
  }
  get #gitStatusFilters(): string[] {
    const statuses = new Set<string>();
    for (const file of this.#gitFiles) {
      if (file.status === "??") statuses.add("??");
      else for (const status of file.status) if (status !== " ") statuses.add(status);
    }
    return ["all", ...[...statuses].sort()];
  }

  get #visibleGitFiles(): GitFile[] {
    return this.#gitStatusFilter === "all"
      ? this.#gitFiles
      : this.#gitFiles.filter((file) => file.status.includes(this.#gitStatusFilter));
  }

  async #cycleGitStatus(): Promise<void> {
    const filters = this.#gitStatusFilters;
    this.#gitStatusFilter = filters[(filters.indexOf(this.#gitStatusFilter) + 1) % filters.length];
    this.#gitSelectedIndex = 0;
    await this.#loadGitDiff();
    this.#render();
  }

  async #toggleGitFullContext(): Promise<void> {
    this.#gitFullContext = !this.#gitFullContext;
    await this.#loadGitDiff();
    this.#render();
  }

  async #refreshGit(): Promise<void> {
    const revision = this.#revision;
    const root = this.#skillsDir;
    try {
      const discovery = await discoverGit(root);
      const files = discovery.kind === "leaf" || discovery.kind === "parent" ? await getStatus(root) : [];
      if (revision !== this.#revision || this.#destroyed) return;
      this.#git = discovery;
      this.#gitFiles = files;
      this.#gitStatus = discovery.kind === "leaf" || discovery.kind === "parent"
        ? `Git: ${discovery.kind} · root ${quoteTerminalPath(discovery.topLevel ?? root)} · branch ${discovery.branch ?? "detached"}${discovery.head ? "" : " (unborn)"} · upstream ${discovery.upstream ?? "none"} · ${files.length} changed skill path${files.length === 1 ? "" : "s"}`
        : discovery.kind === "none" ? "No Git repository at selected directory."
          : `Git ${discovery.kind}: ${discovery.error ?? "unavailable"}`;
      if (!this.#gitStatusFilters.includes(this.#gitStatusFilter)) this.#gitStatusFilter = "all";
      this.#gitSelectedIndex = Math.min(this.#gitSelectedIndex, Math.max(0, this.#visibleGitFiles.length - 1));
      await this.#loadGitDiff();
    } catch (error) {
      if (revision !== this.#revision || this.#destroyed) return;
      this.#git = null;
      this.#gitFiles = [];
      this.#gitDiff = "";
      this.#gitStatus = `Git status failed: ${errorMessage(error)}`;
    }
    if (revision === this.#revision && !this.#destroyed) this.#render();
  }

  async #loadGitDiff(): Promise<void> {
    const file = this.#visibleGitFiles[this.#gitSelectedIndex];
    const root = this.#skillsDir;
    const revision = this.#revision;
    if (!file) {
      this.#gitDiff = "";
      return;
    }
    try {
      const result = await getFileDiff(root, file.path, file.status === "??", this.#gitFullContext);
      if (revision !== this.#revision || file !== this.#visibleGitFiles[this.#gitSelectedIndex] || this.#destroyed) return;
      this.#gitDiff = result.stdout || result.stderr;
    } catch (error) {
      if (revision === this.#revision) this.#gitDiff = `Diff unavailable: ${errorMessage(error)}`;
    }
  }


  #gitRepositoryLines(root: string, binding: { repositoryRoot: string }): string[] {
    return [
      `Repository: ${quoteTerminalPath(binding.repositoryRoot)}`,
      ...(binding.repositoryRoot === root ? [] : [`Skills directory: ${quoteTerminalPath(root)}`]),
    ];
  }

  #gitMetadataLines(root: string, binding: { gitDir: string; commonDir: string }): string[] {
    const outside = (directory: string): boolean => {
      const relative = path.relative(root, directory);
      return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    };
    return outside(binding.gitDir) || outside(binding.commonDir)
      ? [
        `Git directory: ${quoteTerminalPath(binding.gitDir)}${outside(binding.gitDir) ? " (outside the selected directory)" : ""}`,
        `Shared Git metadata: ${quoteTerminalPath(binding.commonDir)}${outside(binding.commonDir) ? " (outside the selected directory)" : ""}`,
      ]
      : [];
  }


  async #prepareInit(): Promise<boolean> {
    if (this.#git?.kind !== "none") return false;
    let opened = false;
    await this.#runExclusive(async () => {
      const root = this.#approvedRoot();
      const preview = await previewInitialize(root);
      this.#confirm({
        title: "Initialize Git",
        approveLabel: "initialize",
        lines: [
          `Selected directory: ${quoteTerminalPath(preview.root)}`,
          "Only the selected directory will be initialized. No commit or remote is created.",
        ],
        returnMode: "git",
        approve: async () => this.#completeGitAction(() => initializeSkillsRepo(root, preview)),
      });
      opened = true;
    });
    return opened;
  }

  async #prepareRemote(): Promise<void> {
    const url = this.#input.trim();
    const name = this.#remoteName;
    this.#input = "";
    if (!url) return;
    if ((this.#git?.kind !== "leaf" && this.#git?.kind !== "parent") || this.#git.remotes.length > 0) {
      this.#mode = "git";
      this.#showError("A remote can only be added to a repository without an existing remote.");
      return;
    }
    await this.#runExclusive(async () => {
      const root = this.#approvedRoot();
      const preview = await previewAddRemote(root, name, url);
      this.#confirm({
        title: "Add remote",
        approveLabel: "add remote",
        lines: [
          ...this.#gitRepositoryLines(preview.root, preview.binding),
          `Remote: ${preview.name}`,
          `URL: ${preview.url}`,
          ...this.#gitMetadataLines(preview.root, preview.binding),
          "Create a private destination on your provider first. This does not create or change provider visibility.",
        ],
        returnMode: "git",
        approve: async () => this.#completeGitAction(() => addRemoteApproved(root, preview, url)),
      });
    });
  }

  async #prepareCommit(): Promise<void> {
    const message = this.#input.trim();
    if (!message) return;
    await this.#runExclusive(async () => {
      const root = this.#approvedRoot();
      const paths = this.#gitFiles.map((file) => file.path);
      const preview = await previewCommit(root, paths);
      this.#input = "";
      this.#confirm({
        title: "Review commit",
        approveLabel: "commit",
        lines: [
          ...this.#gitRepositoryLines(preview.root, preview.binding),
          ...this.#gitMetadataLines(preview.root, preview.binding),
          `Branch: ${preview.branch ?? "detached/unborn"}`,
          `Current commit: ${preview.head ?? "none (first commit)"}`,
          `Message: ${message}`,
          "Literal skill paths:",
          ...preview.paths.map((file) => `  ${quoteTerminalPath(file)}`),
          ...(preview.blockingPaths.length ? [
            "Blocking ancestor paths reviewed for identity (only the literal paths above are committed):",
            ...preview.blockingPaths.map((file) => `  ${quoteTerminalPath(file)}`),
          ] : []),
        ],
        returnMode: "git",
        approve: async () => this.#completeGitAction(() => commitSelected(root, preview, message)),
      });
    });
  }

  async #beginFetch(): Promise<void> {
    this.#fetchRemote = "";
    if ((this.#git?.kind === "leaf" || this.#git?.kind === "parent") && this.#git.remotes.length > 1) {
      this.#beginEntry("fetch-remote");
    } else if ((this.#git?.kind === "leaf" || this.#git?.kind === "parent") && this.#git.remotes.length === 1 && !this.#git.branch) {
      this.#beginEntry("fetch-branch");
    } else {
      await this.#prepareFetch();
    }
  }

  async #prepareFetch(remote?: string, branch?: string): Promise<void> {
    this.#mode = "git";
    this.#input = "";
    await this.#runExclusive(async () => {
      const root = this.#approvedRoot();
      const preview = await previewFetch(root, remote, branch);
      this.#confirm({
        title: "Review fetch",
        approveLabel: "fetch",
        lines: [
          ...this.#gitRepositoryLines(preview.root, preview.binding), `Remote: ${preview.remote}`, `Fetch URL: ${preview.fetchUrl}`,
          ...this.#gitMetadataLines(preview.root, preview.binding),
          `Branch: ${preview.branch}`, `Destination: ${preview.destination}`,
          "Fetching contacts the remote and updates its local tracking reference.",
        ],
        returnMode: "git",
        approve: async () => this.#completeGitAction(() => fetchApproved(root, preview)),
      });
    });
  }

  async #preparePush(): Promise<void> {
    await this.#runExclusive(async () => {
      const root = this.#approvedRoot();
      const preview = await previewPush(root, []);
      const containingRepository = preview.binding.repositoryRoot !== preview.root;
      const lines = [
        ...this.#gitRepositoryLines(preview.root, preview.binding), `Remote: ${preview.remote}`, `Push URL: ${preview.pushUrl}`,
        ...(containingRepository ? ["Push sends the whole branch history, including paths outside the selected skills directory."] : []),
        ...this.#gitMetadataLines(preview.root, preview.binding),
        `Branch: ${preview.branch}`, `Upstream: ${preview.upstream ?? "none"}`, `Destination: ${preview.destination}`,
        ...(preview.localRemote ? [
          `Local bare destination: ${quoteTerminalPath(preview.localRemote.path)}`,
          `Local destination identity: device ${preview.localRemote.identity.dev}, inode ${preview.localRemote.identity.ino}`,
          "Local receiver hooks are disabled for this push.",
        ] : []),
        containingRepository ? "Outgoing commits and paths (repository-relative):" : "Outgoing commits and paths:",
        ...preview.outgoing.flatMap((commit) => [`${commit.id} ${commit.subject}`, ...commit.paths.map((file) => `  ${quoteTerminalPath(file)}`)]),
        preview.warning,
        "Git cannot determine provider privacy. The destination determines who can read this push.",
      ];
      this.#confirm({
        title: "Review push",
        approveLabel: "continue",
        lines,
        returnMode: "git",
        approve: async () => {
          this.#confirm({
            title: "Check provider access",
            approveLabel: "push",
            lines: [
              ...this.#gitRepositoryLines(preview.root, preview.binding),
              `Destination: ${preview.pushUrl}`,
              ...(containingRepository ? ["This push sends the whole branch history, including paths outside the selected skills directory."] : []),
              "Have you checked on the provider who can read this push?",
              "Approve only after checking provider access. This approval is separate from the commit and remote setup.",
            ],
            returnMode: "git",
            approve: async () => this.#completeGitAction(() => pushApproved(root, preview)),
          });
        },
      });
    });
  }

  async #preparePull(): Promise<void> {
    await this.#runExclusive(async () => {
      const root = this.#approvedRoot();
      const preview = await previewPull(root, []);
      this.#confirm({
        title: "Review pull",
        approveLabel: "pull",
        lines: [
          ...this.#gitRepositoryLines(preview.root, preview.binding), `Remote: ${preview.remote}`, `Fetch URL: ${preview.fetchUrl}`,
          ...this.#gitMetadataLines(preview.root, preview.binding),
          `Branch: ${preview.branch}`, `Upstream: ${preview.upstream}`, `Destination: ${preview.destination}`,
          `Current: ${preview.head}`, `Target: ${preview.target}`,
          "Incoming commits and paths:",
          ...preview.commits.flatMap((commit) => [`${commit.id} ${commit.subject}`, ...commit.paths.map((file) => `  ${quoteTerminalPath(file)}`)]),
          "Pull is fast-forward only; incoming worktree changes must stay within the selected skills directory.",
        ],
        returnMode: "git",
        approve: async () => this.#completeGitAction(() => pullApproved(root, preview)),
      });
    });
  }

  async #completeGitAction(action: () => Promise<{ command: string; stdout: string; stderr: string; exitCode: number }>): Promise<void> {
    try {
      const result = await action();
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `${result.command} failed (${result.exitCode})`);
      const message = result.stdout || result.stderr || result.command;
      this.#gitResult = message.endsWith("\n") ? message.slice(0, -1) : message;
      this.#message = this.#gitResult;
    } finally {
      await this.#refreshGit();
    }
  }



  get #isGitMode(): boolean {
    return this.#mode === "git" || this.#mode === "commit-message" || this.#mode === "remote-name"
      || this.#mode === "remote-url" || this.#mode === "fetch-remote" || this.#mode === "fetch-branch"
      || (this.#mode === "confirm" && this.#confirmation?.returnMode === "git")
      || (this.#mode === "help" && this.#helpReturnMode === "git");
  }

  #render(): void {
    const helpScrollTop = this.#helpContent?.scrollTop ?? 0;
    this.#helpContent = null;
    this.#helpOverlay = null;
    this.#helpDialog = null;
    this.#helpLayout = null;
    this.#helpColumns = [];
    this.#helpFooter = null;
    this.#headerLabel = null;
    this.#headerShortcuts = null;
    this.#headerShortcutText = null;
    this.#detailContent = null;
    this.#metadataContent = null;
    this.#confirmationContent = null;
    this.#softwareContent = null;
    this.#softwareBadge = null;
    this.#confirmCancelButton = null;
    this.#confirmApproveButton = null;
    this.#entryInput = null;
    this.#entryText = null;
    this.#root.destroyRecursively();
    this.#root = new BoxRenderable(this.renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: colors.background,
    });
    this.renderer.root.add(this.#root);
    const screen = new BoxRenderable(this.renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      opacity: this.#mode === "confirm" || this.#mode === "search-results" || this.#mode === "help" || this.#mode === "software-updates" ? 0.1 : 1,
    });
    this.#root.add(screen);
    this.#screen = screen;
    const isGitMode = this.#isGitMode;
    const header = new BoxRenderable(this.renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      overflow: "hidden",
    });
    const headerText = isGitMode
      ? escapeTerminalSingleLine(`Git · ${this.#git?.kind ?? "error"} · ${this.#visibleGitFiles.length}/${this.#gitFiles.length} files · status: ${this.#gitStatusFilter}`)
      : t`Skills ${this.#visibleSkills.length} shown · ${fg(colors.accent)(bold("s"))}cope: ${this.#scope === "source" ? "From a repo" : this.#scope === "local" ? "Local" : "All"} · ${fg(colors.accent)(bold("e"))}nabled: ${this.#state}${escapeTerminalSingleLine(this.#searchFilter === "" ? "" : ` · filter: ${this.#searchFilter} (Esc to clear)`)}`;
    const headerLabel = new MeasuredTextRenderable(this.renderer, {
      content: headerText,
      fg: colors.text,
      attributes: TextAttributes.BOLD,
      height: 1,
      wrapMode: "none",
      selectable: false,
    });
    header.add(headerLabel);
    if (!isGitMode) {
      const shortcuts = new BoxRenderable(this.renderer, {
        height: 1,
        marginLeft: "auto",
        paddingLeft: 1,
        flexDirection: "row",
        overflow: "hidden",
      });
      const shortcutText = new TextRenderable(this.renderer, {
        content: "", fg: colors.muted, height: 1, wrapMode: "none", selectable: false,
      });
      shortcuts.add(shortcutText);
      this.#headerLabel = headerLabel;
      this.#headerShortcuts = shortcuts;
      this.#headerShortcutText = shortcutText;
      this.#resizeHeaderShortcuts();
      header.add(shortcuts);
    }
    screen.add(header);

    const panes = new BoxRenderable(this.renderer, {
      width: "100%",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      flexDirection: "row",
    });
    if (isGitMode) {
      panes.add(this.#createGitListPane());
    } else {
      panes.add(this.#createListPane());
      panes.add(this.#createFilePane());
    }
    panes.add(this.#createDetailPane());
    screen.add(panes);
    screen.add(this.#createFooter());
    if (this.#contextMenu) this.#root.add(this.#createContextMenu());
    if (this.#mode === "confirm") this.#root.add(this.#createConfirmationDialog());
    if (this.#mode === "search-results") this.#root.add(this.#createSearchResultsDialog());
    if (this.#mode === "software-updates") this.#root.add(this.#createSoftwareUpdatesDialog());
    if (this.#mode === "help") {
      this.#helpOverlay = this.#createHelpDialog(helpScrollTop);
      this.#root.add(this.#helpOverlay);
    }
  }

  #createFooter(): BoxRenderable {
    const mode = this.#mode === "help" ? this.#helpReturnMode : this.#mode;
    const notice = this.#status || this.#transientMessage || this.#message;
    const footer = new BoxRenderable(this.renderer, {
      width: "100%",
      height: 4,
      flexDirection: "column",
      backgroundColor: colors.background,
    });
    const controls = new BoxRenderable(this.renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      overflow: "hidden",
    });
    if (this.#mode === "commit-message") {
      controls.add(new TextRenderable(this.renderer, { content: "Commit message: ", fg: colors.muted, height: 1, wrapMode: "none" }));
      const entry = new InputRenderable(this.renderer, {
        value: this.#input,
        width: Math.max(10, Math.min(50, this.renderer.width - 45)),
        textColor: colors.text,
        cursorColor: colors.accent,
        backgroundColor: colors.background,
        focusedBackgroundColor: colors.background,
        onPaste: (event) => {
          const text = new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, "");
          if (escapeTerminalSingleLine(text) !== text) {
            event.preventDefault();
            this.#showInlineNotice("Commit message input contains terminal controls; paste was not accepted.");
          }
        },
        onKeyDown: (key) => {
          if (!key.ctrl && !key.meta && Array.from(key.sequence).length === 1
            && !["return", "escape", "tab", "backspace", "delete"].includes(key.name)
            && escapeTerminalSingleLine(key.sequence) !== key.sequence) {
            key.preventDefault();
            this.#showInlineNotice("Commit message input contains a terminal control; character was not accepted.");
          }
        },
      });
      entry.on(InputRenderableEvents.INPUT, (value) => { this.#input = value; });
      this.#entryInput = entry;
      controls.add(entry);
      queueMicrotask(() => { if (this.#entryInput === entry) entry.focus(); });
      controls.add(new TextRenderable(this.renderer, { content: " · Enter review · Esc cancel", fg: colors.muted, height: 1, wrapMode: "none" }));
    } else if (mode === "git" || (mode === "confirm" && this.#isGitMode)) {
      controls.add(new TextRenderable(this.renderer, { content: this.#gitToolbarText(), fg: colors.muted, height: 1, minWidth: 0, flexShrink: 1, wrapMode: "none" }));
      controls.add(new TextRenderable(this.renderer, {
        content: t` · ${fg(colors.accent)(bold("?"))} help`,
        fg: colors.muted, height: 1, flexShrink: 0, wrapMode: "none", selectable: false,
      }));
    } else if (mode !== "browse") {
      const entry = new TextRenderable(this.renderer, { content: escapeTerminalSingleLine(this.#footerText()), fg: colors.muted, height: 1, wrapMode: "none" });
      this.#entryText = entry;
      controls.add(entry);
    } else {
      controls.add(new TextRenderable(this.renderer, {
        content: t`${fg(colors.accent)(bold("x"))} app updates · ${fg(colors.accent)(bold("o"))}pen · ${fg(colors.accent)(bold("space"))} enable/disable · ${fg(colors.accent)(bold("r"))}efresh · ${fg(colors.accent)(bold("u"))}pdate · u${fg(colors.accent)(bold("p"))}date all · ${fg(colors.accent)(bold("v"))} check · ${fg(colors.accent)(bold("a"))}dd · ${fg(colors.accent)(bold("d"))}elete · ${fg(colors.accent)(bold("g"))}it · ${fg(colors.accent)(bold("q"))}uit`,
        fg: colors.muted,
        height: 1,
        minWidth: 0,
        flexShrink: 1,
        wrapMode: "none",
        selectable: false,
      }));
      controls.add(new TextRenderable(this.renderer, {
        content: t` · ${fg(colors.accent)(bold("?"))} help`,
        fg: colors.muted, height: 1, flexShrink: 0, wrapMode: "none", selectable: false,
      }));
    }
    footer.add(controls);
    this.#softwareBadge = new TextRenderable(this.renderer, {
      content: this.#softwareBadgeText(), fg: colors.warning, height: 1, wrapMode: "none", selectable: false,
    });
    footer.add(this.#softwareBadge);
    this.#noticeText = new TextRenderable(this.renderer, {
      content: escapeTerminalSingleLine(notice), fg: colors.warning, height: 1, wrapMode: "none", selectable: false,
    });
    footer.add(this.#noticeText);
    footer.add(new TextRenderable(this.renderer, {
      content: this.#isGitMode ? escapeTerminalSingleLine(this.#gitStatus || "Git: checking...") : `Directory: ${quoteTerminalPath(this.#skillsDir)}`,
      fg: colors.muted,
      height: 1,
      wrapMode: "none",
      selectable: false,
    }));
    return footer;
  }

  #skillListWidth(): number {
    let longest = 0;
    for (const skill of this.#visibleSkills) {
      const label = escapeTerminalSingleLine(`${skill.orphaned ? "!" : skill.enabled ? "◉" : "○"} ${skill.provenance.kind === "source" ? "⎇" : " "} ${skill.name}${this.#availableUpdates.has(skill.id) ? " *" : ""}`);
      longest = Math.max(longest, label.length);
    }
    return Math.min(40, Math.max(24, longest + 3));
  }

  #createListPane(): BoxRenderable {
    const panel = new BoxRenderable(this.renderer, {
      width: this.#skillListWidth(),
      minWidth: 0,
    });
    const list = new ScrollBoxRenderable(this.renderer, {
      width: "100%",
      height: "100%",
      border: true,
      title: "Skills",
      titleColor: colors.muted,
      borderColor: colors.border,
      contentOptions: { backgroundColor: colors.panel, overflow: "hidden" },
      viewportOptions: { backgroundColor: colors.panel, overflow: "hidden" },
      scrollbarOptions: { trackOptions: { foregroundColor: colors.accent, backgroundColor: colors.panel } },
    });
    panel.add(list);
    const skills = this.#visibleSkills;
    skills.forEach((skill, index) => {
      const selected = index === this.#selectedIndex;
      const row = new BoxRenderable(this.renderer, {
        id: `skill-${index}`,
        width: "100%",
        height: 1,
        overflow: "hidden",
        backgroundColor: selected ? colors.selection : colors.panel,
      });
      row.add(new TextRenderable(this.renderer, {
        content: escapeTerminalSingleLine(`${skill.orphaned ? "!" : skill.enabled ? "◉" : "○"} ${skill.provenance.kind === "source" ? "⎇" : " "} ${skill.name}${this.#availableUpdates.has(skill.id) ? " *" : ""}`),
        fg: skill.orphaned ? colors.warning : skill.enabled ? colors.enabled : colors.disabled,
        attributes: selected ? TextAttributes.BOLD : 0,
        onMouseDown: (event) => {
          if (event.button === RIGHT_MOUSE_BUTTON) this.#track(this.#openContextMenu(index, event.x, event.y));
          else this.#track(this.#selectIndex(index));
        },
        width: "100%",
        selectable: false,
        wrapMode: "none",
      }));
      list.add(row);
    });
    return panel;
  }

  async #selectIndex(index: number): Promise<void> {
    if (this.#busy || this.#mode !== "browse") return;
    this.#selectedIndex = index;
    await this.#loadSelectedText();
    this.#render();
  }

  #createFilePane(): BoxRenderable {
    const filePaneWidth = this.#skillListWidth();
    const filePaneTextWidth = filePaneWidth - 5;
    const panel = new BoxRenderable(this.renderer, {
      width: filePaneWidth,
      minWidth: 0,
    });
    const list = new ScrollBoxRenderable(this.renderer, {
      width: "100%",
      height: "100%",
      title: "Files · [ ] navigate",
      border: true,
      borderColor: colors.border,
      titleColor: colors.accent,
      contentOptions: { backgroundColor: colors.panel, overflow: "hidden" },
      viewportOptions: { backgroundColor: colors.panel, overflow: "hidden" },
      scrollbarOptions: { trackOptions: { foregroundColor: colors.accent, backgroundColor: colors.panel } },
    });
    panel.add(list);
    this.#skillFiles.forEach((file, index) => {
      const selected = index === this.#selectedFileIndex;
      const label = `${"  ".repeat(file.depth)}${escapeTerminalSingleLine(path.basename(file.path))}${file.kind === "directory" ? "/" : ""}`;
      const row = new BoxRenderable(this.renderer, {
        id: `skill-file-${index}`,
        width: "100%",
        height: Math.ceil(label.length / filePaneTextWidth),
        overflow: "hidden",
        backgroundColor: selected ? colors.selection : colors.panel,
      });
      row.add(new TextRenderable(this.renderer, {
        content: label,
        fg: file.kind === "directory" ? colors.muted : colors.text,
        attributes: selected ? TextAttributes.BOLD : 0,
        width: filePaneTextWidth,
        selectable: false,
        wrapMode: "char",
        onMouseDown: file.kind === "file"
          ? (event) => {
              if (event.button === RIGHT_MOUSE_BUTTON) this.#track(this.#openFileContextMenu(index, event.x, event.y));
              else this.#track(this.#selectFile(index));
            }
          : undefined,
      }));
      list.add(row);
    });
    return panel;
  }

  async #selectFile(index: number): Promise<void> {
    if (this.#busy || this.#mode !== "browse") return;
    this.#selectedFileIndex = index;
    await this.#loadSelectedFile();
    this.#render();
  }

  async #moveFileSelection(delta: number): Promise<void> {
    for (let offset = 1; offset <= this.#skillFiles.length; offset += 1) {
      const index = (this.#selectedFileIndex + delta * offset + this.#skillFiles.length) % this.#skillFiles.length;
      if (this.#skillFiles[index]?.kind === "file") {
        await this.#selectFile(index);
        return;
      }
    }
  }
  #createContextMenu(): BoxRenderable {
    const menu = this.#contextMenu;
    if (!menu) throw new Error("Context menu requested without state.");
    const actions = this.#contextMenuActions();
    const menuHeight = actions.length + 2;
    const panel = new BoxRenderable(this.renderer, {
      position: "absolute",
      left: Math.min(menu.x, this.renderer.width - 20),
      top: Math.min(menu.y, this.renderer.height - menuHeight),
      width: 20,
      height: menuHeight,
      border: true,
      borderColor: colors.accent,
      backgroundColor: colors.panel,
    });
    for (const action of actions) {
      const selected = action === this.#contextMenuAction;
      const label = action === "toggle" ? (this.#selected?.enabled ? "Disable" : "Enable") : `${action[0].toUpperCase()}${action.slice(1)}`;
      panel.add(new TextRenderable(this.renderer, {
        content: `${selected ? ">" : " "} ${label}`,
        fg: action === "delete" ? colors.disabled : colors.text,
        bg: selected ? colors.selection : colors.panel,
        attributes: selected ? TextAttributes.BOLD : 0,
        height: 1,
        selectable: false,
        onMouseDown: () => { this.#track(this.#runContextMenuAction(action)); },
      }));
    }
    return panel;
  }


  #createGitListPane(): BoxRenderable {
    const panel = new BoxRenderable(this.renderer, {
      flexGrow: 2,
      flexBasis: 0,
      minWidth: 0,
    });
    const list = new ScrollBoxRenderable(this.renderer, {
      width: "100%",
      height: "100%",
      border: true,
      borderColor: colors.border,
      contentOptions: { backgroundColor: colors.panel, overflow: "hidden" },
      viewportOptions: { backgroundColor: colors.panel, overflow: "hidden" },
      scrollbarOptions: { trackOptions: { foregroundColor: colors.accent, backgroundColor: colors.panel } },
    });
    panel.add(list);
    panel.add(new TextRenderable(this.renderer, {
      content: t`${bg(colors.background)(fg(colors.muted)(`Working tree · ${this.#gitStatusFilter} · `))}${bg(colors.background)(fg(colors.accent)(bold("s")))}${bg(colors.background)(fg(colors.muted)("tatus"))}`,
      position: "absolute",
      top: 0,
      right: 1,
      height: 1,
      wrapMode: "none",
      selectable: false,
    }));
    const files = this.#visibleGitFiles;
    if (files.length === 0) {
      list.add(new TextRenderable(this.renderer, {
        content: escapeTerminalSingleLine(this.#gitFiles.length === 0 ? "No changed skill paths." : `No ${this.#gitStatusFilter} files.`),
        fg: colors.muted,
        selectable: false,
      }));
      return panel;
    }
    files.forEach((file, index) => {
      const selected = index === this.#gitSelectedIndex;
      const row = new BoxRenderable(this.renderer, {
        id: `git-file-${index}`,
        width: "100%",
        height: 1,
        overflow: "hidden",
        backgroundColor: selected ? colors.selection : colors.panel,
      });
      row.add(new TextRenderable(this.renderer, {
        content: `${escapeTerminalSingleLine(file.status)} ${quoteTerminalPath(file.path)}`,
        fg: colors.text,
        attributes: selected ? TextAttributes.BOLD : 0,
        width: "100%",
        selectable: false,
        wrapMode: "none",
        onMouseDown: () => { this.#track(this.#selectGitFile(index)); },
      }));
      list.add(row);
    });
    this.renderer.once("frame", () => {
      if (!list.isDestroyed) list.scrollChildIntoView(`git-file-${this.#gitSelectedIndex}`);
    });
    return panel;
  }

  async #selectGitFile(index: number): Promise<void> {
    if (this.#busy || this.#mode !== "git") return;
    this.#gitSelectedIndex = index;
    await this.#loadGitDiff();
    this.#render();
  }

  #createDetailPane(): BoxRenderable {
    const column = new BoxRenderable(this.renderer, {
      flexGrow: this.#isGitMode ? 3 : 6,
      flexBasis: 0,
      minWidth: 0,
      flexDirection: "column",
      backgroundColor: colors.background,
    });

    if (this.#isGitMode) {
      const diff = new ScrollBoxRenderable(this.renderer, {
        flexGrow: 1,
        flexBasis: 0,
        title: this.#visibleGitFiles[this.#gitSelectedIndex] ? quoteTerminalPath(this.#visibleGitFiles[this.#gitSelectedIndex]!.path) : "Git diff",
        border: true,
        borderColor: colors.border,
        titleColor: colors.accent,
        contentOptions: { backgroundColor: colors.panel },
        viewportOptions: { backgroundColor: colors.panel },
        scrollbarOptions: { trackOptions: { foregroundColor: colors.accent, backgroundColor: colors.panel } },
      });
      this.#detailContent = diff;
      if (this.#gitDiff && !this.#gitDiff.startsWith("Diff unavailable:") && this.#treeSitterClient) {
        diff.add(new DiffRenderable(this.renderer, {
          width: "100%",
          height: "auto",
          diff: escapeTerminalMultiline(this.#gitDiff),
          treeSitterClient: this.#treeSitterClient,
          view: "unified",
          fg: colors.text,
          wrapMode: "none",
          addedBg: "#1A4D1A",
          removedBg: "#4D1A1A",
          showLineNumbers: true,
        }));
      } else {
        diff.add(new TextRenderable(this.renderer, {
          content: escapeTerminalMultiline(this.#gitDiff || (this.#gitFiles.length === 0 ? "No changes to display." : "No diff available.")),
          fg: colors.text,
          wrapMode: "none",
          selectable: false,
        }));
      }
      column.add(diff);
      column.add(new TextRenderable(this.renderer, {
        content: t`${bg(colors.background)(fg(colors.accent)(bold("t")))}${bg(colors.background)(fg(colors.muted)(`oggle · ${this.#gitFullContext ? "full file" : "diff only"}`))}`,
        position: "absolute",
        top: 0,
        right: 1,
        height: 1,
        wrapMode: "none",
        selectable: false,
      }));
      return column;
    }

    const selectedFile = this.#selectedFile;
    if (selectedFile?.kind !== "file" || selectedFile.path === "SKILL.md") {
      const skill = this.#selected;
      const frontmatter = formatFrontmatter(skill);
      const description = frontmatter.find((item) => item.key === "description");
      const metadata = frontmatter
        .filter((item) => item.key !== "name" && item.key !== "source" && item.key !== "author" && item.key !== "authors" && item.key !== "description")
        .map((item) => `${item.key.charAt(0).toUpperCase()}${item.key.slice(1)}: ${item.value}`);
      const facts = skill ? [
        skill.name,
        formatSkillSource(skill),
        skill.authors.length ? `Author: ${skill.authors.join(", ")}` : "Author not listed",
        `Entry: ${skill.entryKind}${skill.linkTarget !== null ? ` -> ${quoteTerminalPath(skill.linkTarget)}` : ""}`,
        ...(skill.recordedSource && (skill.provenance.kind !== "source" || !isDeepStrictEqual(skill.recordedSource, skill.lockEntry))
          ? [`Recorded source (unverified): ${skill.recordedSource.source}`] : []),
        ...skill.warnings.map((warning) => `Warning: ${warning}`),
        ...metadata,
        ...(description ? [description.value] : []),
      ] : ["No skill selected."];
      const safeFacts = facts.map(escapeTerminalSingleLine);
      const textWidth = Math.max(10, this.renderer.width - 2 * this.#skillListWidth() - 4);
      const rows = safeFacts.reduce((sum, fact) => sum + Math.max(1, Math.ceil(fact.length / textWidth)), 0);
      const header = new ScrollBoxRenderable(this.renderer, {
        height: Math.max(3, Math.min(rows + 2, this.renderer.height - 6)),
        border: true,
        borderColor: colors.border,
        title: "Skill details · ,/. scroll",
        titleColor: colors.accent,
        contentOptions: { backgroundColor: colors.panel, paddingX: 1 },
        viewportOptions: { backgroundColor: colors.panel },
        scrollbarOptions: { trackOptions: { foregroundColor: colors.accent, backgroundColor: colors.panel } },
      });
      this.#metadataContent = header;
      header.add(new TextRenderable(this.renderer, {
        content: safeFacts.join("\n"),
        width: "100%",
        height: "auto",
        fg: colors.text,
        wrapMode: "word",
      }));
      column.add(header);
    }

    const detail = new BoxRenderable(this.renderer, {
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
    });
    const content = new ScrollBoxRenderable(this.renderer, {
      width: "100%",
      height: "100%",
      border: true,
      title: selectedFile?.kind === "file" ? escapeTerminalSingleLine(selectedFile.path) : undefined,
      titleColor: colors.accent,
      contentOptions: { backgroundColor: colors.panel, paddingRight: 1 },
      viewportOptions: { backgroundColor: colors.panel },
      scrollbarOptions: { trackOptions: { foregroundColor: colors.accent, backgroundColor: colors.panel } },
    });
    this.#detailContent = content;
    if (this.#detailRendering === "markdown") {
      content.add(new MarkdownRenderable(this.renderer, {
        content: escapeTerminalMultiline(this.#selectedText || (selectedFile?.kind === "file" ? "Empty file." : "No SKILL.md body.")),
        conceal: true,
        syntaxStyle: markdownStyle,
        treeSitterClient: this.#treeSitterClient ?? undefined,
        width: "100%",
        tableOptions: { wrapMode: "word" },
      }));
    } else {
      content.add(new TextRenderable(this.renderer, { content: escapeTerminalMultiline(this.#selectedSource || (selectedFile?.kind === "file" ? "Empty file." : "No SKILL.md source.")), fg: colors.text, wrapMode: "word" }));
    }
    detail.add(content);
    if (selectedFile?.kind === "file") {
      const lineCountLabel = new BoxRenderable(this.renderer, {
        position: "absolute",
        right: 1,
        bottom: 0,
        height: 1,
        flexDirection: "row",
        backgroundColor: colors.panel,
      });
      lineCountLabel.add(new TextRenderable(this.renderer, {
        content: this.#selectedLineCount === null ? "Line count unavailable" : `${this.#selectedLineCount} ${this.#selectedLineCount === 1 ? "line" : "lines"}`,
        fg: colors.muted,
        height: 1,
        wrapMode: "none",
        selectable: false,
      }));
      detail.add(lineCountLabel);
    }
    const detailTitle = new BoxRenderable(this.renderer, {
      position: "absolute",
      right: 1,
      top: 0,
      height: 1,
      flexDirection: "row",
      backgroundColor: colors.panel,
    });
    detailTitle.add(new TextRenderable(this.renderer, {
      content: t`${this.#detailRendering === "markdown" ? "Markdown" : "Raw"} · ${fg(colors.accent)(bold("t"))}oggle rendering`,
      fg: colors.muted,
      height: 1,
      wrapMode: "none",
    }));
    detail.add(detailTitle);
    column.add(detail);
    return column;
  }

  #createSoftwareUpdatesDialog(): BoxRenderable {
    const overlay = new BoxRenderable(this.renderer, {
      position: "absolute", width: "100%", height: "100%", flexDirection: "column",
      justifyContent: "center", alignItems: "center", paddingX: 1, paddingY: 1,
      onMouse: (event) => event.stopPropagation(),
    });
    const updates = this.#softwareUpdates;
    const activity = updates.activity();
    const app = updates.results.app;
    const cli = updates.results.cli;
    const build = updates.build;
    const lines = [
      ...(this.#preparingHandoff ? ["Preparing update; q quits without starting it.", ""] : []),
      `${this.#softwareUpdateSelection === "app" ? ">" : " "} skills-manager (app) · ${build.version === "unknown" ? "version unavailable" : `installed ${build.version}`}${build.commit ? ` · ${build.commit.slice(0, 7)}` : ""}${build.dirty ? " · modified" : ""}`,
      `  ${activity.app.checking || this.#softwareChecks.has("app") ? "Checking..." : this.#softwareCheckErrors.app ?? checkSummary(app, "app", activity.app.lastAttemptAt !== null)}`,
      `  Automatic checks: ${updates.preferences.app ? "on" : "off"}${app ? ` · Last checked: ${shortDate(app.checkedAt)}` : ""}`,
      "",
      `${this.#softwareUpdateSelection === "cli" ? ">" : " "} Vercel skills CLI · ${updates.cliVersion ? `installed ${updates.cliVersion}` : "version unavailable"}`,
      `  ${activity.cli.checking || this.#softwareChecks.has("cli") ? "Checking..." : this.#softwareCheckErrors.cli ?? checkSummary(cli, "cli", activity.cli.lastAttemptAt !== null)}`,
      `  Automatic checks: ${updates.preferences.cli ? "on" : "off"}${cli ? ` · Last checked: ${shortDate(cli.checkedAt)}` : ""}`,
      ...updates.errors.map((error) => `Update settings: ${error}`),
      ...(this.#message ? [this.#message] : []),
    ];
    const width = Math.max(10, Math.min(110, this.renderer.width - 2));
    const text = new MeasuredTextRenderable(this.renderer, {
      content: lines.map(escapeTerminalSingleLine).join("\n"),
      height: "auto", flexShrink: 0, fg: colors.text, wrapMode: "word",
    });
    const contentRows = text.rowsAt(width - 4);
    const height = Math.max(6, Math.min(this.renderer.height - 2, contentRows + 5));
    const overflow = contentRows > height - 5;
    const dialog = new BoxRenderable(this.renderer, {
      width, height, flexDirection: "column", border: true, borderColor: colors.accent,
      title: "Application updates", titleColor: colors.accent, backgroundColor: colors.panel,
    });
    const content = new ScrollBoxRenderable(this.renderer, {
      width: "100%", flexGrow: 1, flexBasis: 0, minHeight: 0,
      contentOptions: { backgroundColor: colors.panel, paddingX: 1 },
      viewportOptions: { backgroundColor: colors.panel },
      scrollbarOptions: { trackOptions: { foregroundColor: colors.accent, backgroundColor: colors.panel } },
    });
    content.horizontalScrollbarOptions = { visible: false };
    content.verticalScrollbarOptions = { visible: overflow };
    this.#softwareContent = content;
    content.add(text);
    dialog.add(content);
    dialog.add(new TextRenderable(this.renderer, { content: "", height: 1, selectable: false }));
    dialog.add(new TextRenderable(this.renderer, {
      content: t` Up/down select · ${fg(colors.accent)(bold("Enter"))} automatic checks · ${fg(colors.accent)(bold("c"))} check now`,
      fg: colors.muted, height: 1, wrapMode: "none", selectable: false,
    }));
    dialog.add(new TextRenderable(this.renderer, {
      content: t` ${fg(colors.accent)(bold("r"))} update app + CLI · ${fg(colors.accent)(bold("f"))} update CLI · ${fg(colors.accent)(bold("Esc"))} close`,
      fg: colors.muted, height: 1, wrapMode: "none", selectable: false,
    }));
    if (overflow) {
      dialog.add(new TextRenderable(this.renderer, {
        content: " PgUp/PgDn scroll", fg: colors.muted, height: 1, wrapMode: "none", selectable: false,
      }));
    }
    overlay.add(dialog);
    return overlay;
  }

  #createHelpDialog(scrollTop = 0): BoxRenderable {
    type Group = { title: string; rows: Array<[string, string]>; legend?: boolean };
    const browseGroups: Group[][] = [
      [
        { title: "Browse files", rows: [
          ["↑/↓, j/k", "Select skill"],
          [`[ ], ${process.platform === "darwin" ? "Option" : "Alt"}+↑/↓`, "Choose file"],
          ["PgUp/PgDn", "Scroll preview"],
          [",/.", "Scroll metadata"],
          ["o", "Open file"],
          ["t", "Markdown/raw"],
        ] },
        { title: "Filter list", rows: [
          ["/", "Search"],
          ["s", "Cycle scope"],
          ["e", "Cycle enabled state"],
          ["Esc", "Clear filter"],
        ] },
      ],
      [
        { title: "Manage skills", rows: [
          ["Space", "Enable/disable"],
          ["a", "Find/add skills"],
          ["d", "Remove skill"],
          ["v", "Check for updates"],
          ["u", "Update selected"],
          ["p", "Update all"],
        ] },
        { title: "Application", rows: [
          ["g", "Open Git"],
          ["x", "Application updates"],
          ["r", "Refresh"],
          ["q", "Quit"],
        ] },
        { title: "List symbols", legend: true, rows: [
          ["◉ / ○ / !", "Enabled / disabled / missing"],
          ["⎇", "From a repository"],
          ["(none)", "Local"],
          ["*", "Upstream update available"],
        ] },
      ],
    ];
    const hasRepository = this.#git?.kind === "leaf" || this.#git?.kind === "parent";
    const gitGroups: Group[][] = [
      [{ title: "Inspect changes", rows: [
        ["↑/↓, j/k", "Select Git file"],
        ["PgUp/PgDn", "Scroll diff"],
        ["s", "Cycle status"],
        ["t", "Full context"],
        ["r", "Refresh"],
      ] }],
      [
        ...(hasRepository ? [
          { title: "Commit", rows: [["c", "Commit changes"]] as Array<[string, string]> },
          { title: "Remotes", rows: [
            ["f", "Fetch"],
            ["l", "Pull"],
            ["p", "Push"],
            ...(this.#git?.remotes.length ? [] : [["n", "Add remote"] as [string, string]]),
          ] as Array<[string, string]> },
        ] : this.#git?.kind === "none" ? [
          { title: "Initialize", rows: [["i", "Initialize repository"]] as Array<[string, string]> },
        ] : []),
      ],
    ];
    const groups = this.#helpReturnMode === "browse" ? browseGroups : gitGroups;
    const overlay = new BoxRenderable(this.renderer, {
      position: "absolute", width: "100%", height: "100%", flexDirection: "column",
      justifyContent: "center", alignItems: "center", paddingX: 1, paddingY: 1,
      onMouse: (event) => event.stopPropagation(),
    });
    const dialog = new BoxRenderable(this.renderer, {
      width: 10, height: 5,
      flexDirection: "column", border: true, borderColor: colors.accent,
      title: `Keyboard help · ${this.#helpReturnMode === "browse" ? "Skills" : "Git"}`,
      titleColor: colors.accent, backgroundColor: colors.panel,
    });
    const content = new ScrollBoxRenderable(this.renderer, {
      width: "100%", flexGrow: 1, flexBasis: 0, minHeight: 0,
      contentOptions: { backgroundColor: colors.panel, paddingX: 1 },
      viewportOptions: { backgroundColor: colors.panel },
      scrollbarOptions: { trackOptions: { foregroundColor: colors.accent, backgroundColor: colors.panel } },
    });
    content.horizontalScrollbarOptions = { visible: false };
    this.#helpContent = content;
    if (scrollTop) {
      this.renderer.once("frame", () => {
        if (this.#helpContent === content && !content.isDestroyed) content.scrollTo(scrollTop);
      });
    }
    const layout = new BoxRenderable(this.renderer, { height: "auto", flexDirection: "row", flexShrink: 0 });
    this.#helpLayout = layout;
    this.#helpColumns = [];
    for (const column of groups) {
      const pane = new BoxRenderable(this.renderer, { width: "50%", height: "auto", flexDirection: "column", flexShrink: 0 });
      this.#helpColumns.push(pane);
      for (const [index, group] of column.entries()) {
        if (index) pane.add(new TextRenderable(this.renderer, { content: "", height: 1, selectable: false }));
        pane.add(new TextRenderable(this.renderer, {
          content: t`${bold(group.title)}`, height: 1, fg: colors.text, selectable: false,
        }));
        for (const [key, description] of group.rows) {
          const row = new BoxRenderable(this.renderer, { width: "100%", height: "auto", flexDirection: "row", flexShrink: 0 });
          row.add(new TextRenderable(this.renderer, {
            content: group.legend ? key : t`${fg(colors.accent)(bold(key))}`,
            width: 18, height: 1, fg: colors.text, wrapMode: "none", selectable: false,
          }));
          row.add(new MeasuredTextRenderable(this.renderer, {
            content: description, flexGrow: 1, flexBasis: 0, height: "auto", flexShrink: 0,
            fg: colors.text, wrapMode: "word", selectable: false,
          }));
          pane.add(row);
        }
      }
      layout.add(pane);
    }
    content.add(layout);
    dialog.add(content);
    const footer = new TextRenderable(this.renderer, {
      content: " ?/Esc close",
      fg: colors.muted, height: 1, wrapMode: "none", selectable: false,
    });
    dialog.add(footer);
    this.#helpDialog = dialog;
    this.#helpFooter = footer;
    this.#resizeHelpDialog();
    overlay.add(dialog);
    return overlay;
  }

  #resizeHelpDialog(): void {
    const dialog = this.#helpDialog;
    const layout = this.#helpLayout;
    const footer = this.#helpFooter;
    if (!dialog || !layout || !footer) return;
    const wide = this.renderer.width >= 96;
    const width = Math.max(10, Math.min(110, this.renderer.width - 2));
    const columnWidth = Math.max(1, Math.floor((width - 4) / (wide ? 2 : 1)));
    const columnRows = this.#helpColumns.map((pane) => pane.getChildren().reduce((sum, child) => {
      const description = child instanceof BoxRenderable ? child.getChildren()[1] : undefined;
      return sum + (description instanceof MeasuredTextRenderable ? description.rowsAt(columnWidth - 18) : 1);
    }, 0));
    const gap = columnRows.filter((count) => count > 0).length > 1 ? 1 : 0;
    const rows = wide ? Math.max(0, ...columnRows) : columnRows.reduce((sum, count) => sum + count, 0) + gap;
    const height = Math.max(5, Math.min(this.renderer.height - 2, rows + 3));
    const overflow = rows > height - 3;
    dialog.width = width;
    dialog.height = height;
    layout.flexDirection = wide ? "row" : "column";
    layout.rowGap = wide ? 0 : gap;
    for (const pane of this.#helpColumns) pane.width = wide ? "50%" : "100%";
    if (this.#helpContent) this.#helpContent.verticalScrollbarOptions = { visible: overflow };
    footer.content = overflow
      ? " ?/Esc close · Up/down scroll · PgUp/PgDn page"
      : " ?/Esc close";
  }

  #createConfirmationDialog(): BoxRenderable {
    const confirmation = this.#confirmation;
    if (!confirmation) throw new Error("Confirmation requested without a preview.");
    const overlay = new BoxRenderable(this.renderer, {
      position: "absolute",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
    });
    const width = Math.max(10, Math.min(confirmation.explicitKeyApproval ? 76 : 110, this.renderer.width - 4));
    const text = new MeasuredTextRenderable(this.renderer, {
      content: confirmation.lines.map(escapeTerminalSingleLine).join("\n"),
      height: "auto", flexShrink: 0, fg: colors.text, wrapMode: "word",
    });
    const contentRows = text.rowsAt(width - 4);
    const height = Math.max(5, Math.min(this.renderer.height - 3, 22, contentRows + 3));
    const overflow = contentRows > height - 3;
    const dialog = new BoxRenderable(this.renderer, {
      width,
      height,
      flexDirection: "column",
      border: true,
      borderColor: colors.accent,
      title: escapeTerminalSingleLine(confirmation.title),
      titleColor: colors.accent,
      backgroundColor: colors.panel,
    });
    const content = new ScrollBoxRenderable(this.renderer, {
      width: "100%",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      contentOptions: { backgroundColor: colors.panel, paddingX: 1 },
      viewportOptions: { backgroundColor: colors.panel },
      scrollbarOptions: { trackOptions: { foregroundColor: colors.accent, backgroundColor: colors.panel } },
    });
    content.horizontalScrollbarOptions = { visible: false };
    content.verticalScrollbarOptions = { visible: overflow };
    this.#confirmationContent = content;
    content.add(text);
    dialog.add(content);
    const buttons = new BoxRenderable(this.renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: colors.panel,
    });
    this.#confirmCancelButton = new TextRenderable(this.renderer, {
      content: t` ${fg(colors.accent)(bold("Esc"))} ${confirmation.informational ? "close" : "cancel"}`,
      fg: !confirmation.explicitKeyApproval && this.#confirmationSelection === "cancel" ? colors.enabled : colors.muted,
      bg: !confirmation.explicitKeyApproval && this.#confirmationSelection === "cancel" ? colors.selection : colors.panel,
      height: 1,
      selectable: false,
      onMouseDown: () => { this.#track(this.#finishConfirmation(false)); },
    });
    buttons.add(this.#confirmCancelButton);
    if (!confirmation.informational) {
      this.#confirmApproveButton = new TextRenderable(this.renderer, {
      content: t` · ${fg(colors.accent)(bold("y"))} ${confirmation.approveLabel ?? "approve"}`,
      fg: !confirmation.explicitKeyApproval && this.#confirmationSelection === "approve" ? colors.enabled : colors.muted,
      bg: !confirmation.explicitKeyApproval && this.#confirmationSelection === "approve" ? colors.selection : colors.panel,
      height: 1,
      selectable: false,
      onMouseDown: () => { this.#track(this.#finishConfirmation(true)); },
      });
      buttons.add(this.#confirmApproveButton);
    }
    dialog.add(buttons);
    if (overflow) {
      dialog.add(new TextRenderable(this.renderer, {
        content: " PgUp/PgDn scroll", fg: colors.muted, height: 1, wrapMode: "none", selectable: false,
      }));
    }
    overlay.add(dialog);
    return overlay;
  }
  #createSearchResultsDialog(): BoxRenderable {
    const overlay = new BoxRenderable(this.renderer, {
      position: "absolute",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
    });
    const dialog = new ScrollBoxRenderable(this.renderer, {
      width: Math.min(88, this.renderer.width - 4),
      height: Math.min(Math.max(7, this.#searchResults.length * 3 + 4), this.renderer.height - 4),
      border: true,
      borderColor: colors.accent,
      title: escapeTerminalSingleLine(`Skill search · ${this.#input}`),
      titleColor: colors.accent,
      contentOptions: { backgroundColor: colors.panel, paddingX: 1 },
      viewportOptions: { backgroundColor: colors.panel },
      scrollbarOptions: { trackOptions: { foregroundColor: colors.accent, backgroundColor: colors.panel } },
    });
    if (this.#searchResults.length === 0) {
      dialog.add(new TextRenderable(this.renderer, {
        content: "No skills found. Esc closes.",
        fg: colors.muted,
        selectable: false,
      }));
    } else {
      this.#searchResults.forEach((result, index) => {
        const selected = index === this.#searchResultIndex;
        const row = new BoxRenderable(this.renderer, {
          id: `search-result-${index}`,
          width: "100%",
          height: 3,
          flexDirection: "column",
          backgroundColor: selected ? colors.selection : colors.panel,
          onMouseDown: () => { this.#track(this.#installSelectedSearchResult(index)); },
        });
        row.add(new TextRenderable(this.renderer, {
          content: escapeTerminalSingleLine(result.identifier),
          fg: colors.text,
          attributes: selected ? TextAttributes.BOLD : 0,
          selectable: false,
          wrapMode: "none",
        }));
        row.add(new TextRenderable(this.renderer, {
          content: escapeTerminalSingleLine(`${result.installs} installs · ${result.repository}`),
          fg: colors.muted,
          selectable: false,
          wrapMode: "none",
        }));
        row.add(new TextRenderable(this.renderer, {
          content: escapeTerminalSingleLine(result.url ?? "No skills.sh URL provided"),
          fg: colors.accent,
          selectable: false,
          wrapMode: "none",
        }));
        dialog.add(row);
      });
    }
    overlay.add(dialog);
    const help = new BoxRenderable(this.renderer, {
      width: Math.min(88, this.renderer.width - 4),
      height: 1,
      backgroundColor: colors.panel,
    });
    help.add(new TextRenderable(this.renderer, {
      content: "up/down select · Enter/click prepare · o open repo · Esc close",
      fg: colors.muted,
      selectable: false,
      wrapMode: "none",
    }));
    overlay.add(help);
    return overlay;
  }
  #gitToolbarText(): StyledText {
    const controls: Array<[string, string]> = [["Esc", "close"], ["r", "local refresh"]];
    if (this.#git?.kind === "none") controls.push(["i", "initialize"]);
    if (this.#git?.kind === "leaf" || this.#git?.kind === "parent") {
      if (this.#git.remotes.length === 0) controls.push(["n", "add remote"]);
      if (this.#gitFiles.length > 0) controls.push(["c", "commit"]);
      if (this.#git.remotes.length > 0) controls.push(["f", "fetch"], ["l", "pull"], ["p", "push"]);
    }
    return new StyledText(controls.flatMap(([key, label], index) =>
      t`${index ? " · " : ""}${fg(colors.accent)(bold(key))} ${label}`.chunks));
  }

  #footerText(): string {
    if (this.#mode === "search") return `Search: ${this.#input}`;
    if (this.#mode === "add") return `Search skills: ${this.#input}`;
    if (this.#mode === "replace-source") return `Replacement source for ${this.#replacementSkill?.name ?? "skill"}: ${this.#input}`;
    if (this.#mode === "fetch-remote") return `Fetch remote (${this.#git?.remotes.join(", ") ?? "none"}): ${this.#input}`;
    if (this.#mode === "fetch-branch") return `Fetch branch: ${this.#input}`;
    if (this.#mode === "remote-name") return `Remote name: ${this.#input}`;
    if (this.#mode === "remote-url") return `Remote URL: ${this.#input}`;
    return "";
  }
}
