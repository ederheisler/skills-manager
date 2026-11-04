import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BoxRenderable,
  CodeRenderable,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  DiffRenderable,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  ScrollBoxRenderable,
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
import { checkForUpdates } from "./actions/checkUpdates.js";
import type { SkillsOnboardingResult, SkillsRootSelection } from "./onboarding.js";
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

const filePaneWidth = 32;
const filePaneTextWidth = filePaneWidth - 5;

const markdownStyle = SyntaxStyle.fromStyles({
  "markup.heading.1": { fg: RGBA.fromHex(colors.accent), bold: true },
  default: { fg: RGBA.fromHex(colors.text) },
});

export interface SkillsManagerTuiOptions {
  selectSkillsDir?: (currentSkillsDir: string) => Promise<SkillsOnboardingResult | null>;
  initialOnboarding?: Pick<SkillsOnboardingResult, "reviewInitialize" | "reviewBackup">;
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

type Mode = "browse" | "search" | "add" | "replace-source" | "search-results" | "git" | "commit-message" | "remote-name" | "remote-url" | "fetch-remote" | "fetch-branch" | "confirm" | "help";
type DetailRendering = "markdown" | "raw";

interface GitFile {
  status: string;
  path: string;
}

interface Confirmation {
  title: string;
  lines: string[];
  returnMode: "browse" | "git" | "search-results";
  approve: () => Promise<void>;
  cancel?: () => Promise<void>;
  after?: () => Promise<void>;
  informational?: boolean;
}


export class SkillsManagerTui {
  #skills: Skill[] = [];
  #selectedIndex = 0;
  #mode: Mode = "browse";
  #helpReturnMode: "browse" | "git" = "browse";
  #helpOverlay: BoxRenderable | null = null;
  #helpContent: ScrollBoxRenderable | null = null;
  #screen: BoxRenderable | null = null;
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

  constructor(
    private readonly renderer: CliRenderer,
    selection: SkillsRootSelection,
    private readonly options: SkillsManagerTuiOptions = {},
  ) {
    this.#selection = { ...selection };
    this.#skillsDir = selection.path;
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
    renderer.once("destroy", () => {
      this.#destroyed = true;
      this.#revision++;
      renderer.keyInput.off("keypress", this.#onKeyPress);
      renderer.off("selection", this.#onSelection);
      const cancel = this.#confirmation?.cancel;
      if (cancel) void cancel().catch((error) => {
        process.stderr.write(`Prepared change cleanup failed: ${escapeTerminalSingleLine(redactGitUrl(errorMessage(error)))}\n`);
      });
      void this.#clipboard?.dispose().catch(() => {});
      const client = this.#treeSitterClient;
      const workspace = this.#parserWorkspace;
      this.#treeSitterClient = null;
      this.#parserWorkspace = null;
      if (workspace) void (async () => {
        try {
          if (client) await client.destroy();
          await rm(workspace, { recursive: true, force: true });
        } catch (error) {
          process.stderr.write(`Temporary Markdown workspace cleanup failed: ${escapeTerminalSingleLine(errorMessage(error))}\n`);
        }
      })();
      clearTimeout(this.#transientMessageTimer);
      clearTimeout(this.#searchDebounceTimer);
    });
  }

  async start(): Promise<void> {
    if (this.#busy || this.#destroyed) return;
    this.#busy = true;
    let markdownError: unknown;
    try {
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
    if (!this.#destroyed && this.options.initialOnboarding) {
      await this.#presentOnboardingIntents(this.options.initialOnboarding);
    }
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
      this.#message = [this.#message, "Directory not yet approved: create it and reselect it before making changes."].filter(Boolean).join(" ");
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
    if (identity === null) throw new Error("Directory is not approved. Create it and reselect it before making changes.");
    return { path: rootPath, identity };
  }

  #onKeyPress = (key: KeyEvent): void => {
    void this.#handleKey(key).catch((error) => this.#showError(error));
  };

  #onSelection = (selection: Selection): void => {
    if (this.#mode === "help") return;
    const text = selection.getSelectedText();
    if (text === "") return;
    const revision = this.#revision;
    void (async () => {
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
    })();
  };

  #showInlineNotice(message: string): void {
    if (this.#destroyed) return;
    clearTimeout(this.#transientMessageTimer);
    this.#transientMessage = "";
    this.#message = message;
    if (this.#noticeText) this.#noticeText.content = escapeTerminalSingleLine(message);
  }

  async #handleKey(key: KeyEvent): Promise<void> {
    if (this.#busy) return;
    if (this.#mode === "help") {
      key.stopPropagation();
      if (key.name === "escape" || key.name === "?" || key.sequence === "?") {
        this.#mode = this.#helpReturnMode;
        this.#helpOverlay?.destroyRecursively();
        this.#helpOverlay = null;
        this.#helpContent = null;
        if (this.#screen) this.#screen.opacity = 1;
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
        if (!this.#confirmation?.informational) {
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
      } else if (key.name === "y" || (key.name === "return" && this.#confirmationSelection === "approve")) {
        await this.#finishConfirmation(true);
      } else if (key.name === "n" || key.name === "escape" || key.name === "return") {
        await this.#finishConfirmation(false);
      }
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
      else if (key.name === "i") await this.#prepareInit();
      else if (key.name === "n") this.#beginEntry("remote-name");
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
    else if (key.name === "r") await this.#reload();
    else if (key.name === "i" && this.options.selectSkillsDir) await this.#chooseSkillsDir();
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
    if ((mode === "commit-message" || mode === "remote-name" || mode === "remote-url" || mode === "fetch-remote" || mode === "fetch-branch") && this.#git?.kind !== "leaf") {
      this.#showError("Git actions require the selected directory to be the Git top-level.");
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
      void this.#applySearchFilter().catch((error) => this.#showError(error));
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
    this.#mode = this.#mode === "commit-message" || this.#mode === "remote-name" || this.#mode === "remote-url" ? "git" : "browse";
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
      if (confirmation.cancel) void confirmation.cancel().catch((error) => {
        process.stderr.write(`Prepared change cleanup failed: ${escapeTerminalSingleLine(redactGitUrl(errorMessage(error)))}\n`);
      });
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

  async #chooseSkillsDir(): Promise<void> {
    if (!this.options.selectSkillsDir) return;
    const outcome: { result: SkillsOnboardingResult | null } = { result: null };
    await this.#runExclusive(async () => {
      this.renderer.suspend();
      let selected: SkillsRootSelection | null = null;
      try {
        outcome.result = await this.options.selectSkillsDir!(this.#skillsDir);
        selected = outcome.result?.root ?? null;
      } finally {
        this.renderer.resume();
      }
      if (!selected || this.#destroyed || (selected.path === this.#skillsDir && selected.identity === this.#selection.identity)) return;
      this.#revision++;
      this.#fileRevision++;
      this.#updateRevision++;
      this.#selection = { ...selected };
      this.#skillsDir = selected.path;
      this.#skills = [];
      this.#skillFiles = [];
      this.#selectedText = "";
      this.#selectedSource = "";
      this.#selectedLineCount = null;
      this.#selectedIndex = 0;
      this.#searchFilter = "";
      this.#scope = "all";
      this.#state = "all";
      this.#input = "";
      this.#replacementSkill = null;
      this.#searchResults = [];
      this.#searchResultIndex = 0;
      this.#contextMenu = null;
      clearTimeout(this.#searchDebounceTimer);
      clearTimeout(this.#transientMessageTimer);
      this.#transientMessage = "";
      this.#availableUpdates.clear();
      this.#message = "";
      this.#git = null;
      this.#gitStatus = "";
      this.#gitResult = "";
      this.#gitDiff = "";
      this.#gitSelectedIndex = 0;
      this.#gitStatusFilter = "all";
      this.#gitFullContext = false;
      this.#gitFiles = [];
      await this.#recoverInstallation();
      await this.#reload();
    });
    if (!this.#destroyed && outcome.result) await this.#presentOnboardingIntents(outcome.result);
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
    this.#scope = this.#scope === "all" ? "source" : this.#scope === "source" ? "local" : this.#scope === "local" ? "unknown" : "all";
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
        lines: [
          `From: ${quoteTerminalPath(skill.path)}`,
          `To: ${quoteTerminalPath(destination)}`,
          `Entry: ${skill.entryKind}${skill.linkTarget !== null ? ` -> ${quoteTerminalPath(skill.linkTarget)}` : ""}`,
          "Moves only this entry; dependent links may dangle until it returns.",
          "Ownership and local changes may be unknown; source metadata is not permission.",
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
      lockEntry: skill.lockEntry ? { ...skill.lockEntry } : null,
      provenance: { ...skill.provenance },
    }));
    this.#confirm({
      title: "Review saved sources",
      lines: [
        `Installation: ${quoteTerminalPath(root.path)}`,
        "Saved source associations are not authenticated. Approval permits contacting these sources.",
        ...snapshots.flatMap((skill) => skill.lockEntry && skill.provenance.kind === "source" ? [
          `Skill: ${quoteTerminalPath(skill.path)}`,
          `Source: ${quoteTerminalPath(skill.lockEntry.source)}`,
          `URL: ${quoteTerminalPath(skill.lockEntry.sourceUrl)}`,
          `Ref: ${quoteTerminalPath(skill.lockEntry.ref ?? "HEAD")}`,
          `Skill path: ${quoteTerminalPath(skill.lockEntry.skillPath)}`,
        ] : []),
      ],
      returnMode: "browse",
      approve: async () => {
        if (this.#destroyed || revision !== this.#revision) throw new Error("Selected installation changed since source review.");
        await assertApprovedSkillsRoot(root);
        await approve(root, snapshots);
      },
    });
  }

  async #reviewUpdateCheck(): Promise<void> {
    const skills = this.#skills;
    if (!skills.some((skill) => skill.lockEntry && skill.provenance.kind === "source")) {
      await this.#runExclusive(() => this.#checkForUpdates(skills));
      return;
    }
    this.#reviewSources(skills, async (_root, snapshots) => this.#checkForUpdates(snapshots));
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
      this.#showError("No skills have a matching saved source association. Select a skill and supply a source to review a replacement.");
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
      this.#reviewPrepared(changes, "browse", skipped.length ? [`Skipped without a matching saved source association: ${skipped.join(", ")}. Select a skill and press u to supply a source.`] : []);
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
      const files = discovery.kind === "leaf" ? await getStatus(root) : [];
      if (revision !== this.#revision || this.#destroyed) return;
      this.#git = discovery;
      this.#gitFiles = files;
      this.#gitStatus = discovery.kind === "leaf"
        ? `Git: leaf · branch ${discovery.branch ?? "detached"}${discovery.head ? "" : " (unborn)"} · upstream ${discovery.upstream ?? "none"} · ${files.length} changed skill path${files.length === 1 ? "" : "s"}`
        : discovery.kind === "parent"
          ? `Containing repository: ${discovery.topLevel}. Git actions require a separate leaf repository.`
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

  #parentInitializationLines(parent: string | null, tracked: boolean | undefined, excluded: boolean | undefined, exclusionFile: string | null | undefined): string[] {
    if (!parent) return [];
    const relative = path.relative(parent, this.#skillsDir).split(path.sep).join("/");
    const commandsSafe = [parent, relative].every((value) => escapeTerminalSingleLine(value) === value);
    return [
      `Containing repository: ${quoteTerminalPath(parent)}`,
      `Parent tracks selected paths: ${tracked === undefined ? "unknown" : tracked ? "yes" : "no"}`,
      `Parent excludes selected path: ${excluded === undefined ? "unknown" : excluded ? "yes" : "no"}`,
      `Parent exclusion file: ${exclusionFile ? quoteTerminalPath(exclusionFile) : "unavailable"}`,
      ...(commandsSafe ? [
        `Inspect tracked paths: git -C ${shellQuote(parent)} --literal-pathspecs ls-files -- ${shellQuote(relative)}`,
        `Inspect exclusion: git -C ${shellQuote(parent)} check-ignore -v -- ${shellQuote(`${relative}/`)}`,
      ] : ["The paths contain terminal controls; inspect tracked files and exclusions with a tool that accepts the exact paths."]),
      "Do not untrack parent files. If appropriate, manually add a directory-wide exclusion in the parent's exclusion file, escaping Git pattern characters; then verify it.",
      "A parent can still force-add an embedded repository as a Git link; it is not a submodule.",
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

  async #presentOnboardingIntents(intents: Pick<SkillsOnboardingResult, "reviewInitialize" | "reviewBackup">): Promise<void> {
    if (!intents.reviewInitialize && !intents.reviewBackup) return;
    if (this.#selection.identity === null) {
      this.#showError("Git setup and backup are unavailable: create the selected directory and reselect it first.");
      return;
    }
    const revision = this.#revision;
    await this.#runExclusive(async () => {
      this.#mode = "git";
      await this.#refreshGit();
    });
    if (this.#destroyed || revision !== this.#revision) return;
    if (intents.reviewInitialize) {
      const opened = await this.#prepareInit(
        intents.reviewBackup ? () => this.#presentOnboardingBackup(revision) : undefined,
      );
      if (opened || this.#destroyed || revision !== this.#revision) return;
    }
    if (intents.reviewBackup) await this.#presentOnboardingBackup(revision);
  }

  async #presentOnboardingBackup(revision: number): Promise<void> {
    if (this.#destroyed || revision !== this.#revision) return;
    const git = this.#git;
    if (!git || git.kind !== "leaf") {
      this.#showError(`Backup unavailable: initialize the selected leaf repository first. ${this.#gitStatus}`);
      return;
    }
    if (git.remotes.length === 0) {
      this.#beginEntry("remote-name");
      return;
    }
    await this.#preparePush();
    if (!this.#destroyed && revision === this.#revision && this.#mode !== "confirm") {
      this.#showError(`Backup review unavailable: ${this.#message} Create a first commit and configure an unambiguous branch remote or upstream, then press p to review the push.`);
    }
  }

  async #prepareInit(after?: () => Promise<void>): Promise<boolean> {
    const git = this.#git;
    if (!git || git.kind === "error" || git.kind === "unavailable") {
      this.#showError(this.#gitStatus || "Git discovery is unavailable.");
      return false;
    }
    if (git.kind === "leaf") {
      this.#showError("The selected directory is already a Git repository.");
      return false;
    }
    const blocked = git.kind === "parent" && (git.parentTracked !== false || git.parentExcluded !== true);
    if (blocked) {
      this.#confirm({
        title: "Git initialization blocked",
        lines: [`Selected directory: ${quoteTerminalPath(this.#skillsDir)}`, ...this.#parentInitializationLines(git.topLevel, git.parentTracked, git.parentExcluded, git.exclusionFile)],
        returnMode: "git",
        informational: true,
        approve: async () => {},
        after,
      });
      return true;
    }
    let opened = false;
    await this.#runExclusive(async () => {
      const root = this.#approvedRoot();
      const preview = await previewInitialize(root);
      this.#confirm({
        title: "Initialize Git",
        lines: [
          `Selected directory: ${quoteTerminalPath(preview.root)}`,
          ...this.#parentInitializationLines(preview.parent, preview.parentTracked, preview.parentExcluded, preview.exclusionFile),
          "Only the selected directory will be initialized. No commit or remote is created.",
        ],
        returnMode: "git",
        approve: async () => this.#completeGitAction(() => initializeSkillsRepo(root, preview)),
        after,
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
    if (this.#git?.kind !== "leaf" || this.#git.remotes.length > 0) {
      this.#mode = "git";
      this.#showError("A remote can only be added to a leaf repository without an existing remote.");
      return;
    }
    await this.#runExclusive(async () => {
      const root = this.#approvedRoot();
      const preview = await previewAddRemote(root, name, url);
      this.#confirm({
        title: "Add backup remote",
        lines: [
          `Repository: ${quoteTerminalPath(preview.root)}`,
          `Remote: ${preview.name}`,
          `URL: ${preview.url}`,
          ...this.#gitMetadataLines(preview.root, preview),
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
        lines: [
          `Repository: ${quoteTerminalPath(preview.root)}`,
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
    if (this.#git?.kind === "leaf" && this.#git.remotes.length > 1) {
      this.#beginEntry("fetch-remote");
    } else if (this.#git?.kind === "leaf" && this.#git.remotes.length === 1 && !this.#git.branch) {
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
        lines: [
          `Repository: ${quoteTerminalPath(preview.root)}`, `Remote: ${preview.remote}`, `Fetch URL: ${preview.fetchUrl}`,
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
      const lines = [
        `Repository: ${quoteTerminalPath(preview.root)}`, `Remote: ${preview.remote}`, `Push URL: ${preview.pushUrl}`,
        ...this.#gitMetadataLines(preview.root, preview.binding),
        `Branch: ${preview.branch}`, `Upstream: ${preview.upstream ?? "none"}`, `Destination: ${preview.destination}`,
        ...(preview.localRemote ? [
          `Local bare destination: ${quoteTerminalPath(preview.localRemote.path)}`,
          `Local destination identity: device ${preview.localRemote.identity.dev}, inode ${preview.localRemote.identity.ino}`,
          "Local receiver hooks are disabled for this push.",
        ] : []),
        "Outgoing commits and paths:",
        ...preview.outgoing.flatMap((commit) => [`${commit.id} ${commit.subject}`, ...commit.paths.map((file) => `  ${quoteTerminalPath(file)}`)]),
        preview.warning,
        "Git cannot determine provider privacy. The destination determines who can read this backup.",
      ];
      this.#confirm({
        title: "Review push",
        lines,
        returnMode: "git",
        approve: async () => {
          this.#confirm({
            title: "Check provider access",
            lines: [
              `Destination: ${preview.pushUrl}`,
              "Have you checked on the provider who can read this backup?",
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
        lines: [
          `Repository: ${quoteTerminalPath(preview.root)}`, `Remote: ${preview.remote}`, `Fetch URL: ${preview.fetchUrl}`,
          ...this.#gitMetadataLines(preview.root, preview.binding),
          `Branch: ${preview.branch}`, `Upstream: ${preview.upstream}`, `Destination: ${preview.destination}`,
          `Current: ${preview.head}`, `Target: ${preview.target}`,
          "Incoming commits and paths:",
          ...preview.commits.flatMap((commit) => [`${commit.id} ${commit.subject}`, ...commit.paths.map((file) => `  ${quoteTerminalPath(file)}`)]),
          "Pull is fast-forward only and affects the repository, not just one skill.",
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
      this.#gitResult = result.stdout || result.stderr || result.command;
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
    this.#detailContent = null;
    this.#metadataContent = null;
    this.#confirmationContent = null;
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
      opacity: this.#mode === "confirm" || this.#mode === "search-results" || this.#mode === "help" ? 0.1 : 1,
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
    header.add(new TextRenderable(this.renderer, {
      content: escapeTerminalSingleLine(isGitMode
        ? `Git · ${this.#git?.kind ?? "error"} · ${this.#visibleGitFiles.length}/${this.#gitFiles.length} files · status: ${this.#gitStatusFilter}`
        : `Skills ${this.#visibleSkills.length} shown · scope: ${this.#scope} · state: ${this.#state}${this.#searchFilter === "" ? "" : ` · filter: ${this.#searchFilter} (Esc to clear)`}`),
      fg: colors.accent,
      attributes: TextAttributes.BOLD,
      height: 1,
      wrapMode: "none",
      selectable: false,
    }));
    if (!isGitMode) {
      const shortcuts = new BoxRenderable(this.renderer, {
        height: 1,
        marginLeft: "auto",
        flexDirection: "row",
        overflow: "hidden",
      });
      shortcuts.add(new TextRenderable(this.renderer, {
        content: t`up/down navigate · space select · / search · ${fg(colors.accent)(bold("s"))}cope · ${fg(colors.accent)(bold("e"))}nabled`,
        fg: colors.muted,
        height: 1,
        wrapMode: "none",
        selectable: false,
      }));
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
      height: 3,
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
        content: t`${fg(colors.accent)(bold("o"))}pen · ${fg(colors.accent)(bold("space"))} enable/disable · ${fg(colors.accent)(bold("r"))}efresh · ${fg(colors.accent)(bold("u"))}pdate · u${fg(colors.accent)(bold("p"))}date all · ${fg(colors.accent)(bold("v"))} check · ${fg(colors.accent)(bold("a"))}dd · ${fg(colors.accent)(bold("d"))}elete · ${fg(colors.accent)(bold("g"))}it${this.options.selectSkillsDir ? " · i installation" : ""} · ${fg(colors.accent)(bold("q"))}uit`,
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
    this.#noticeText = new TextRenderable(this.renderer, {
      content: escapeTerminalSingleLine(notice), fg: colors.warning, height: 1, wrapMode: "none", selectable: false,
    });
    footer.add(this.#noticeText);
    footer.add(new TextRenderable(this.renderer, {
      content: `Directory: ${quoteTerminalPath(this.#skillsDir)} | ${escapeTerminalSingleLine(this.#gitStatus || "Git: checking...")}`,
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
      const label = escapeTerminalSingleLine(`${skill.enabled ? "[on]" : "[off]"} [${skill.provenance.kind}] ${skill.name}${this.#availableUpdates.has(skill.id) ? " *" : ""}`);
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
        content: escapeTerminalSingleLine(`${skill.enabled ? "[on]" : "[off]"} [${skill.provenance.kind}] ${skill.name}${this.#availableUpdates.has(skill.id) ? " *" : ""}`),
        fg: skill.orphaned ? colors.warning : skill.enabled ? colors.enabled : colors.disabled,
        attributes: selected ? TextAttributes.BOLD : 0,
        onMouseDown: (event) => {
          if (event.button === RIGHT_MOUSE_BUTTON) void this.#openContextMenu(index, event.x, event.y).catch((error) => this.#showError(error));
          else void this.#selectIndex(index).catch((error) => this.#showError(error));
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
      const label = `${"  ".repeat(file.depth)}${quoteTerminalPath(path.basename(file.path))}${file.kind === "directory" ? "/" : ""}`;
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
              if (event.button === RIGHT_MOUSE_BUTTON) void this.#openFileContextMenu(index, event.x, event.y).catch((error) => this.#showError(error));
              else void this.#selectFile(index).catch((error) => this.#showError(error));
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
        onMouseDown: () => { void this.#runContextMenuAction(action).catch((error) => this.#showError(error)); },
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
        content: escapeTerminalSingleLine(this.#gitFiles.length === 0 ? this.#gitStatus || "Git status unavailable." : `No ${this.#gitStatusFilter} files.`),
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
        onMouseDown: () => { void this.#selectGitFile(index).catch((error) => this.#showError(error)); },
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
          content: escapeTerminalMultiline(this.#gitDiff || (this.#gitFiles.length === 0 ? this.#gitStatus : "No diff available.")),
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
        skill.provenance.kind === "source"
          ? `Source: ${skill.provenance.source} · ${skill.provenance.sourceUrl}`
          : formatSkillSource(skill),
        `Author: ${skill.authors.length ? skill.authors.join(", ") : "unknown"}`,
        `Entry: ${skill.entryKind}${skill.linkTarget !== null ? ` -> ${quoteTerminalPath(skill.linkTarget)}` : ""}`,
        ...(skill.recordedSource ? [`Recorded source (unverified): ${skill.recordedSource.source}`] : []),
        ...skill.warnings.map((warning) => `Warning: ${warning}`),
        ...metadata,
        ...(description ? [description.value] : []),
      ] : ["No skill selected."];
      const safeFacts = facts.map(escapeTerminalSingleLine);
      const textWidth = Math.max(10, this.renderer.width - this.#skillListWidth() - filePaneWidth - 4);
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
      title: selectedFile?.kind === "file" ? quoteTerminalPath(selectedFile.path) : undefined,
      titleColor: colors.accent,
      contentOptions: { backgroundColor: colors.panel },
      viewportOptions: { backgroundColor: colors.panel },
      scrollbarOptions: { trackOptions: { foregroundColor: colors.accent, backgroundColor: colors.panel } },
    });
    this.#detailContent = content;
    if (this.#detailRendering === "markdown" && this.#treeSitterClient) {
      content.add(new CodeRenderable(this.renderer, {
        content: escapeTerminalMultiline(this.#selectedText || (selectedFile?.kind === "file" ? "Empty file." : "No SKILL.md body.")),
        filetype: "markdown",
        conceal: true,
        syntaxStyle: markdownStyle,
        treeSitterClient: this.#treeSitterClient,
        width: "100%",
        height: Math.max(1, this.#selectedText.split("\n").length + 2),
        wrapMode: "word",
      }));
    } else if (this.#detailRendering === "markdown") {
      content.add(new TextRenderable(this.renderer, { content: escapeTerminalMultiline(this.#selectedText || (selectedFile?.kind === "file" ? "Empty file." : "No SKILL.md body.")), fg: colors.text, wrapMode: "word" }));
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

  #createHelpDialog(scrollTop = 0): BoxRenderable {
    const overlay = new BoxRenderable(this.renderer, {
      position: "absolute",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      paddingX: 1,
      paddingY: 1,
      onMouse: (event) => event.stopPropagation(),
    });
    const dialog = new BoxRenderable(this.renderer, {
      width: "100%",
      height: "100%",
      minWidth: 1,
      minHeight: 1,
      maxWidth: 82,
      maxHeight: 22,
      flexDirection: "column",
      border: true,
      borderColor: colors.accent,
      title: "Keyboard help",
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
    this.#helpContent = content;
    if (scrollTop) {
      this.renderer.once("frame", () => {
        if (this.#helpContent === content && !content.isDestroyed) content.scrollTo(scrollTop);
      });
    }
    content.add(new TextRenderable(this.renderer, {
      content: [
        "Navigation",
        "Up/down or j/k   Select a skill, Git file or search result",
        "[ / ] or Ctrl+p/n   Select previous/next skill file",
        "Alt+up/down   Select previous/next skill file",
        ", or .   Scroll skill metadata",
        "PgUp/PgDn   Scroll the file or Git diff",
        "?   Open help from browsing or Git",
        "",
        "Browsing",
        "/   Filter skills; Enter applies, Esc clears",
        "s   Cycle source scope     e   Cycle enabled state",
        "t   Toggle Markdown/raw    o   Open selected file",
        "Space   Review enable/disable     d or Delete   Review removal",
        "u   Update selected        p   Update all",
        "v   Review update check    a   Search and add skills",
        "r   Refresh                i   Select installation, if available",
        "g   Open Git               q   Quit",
        "",
        "Git",
        "s   Cycle status filter    t   Toggle full diff context",
        "r   Refresh                i   Initialize repository",
        "n   Add remote             c   Review commit",
        "f   Fetch                  l   Pull",
        "p   Push                   Esc   Return to browsing",
        "Git actions depend on repository state and require review.",
        "",
        "Reviews and prompts",
        "Up/down or PgUp/PgDn   Scroll review",
        "Left/right or Tab   Select Cancel/Approve",
        "y   Approve     n or Esc   Cancel     Enter   Use selection",
        "Informational reviews: Enter or Esc closes",
        "Search results: Up/down or j/k select, Enter prepares, o opens repo",
        "Text prompts: ? is literal, Enter submits, Esc cancels",
        "Context menu: Up/down or j/k select, Enter acts; Esc clears filter or closes",
      ].join("\n"),
      width: "100%",
      height: "auto",
      fg: colors.text,
      wrapMode: "word",
      selectable: false,
    }));
    dialog.add(content);
    dialog.add(new TextRenderable(this.renderer, {
      content: " ?/Esc close · Up/down scroll · PgUp/PgDn page",
      fg: colors.muted,
      height: 1,
      wrapMode: "none",
      selectable: false,
    }));
    overlay.add(dialog);
    return overlay;
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
    const width = Math.max(10, Math.min(110, this.renderer.width - 4));
    const height = Math.max(5, Math.min(this.renderer.height - 3, 22));
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
    this.#confirmationContent = content;
    content.add(new TextRenderable(this.renderer, {
      content: confirmation.lines.map(escapeTerminalSingleLine).join("\n"),
      width: "100%",
      height: "auto",
      fg: colors.text,
      wrapMode: "word",
    }));
    dialog.add(content);
    const buttons = new BoxRenderable(this.renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: colors.panel,
    });
    this.#confirmCancelButton = new TextRenderable(this.renderer, {
      content: confirmation.informational ? "[Enter/Esc] Close" : "[n/Esc/Enter] Cancel",
      fg: this.#confirmationSelection === "cancel" ? colors.enabled : colors.muted,
      bg: this.#confirmationSelection === "cancel" ? colors.selection : colors.panel,
      height: 1,
      selectable: false,
      onMouseDown: () => { void this.#finishConfirmation(false).catch((error) => this.#showError(error)); },
    });
    buttons.add(this.#confirmCancelButton);
    if (!confirmation.informational) {
      this.#confirmApproveButton = new TextRenderable(this.renderer, {
      content: "  [y] Approve",
      fg: this.#confirmationSelection === "approve" ? colors.enabled : colors.muted,
      bg: this.#confirmationSelection === "approve" ? colors.selection : colors.panel,
      height: 1,
      selectable: false,
      onMouseDown: () => { void this.#finishConfirmation(true).catch((error) => this.#showError(error)); },
      });
      buttons.add(this.#confirmApproveButton);
    }
    buttons.add(new TextRenderable(this.renderer, {
      content: "  Up/down or PgUp/PgDn scroll",
      fg: colors.muted,
      height: 1,
      selectable: false,
    }));
    dialog.add(buttons);
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
          onMouseDown: () => { void this.#installSelectedSearchResult(index).catch((error) => this.#showError(error)); },
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
  #gitToolbarText(): string {
    const controls = ["Esc close", "r local refresh"];
    if (this.#git?.kind === "none" || this.#git?.kind === "parent") controls.push("i initialize");
    if (this.#git?.kind === "leaf") {
      if (this.#git.remotes.length === 0) controls.push("n add remote");
      if (this.#gitFiles.length > 0) controls.push("c commit");
      if (this.#git.remotes.length > 0) controls.push("f fetch", "l pull", "p push");
    }
    return controls.join(" · ");
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
