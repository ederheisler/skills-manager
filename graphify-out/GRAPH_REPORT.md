# Graph Report - skill-manager  (2026-11-07)

## Corpus Check
- 185 files · ~304,165 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 11 file(s) not represented in the graph (top: (none) 9, .0 1, .template 1)

## Summary
- 2692 nodes · 5782 edges · 162 communities (150 shown, 12 thin omitted)
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 420 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3c0c38fc`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ~/.agent universal skills repo
- package.json
- src/ui/App.tsx
- skillsCli.ts
- frontmatter.ts
- containment.h
- compilerOptions
- SkillsManagerTui
- ref_node_path
- softwareUpdates.ts
- git-transaction.h
- gitTransactionWorker.ts
- .dispose
- appUpdateWorker.ts
- Solid bindings
- Custom keymap addons
- API and symbol index
- React bindings
- Core keymap API
- Animation and Timeline
- Keymap hosts
- Streaming audio
- ScrollBox
- Audio
- Audio capture and recording
- Clipboard
- Testing
- Syntax highlighting with Tree-sitter
- Texture and sprite helpers
- Code
- Drawing methods
- Custom renderables
- SoftwareUpdateService
- Input
- Markdown
- Plugin slots
- Buffer API
- NativeImage
- appUpdateHandoff.ts
- Yoga API
- git-transaction-state.h
- Text
- Textarea
- Editing buffers and views
- Universal addons
- Terminal capabilities
- TabSelect
- skills-boundary.c
- NativeSpanFeed
- Box
- Image
- Load plugins and modules at runtime
- Core plugin slots
- QR encoder
- ASCIIFont
- QR code
- Interaction, focus, and selection
- FrameBuffer color matrices
- Rendering diagnostics
- Line number gutter
- Console overlay
- Layout
- Renderer
- Text and terminal cells
- utility-types.ts
- TextTable
- Keyboard input
- Rendering pipeline
- Runtime and platform support
- React keymap integration
- Solid keymap integration
- tree.h
- appUpdateHandoff.test.ts
- Application data paths
- Environment variables
- Components
- Notifications
- Post-processing effects
- Keymap
- Package entry points
- Troubleshooting
- Diff
- ScrollBar
- Slider
- TimeToFirstDraw
- Colors
- skills-git-boundary.c
- Deploy an OpenTUI application
- Global constraints
- TypeScript Expert
- Getting started
- Node.js SEA
- softwareUpdateLifecycle.test.ts
- Quickstart
- Native crash debugging
- whats-next-for-opentui.mdx
- fixing-markdown-tables.mdx
- packages.md
- Select
- compilerOptions
- gitTransactionState.test.ts
- ts_diagnostic.py
- TypeScript Cheatsheet
- gitTransaction.test.ts
- devDependencies
- read-boundary.h
- SSH
- git.ts
- gitBoundary.test.ts
- createTestRenderer
- tree_check_mount_fd
- release-smoke.mjs
- .registry
- onboarding.ts
- .close
- build-identity.mjs
- Solid plugin slots
- Lifecycle and cleanup
- appBuild.test.ts
- skills
- Hooks
- hasErrorCode
- tui.test.ts
- Portable open-source release plan
- check-package.mjs
- list-boundary.h
- Renderables
- skills-manager design doc
- `@opentui/core`
- boundary.ts
- dependencies
- Test renderer
- scripts
- Open-source portability
- run
- Implementation slices and dependencies
- Key binding pipeline callbacks
- Method reference
- git.test.ts
- tui.ts
- Security policy
- contained
- Intercept callbacks
- Field compiler callbacks
- softwareUpdates.test.ts
- `@opentui/keymap`
- options
- Public registration APIs
- Other `@opentui/core` entry points
- Engine methods
- OpenTUI Skill

## God Nodes (most connected - your core abstractions)
1. `SkillsManagerTui` - 112 edges
2. `SoftwareUpdateService` - 48 edges
3. `tree_check_mount_fd()` - 44 edges
4. `tree_check_mount_entry()` - 39 edges
5. `tree_same_snapshot()` - 37 edges
6. `git_transaction_serve()` - 34 edges
7. `pull()` - 32 edges
8. `vitest` - 31 edges
9. `fail()` - 29 edges
10. `quoteTerminalPath()` - 29 edges

## Surprising Connections (you probably didn't know these)
- `Properties` --references--> `text()`  [INFERRED]
  .agents/skills/opentui/docs/components/ascii-font.mdx → tests/actions/gitTransaction.test.ts
- `External output` --references--> `text()`  [INFERRED]
  .agents/skills/opentui/docs/core-concepts/testing.mdx → tests/actions/gitTransaction.test.ts
- `Capture operations` --references--> `text()`  [INFERRED]
  .agents/skills/opentui/docs/reference/buffer-api.mdx → tests/actions/gitTransaction.test.ts
- `Task 5: `skills` CLI wrapper` --references--> `skills()`  [INFERRED]
  docs/superpowers/plans/2026-09-16-skills-manager-implementation.md → tests/startupConfig.test.ts
- `Runtime and distribution` --references--> `skills()`  [INFERRED]
  docs/superpowers/plans/2026-11-03-portable-open-source-release.md → tests/startupConfig.test.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Skill update flow (snapshot/restore/update/re-disable)** — docs_superpowers_specs_2026_09_16_skills_manager_design_update_flow, docs_superpowers_specs_2026_09_16_skills_manager_design_skills_cli, src_actions_update [INFERRED 0.75]
- **Enable/disable skill flow** — agents_enable_disable_mechanism, docs_superpowers_specs_2026_09_16_skills_manager_design_enable_disable_mechanism, src_actions_toggle, docs_superpowers_specs_2026_09_16_skills_manager_design_agent_repo [INFERRED 0.80]
- **Provenance derivation pattern** — docs_superpowers_specs_2026_09_16_skills_manager_design_provenance, docs_superpowers_specs_2026_09_16_skills_manager_design_skill_lock_json, src_state_provenance, agents_provenance [INFERRED 0.80]

## Communities (162 total, 12 thin omitted)

### Community 0 - "~/.agent universal skills repo"
Cohesion: 0.15
Nodes (7): ~/.agent universal skills repo, skills CLI, skills-manager (project), ~/.agent repo (design doc), User-owned skills repository (historical design), .skill-lock.json, UI: Status line

### Community 1 - "package.json"
Cohesion: 0.12
Nodes (16): bin, skills-manager, cpu, engines, node, files, license, name (+8 more)

### Community 2 - "src/ui/App.tsx"
Cohesion: 0.33
Nodes (6): src/cli.tsx, src/ui/App.tsx, UI: Detail pane, src/ui/Detail.tsx, UI: List view, src/ui/List.tsx

### Community 3 - "skillsCli.ts"
Cohesion: 0.06
Nodes (75): Task 3: Repo scanner, execa, approveSkillsRoot(), assertApprovedSkillsRoot(), readParentSkillLock(), checkForUpdates(), checkOne(), CheckRunner (+67 more)

### Community 4 - "frontmatter.ts"
Cohesion: 0.36
Nodes (9): yaml, checkDocumentBudget(), checkSyntaxDepth(), FrontmatterError, ParsedSkillDocument, parseSkillDocument(), SizeAndDepth, SkillFrontmatter (+1 more)

### Community 5 - "containment.h"
Cohesion: 0.10
Nodes (10): skills_apply_write_boundary(), skills_apply_write_boundary_with_remote(), skills_boundary_directory(), skills_boundary_escape(), skills_boundary_null_device(), skills_boundary_path_matches(), skills_boundary_paths_match(), skills_write_boundary_profile() (+2 more)

### Community 6 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, declaration, esModuleInterop, module, moduleResolution, outDir, resolveJsonModule, rootDir (+4 more)

### Community 7 - "SkillsManagerTui"
Cohesion: 0.06
Nodes (17): UpdateComponent, SkillsRootSelection, formatSkillSource(), escapeCharacter(), escapeTerminalMultiline(), escapeTerminalSingleLine(), quoteTerminalPath(), checkSummary() (+9 more)

### Community 8 - "ref_node_path"
Cohesion: 0.07
Nodes (29): Data model: reconciling three sources of truth, vitest, flags, helpers, nativeDir, listSkillPaths(), readSkillFiles(), readSkillPath() (+21 more)

### Community 9 - "softwareUpdates.ts"
Cohesion: 0.14
Nodes (12): Task 11: CLI entry point and manual smoke test, COMPONENTS, Flight, overlaps(), PrivateJsonSnapshot, SoftwareUpdateCheck, SoftwareUpdatePreferences, StoredConsent (+4 more)

### Community 10 - "git-transaction.h"
Cohesion: 0.09
Nodes (76): git_transaction_serve(), git_tx_absent(), git_tx_body_drain(), git_tx_body_read(), git_tx_check_mount_entry(), git_tx_check_mount_fd(), git_tx_copy_body(), git_tx_forget_lock() (+68 more)

### Community 11 - "gitTransactionWorker.ts"
Cohesion: 0.08
Nodes (77): acquire(), applyPullWorktree(), blobContent(), checkCleanupEvidence(), checkPullTransition(), cleanup(), cleanupPull(), commit() (+69 more)

### Community 12 - ".dispose"
Cohesion: 0.16
Nodes (14): `AudioCaptureStream`, `AudioRecorder`, Stream and recorder members, Ownership and cleanup, Disposal, Public service API, Audio, Clipboard (+6 more)

### Community 13 - "appUpdateWorker.ts"
Cohesion: 0.14
Nodes (21): ActiveChild, assertDestination(), canonicalPath(), checkInterrupted(), ChildResult, displayPath(), HandledSignal, identity() (+13 more)

### Community 14 - "Solid bindings"
Cohesion: 0.05
Nodes (37): 1. Configure TypeScript, 2. Configure Bun, 3. Configure Node compilation, 4. Create the app, API reference, Components, `createScrollbackWriter(node, options?)`, `Dynamic` (+29 more)

### Community 15 - "Custom keymap addons"
Cohesion: 0.17
Nodes (11): Addon shape, Custom keymap addons, Disambiguation callbacks, Errors and lifecycle, Event listeners, Event-match callbacks, Layer analyzers, Related pages (+3 more)

### Community 16 - "API and symbol index"
Cohesion: 0.14
Nodes (14): API and symbol index, Entry point index, Native distribution packages, `@opentui/qrcode`, `@opentui/react`, `@opentui/solid`, `@opentui/ssh`, `@opentui/three` (+6 more)

### Community 17 - "React bindings"
Cohesion: 0.13
Nodes (15): API reference, Component extension, Components, `createRoot(renderer)`, Example: login form, Installation, Lifecycle and cleanup, Next (+7 more)

### Community 18 - "Core keymap API"
Cohesion: 0.11
Nodes (17): Active keys, Command queries, Commands, Construct the engine, Core keymap API, Default key syntax, Display helpers, Errors, cleanup, and limits (+9 more)

### Community 19 - "Animation and Timeline"
Cohesion: 0.10
Nodes (20): Add numeric animation, Animate a renderable, Animation and Timeline, `AnimationOptions`, Choose a constructor, Cleanup, Easing names, Framework mapping (+12 more)

### Community 20 - "Keymap hosts"
Cohesion: 0.10
Nodes (20): Built-in helper summary, Create an HTML keymap, Create an OpenTUI keymap, Custom hosts, Focus hierarchy, Host cleanup, Host metadata, Host responsibilities (+12 more)

### Community 21 - "Streaming audio"
Cohesion: 0.13
Nodes (14): Buffering and backpressure, Choose an entry method, ICY metadata, Members, state, and statistics, Next, Play a URL, Reconnect URL streams, Shared options (+6 more)

### Community 22 - "ScrollBox"
Cohesion: 0.10
Nodes (19): Additional properties, Availability, Basic usage, Bidirectional scrolling, Customizing scrollbars, Customizing sub-components, Internal components, Keyboard navigation (+11 more)

### Community 23 - "Audio"
Cohesion: 0.15
Nodes (12): Audio, Control voices and groups, Create the engine, Events and errors, Load sounds, Low-level start options, Mix PCM and inspect the master tap, Next (+4 more)

### Community 24 - "Audio capture and recording"
Cohesion: 0.13
Nodes (14): Audio capture and recording, Capture a PCM stream, Capture options, Capture start-option detail, Direct method reference, Exclusive capture ownership, Next, PCM stream behavior (+6 more)

### Community 25 - "Clipboard"
Cohesion: 0.12
Nodes (16): Cancellation, Clearing, Clipboard, Demo, Host-only usage, Limits and options, Next, Quick start (+8 more)

### Community 26 - "Testing"
Cohesion: 0.18
Nodes (10): Framework tests, Keymap tests, ManualClock, MockTreeSitterClient, Mouse input, Next, Small callback spies, Terminal capabilities (+2 more)

### Community 27 - "Syntax highlighting with Tree-sitter"
Cohesion: 0.11
Nodes (18): Choose client ownership, Client API, Configure a parser, Configure language injections, Configure the worker, Convert highlights to styled text, Global client, Handle errors and warnings (+10 more)

### Community 28 - "Texture and sprite helpers"
Cohesion: 0.11
Nodes (17): Lifecycle and API, Low-level canvas and Three namespace, Methods, Options and defaults, Options and defaults, Particles and explosions, Physics adapters, Public export groups (+9 more)

### Community 29 - "Code"
Cohesion: 0.12
Nodes (16): Additional properties, Availability, Basic usage, Code, Concealment, Creating syntax styles, Inherited from TextBufferRenderable, Markdown styles (+8 more)

### Community 30 - "Drawing methods"
Cohesion: 0.12
Nodes (16): Availability, Basic usage, colorMatrix / colorMatrixUniform, drawFrameBuffer, drawImage, Drawing methods, drawText, Example: game canvas (+8 more)

### Community 31 - "Custom renderables"
Cohesion: 0.14
Nodes (13): Build a renderable, Choose the base class, Clean up ownership, Custom renderables, Handle coordinates, clipping, and buffering, Handle failures, Handle resize, Measure intrinsic size (+5 more)

### Community 33 - "Input"
Cohesion: 0.12
Nodes (15): Availability, Basic usage, Change event, Enter event, Events, Example: login form, Focus states, Getting the current value (+7 more)

### Community 34 - "Markdown"
Cohesion: 0.12
Nodes (15): Availability, Basic usage, Concealment, Custom fenced-code languages, Custom node rendering, Fenced language normalization, Markdown, Markdown tables (+7 more)

### Community 35 - "Plugin slots"
Cohesion: 0.15
Nodes (12): Concepts, Create a registry, Define slots and host context, Error handling, Next, Plugin slots, `PluginErrorEvent`, `PluginErrorReport` (+4 more)

### Community 36 - "Buffer API"
Cohesion: 0.12
Nodes (15): Basic drawing, Boxes and grids, Buffer API, Capture operations, Cell model, Clipping and opacity, Color transforms, Compose buffers and views (+7 more)

### Community 37 - "NativeImage"
Cohesion: 0.12
Nodes (15): Accepted sources, Encoded PNG retention, Errors and limits, Format behavior, Load and dispose an image, Load options, Metadata, NativeImage (+7 more)

### Community 38 - "appUpdateHandoff.ts"
Cohesion: 0.15
Nodes (24): typescript, canonicalPath(), checkoutRoot(), configuredCache(), entryIdentity(), globalInstallation(), GlobalUpdateInstallation, isWithin() (+16 more)

### Community 39 - "Yoga API"
Cohesion: 0.12
Nodes (15): Baselines and containing blocks, `Config`, Enum styles, Enums and constants, Factories and tree ownership, Imports, Layout state, Measure and dirtied callbacks (+7 more)

### Community 40 - "git-transaction-state.h"
Cohesion: 0.28
Nodes (21): git_state_check_baseline(), git_state_check_control_file(), git_state_delete_request(), git_state_directory_current(), git_state_discard_known(), git_state_moved_matches(), git_state_named_identity(), git_state_open() (+13 more)

### Community 41 - "Text"
Cohesion: 0.13
Nodes (14): Align lines, Availability, Available attributes, Available style functions, Basic usage, Example: status bar, Positioning, Properties (+6 more)

### Community 42 - "Textarea"
Cohesion: 0.13
Nodes (14): Availability, Basic usage, Cursor and selection control, Cursor movement, Editing, Placeholder styling, Properties, Related concepts (+6 more)

### Community 43 - "Editing buffers and views"
Cohesion: 0.13
Nodes (14): `cursorCharacterOffset` limitation, `EditBuffer`, Editing buffers and views, `EditorView`, Experimental extmarks, Fixed limits, Layer and ownership model, Line information (+6 more)

### Community 44 - "Universal addons"
Cohesion: 0.13
Nodes (14): Base-layout fallback, Built-in keymap addons, Default keys, Diagnostics, Edit-buffer commands, Edit-buffer integration, Ex commands, Field addons (+6 more)

### Community 45 - "Terminal capabilities"
Cohesion: 0.13
Nodes (14): Images and pixels, Input, output, and width, Links, clipboard, and notifications, Multiplexers, Next, Overrides, Public types, Read a changing snapshot (+6 more)

### Community 46 - "TabSelect"
Cohesion: 0.15
Nodes (12): Availability, Basic usage, Events, Example: tabbed interface, Item selected, Keyboard navigation, Programmatic control, Related concepts (+4 more)

### Community 47 - "skills-boundary.c"
Cohesion: 0.14
Nodes (52): ascii_name_equal(), bootstrap_file(), bootstrap_state(), check_owned_entry(), checked_fingerprint(), clear_journal(), close_context(), create_owned_file() (+44 more)

### Community 48 - "NativeSpanFeed"
Cohesion: 0.18
Nodes (10): Drain and backpressure, Handler errors, Low-level example, Native producer statuses, NativeSpanFeed, Next, Options and defaults, Renderer-managed use (+2 more)

### Community 49 - "Box"
Cohesion: 0.15
Nodes (12): Availability, Basic usage, Border styles, Box, Example: card component, Layout container, Mouse events, Properties (+4 more)

### Community 50 - "Image"
Cohesion: 0.15
Nodes (12): Availability, File transport, Image, Kitty transport, Options and state, React, Related components, Renderable API (+4 more)

### Community 51 - "Load plugins and modules at runtime"
Cohesion: 0.15
Nodes (12): Choose one installer, Configure a custom Bun plugin, Configure before loading, Default module maps, Executables and sidecars, Load plugins and modules at runtime, Next, Option and entry types (+4 more)

### Community 52 - "Core plugin slots"
Cohesion: 0.17
Nodes (11): Basic usage, Core plugin slots, `CoreManagedSlot` interface, `CorePlugin` interface, Example, Instance API, Managed slot contributions, Node ownership (+3 more)

### Community 53 - "QR encoder"
Cohesion: 0.15
Nodes (12): Encode text, Encoding options, GS1/FNC1, Matrix and metadata, Other encoders, QR encoder, Raw bytes and explicit ECI, Root exports and limits (+4 more)

### Community 54 - "ASCIIFont"
Cohesion: 0.17
Nodes (11): ASCIIFont, Availability, Available fonts, Basic usage, Color effects, Dynamic text, Example: welcome screen, Positioning (+3 more)

### Community 55 - "QR code"
Cohesion: 0.17
Nodes (11): Availability, Basic usage, Error correction, Fallback content, Properties, QR code, React JSX, Related APIs (+3 more)

### Community 56 - "Interaction, focus, and selection"
Cohesion: 0.18
Nodes (10): Hit order and propagation, Hover, drag, and capture, Interaction, focus, and selection, Mouse events, Mouse pointer styles, Next, Renderable focus, Terminal focus reports (+2 more)

### Community 57 - "FrameBuffer color matrices"
Cohesion: 0.17
Nodes (11): Apply a cell mask, Apply a uniform matrix, Cell color semantics, Cell mask, Exported matrices, FrameBuffer color matrices, Matrix format, Methods (+3 more)

### Community 58 - "Rendering diagnostics"
Cohesion: 0.18
Nodes (10): Buffer and input diagnostics, Choose the diagnostic, Combined renderer statistics, Frame identifiers and events, Native render statistics, Next, On-screen diagnostics, Rendering diagnostics (+2 more)

### Community 59 - "Line number gutter"
Cohesion: 0.18
Nodes (10): Availability, Basic usage, Initial visibility, Line number gutter, Line signs and colors, Methods, Properties, Related components (+2 more)

### Community 60 - "Console overlay"
Cohesion: 0.18
Nodes (10): Caller information, Captured calls, Console and renderer output, Console overlay, Enable capture, Environment variables, Focused keys, Next (+2 more)

### Community 61 - "Layout"
Cohesion: 0.18
Nodes (10): Alignment, Automatic and intrinsic size, Cell rounding, Common failures, Layout, Next, Relative and absolute flow, Resize behavior (+2 more)

### Community 62 - "Renderer"
Cohesion: 0.17
Nodes (11): Choose a render schedule, Choose a screen mode, Create a renderer, Custom streams, Live rendering, Next, Read capability state, Renderer (+3 more)

### Community 63 - "Text and terminal cells"
Cohesion: 0.18
Nodes (10): Add terminal links, Align lines, Interpret selection offsets, Keep text units separate, Next, Style text, Text and terminal cells, Understand wide cells (+2 more)

### Community 64 - "utility-types.ts"
Cohesion: 0.04
Nodes (45): Arguments, AssertEqual, AsyncFunction, AtLeast, Brand, DeepMutable, DeepPartial, DeepReadonly (+37 more)

### Community 65 - "TextTable"
Cohesion: 0.20
Nodes (9): Availability, Basic usage, Borders and spacing, Column sizing and wrapping, Content, Options, Related components, Selection (+1 more)

### Community 66 - "Keyboard input"
Cohesion: 0.22
Nodes (9): Configure component key bindings, Control propagation, Handle app-wide keys, Handle raw sequences, Keyboard input, Next, Paste events, Read `KeyEvent` (+1 more)

### Community 67 - "Rendering pipeline"
Cohesion: 0.20
Nodes (9): 1. Retained state becomes dirty, 2. Yoga computes layout, 3. Render traversal composes cells, 4. Native code diffs and writes output, Image protocol resolution, Inspect frames, Next, Rendering pipeline (+1 more)

### Community 68 - "Runtime and platform support"
Cohesion: 0.20
Nodes (9): Advanced Node.js FFI note, Native artifacts, Next, Node.js permissions, Package requirements, Runtime and platform support, Runtime assets, Runtime versions (+1 more)

### Community 69 - "React keymap integration"
Cohesion: 0.20
Nodes (9): Basic setup, Exports, Provider behavior, React keymap integration, Reactive reads, Related pages, Store matchers, Test the integration (+1 more)

### Community 70 - "Solid keymap integration"
Cohesion: 0.20
Nodes (9): Basic setup, Exports, Provider behavior, Related pages, Signal matchers, Solid keymap integration, Test the integration, `useBindings()` (+1 more)

### Community 71 - "tree.h"
Cohesion: 0.14
Nodes (34): fingerprint_skill(), git_tx_ref_lock_open(), git_tx_reserved_component(), git_tx_root_list(), git_tx_root_path_open(), git_tx_utf8(), git_state_digest(), bootstrap_file_matches() (+26 more)

### Community 72 - "appUpdateHandoff.test.ts"
Cohesion: 0.16
Nodes (10): repository, resetWorkspace(), stageRuntime(), transpiled(), updateFixture(), updateFixtures, updateProcesses, updateWatchers (+2 more)

### Community 73 - "Application data paths"
Cohesion: 0.20
Nodes (9): Application data paths, Change the application name, Defaults, Directory creation, Next, Process-global lifecycle, Public API, Read paths (+1 more)

### Community 74 - "Environment variables"
Cohesion: 0.18
Nodes (10): Build-time and startup values, Diagnostics, Environment variables, `OPENTUI_LIBC`, `OTUI_ASSET_ROOT`, `OTUI_TREE_SITTER_WORKER_PATH`, Remote sessions, Security-sensitive diagnostics (+2 more)

### Community 75 - "Components"
Cohesion: 0.22
Nodes (8): Components, Diagnostics, Display and layout, Graphics and media, Inline text elements, Input and selection, Rich content, Scrolling

### Community 76 - "Notifications"
Cohesion: 0.22
Nodes (8): Detection timing, Example, Multiplexers, Next, Notifications, Overrides, Protocol output, Terminal behavior

### Community 77 - "Post-processing effects"
Cohesion: 0.22
Nodes (8): Effect inventory, Filter inventory, Mutation and failure behavior, Next, Post-processing effects, Register a callback, Tagged-cell safety, Time-unit inconsistencies

### Community 78 - "Keymap"
Cohesion: 0.22
Nodes (8): Add features, Choose the input level, Create an OpenTUI keymap, Hosts and framework state, Install, Keymap, Next, Register, dispatch, and query

### Community 79 - "Package entry points"
Cohesion: 0.22
Nodes (8): `@opentui/core`, `@opentui/keymap`, `@opentui/qrcode`, `@opentui/react`, `@opentui/solid`, `@opentui/ssh`, `@opentui/three`, Package entry points

### Community 80 - "Troubleshooting"
Cohesion: 0.22
Nodes (8): Integrations and protocols, Native builds across worktrees, Next, Node.js and native loading, Runtime-loaded modules, Terminal and output, Test waits, Troubleshooting

### Community 81 - "Diff"
Cohesion: 0.25
Nodes (7): Availability, Basic usage, Diff, Properties, Related components, Renderable API, Split view scroll sync

### Community 82 - "ScrollBar"
Cohesion: 0.25
Nodes (7): Availability, Basic usage, Keyboard controls, Properties, Related concepts, Renderable API, ScrollBar

### Community 83 - "Slider"
Cohesion: 0.25
Nodes (7): Availability, Basic usage, Properties, Related components, Renderable API, Slider, Vertical slider

### Community 84 - "TimeToFirstDraw"
Cohesion: 0.25
Nodes (7): Availability, Core API, Options, React, Runtime properties, Solid, TimeToFirstDraw

### Community 85 - "Colors"
Cohesion: 0.25
Nodes (7): Colors, Create `RGBA` values, Next, Parse everyday colors, Preserve terminal palette intent, Understand packed transport, Use alpha

### Community 86 - "skills-git-boundary.c"
Cohesion: 0.12
Nodes (32): ascii_equal(), ascii_lower(), config_is_bare(), failure(), invalid(), main(), match_decimal_identity(), name_character() (+24 more)

### Community 87 - "Deploy an OpenTUI application"
Cohesion: 0.25
Nodes (7): Build a Node.js SEA, Build Bun executables, Choose a deployment form, Deploy an OpenTUI application, Expose an SSH service, Next, Release checks

### Community 88 - "Global constraints"
Cohesion: 0.16
Nodes (13): Global constraints, skills-manager implementation plan, Task 10: Git panel (diff, commit, push), Task 1: Project scaffolding, Task 2: Types and provenance classification, Task 4: Enable/disable toggle, Task 5: `skills` CLI wrapper, Task 7: Display formatting (+5 more)

### Community 89 - "TypeScript Expert"
Cohesion: 0.05
Nodes (36): Advanced Patterns, Advanced Type System Expertise, AI-Assisted Development, Biome vs ESLint, CLI Debugging Tools, Code Organization, Code Review Checklist, Complex Error Patterns (+28 more)

### Community 90 - "Getting started"
Cohesion: 0.29
Nodes (6): Choose a framework, Explore the examples, Find a topic, Getting started, Give an agent the docs, Start with the quickstart

### Community 91 - "Node.js SEA"
Cohesion: 0.29
Nodes (6): Bun, Extraction ownership, Linux libc, Node asset manifest, Node.js SEA, Standalone executables

### Community 92 - "softwareUpdateLifecycle.test.ts"
Cohesion: 0.12
Nodes (19): Activity, cacheFile(), COMMIT_A, COMMIT_B, digest(), fixture(), NOW, privateFile() (+11 more)

### Community 93 - "Quickstart"
Cohesion: 0.33
Nodes (5): Continue, Create the app, Prerequisite, Quickstart, Run it

### Community 94 - "Native crash debugging"
Cohesion: 0.40
Nodes (4): For contributors, Load the symbols, Native crash debugging, Report a crash

### Community 95 - "whats-next-for-opentui.mdx"
Cohesion: 0.40
Nodes (4): Moving the render tree into the native core, Node compatibility, Not a big rewrite, Overhauling text rendering

### Community 96 - "fixing-markdown-tables.mdx"
Cohesion: 0.50
Nodes (3): A better idea, "But that's just OpenTUI being slow", The naive approach

### Community 97 - "packages.md"
Cohesion: 0.50
Nodes (3): APIs, Components, Packages

### Community 98 - "Select"
Cohesion: 0.14
Nodes (13): Availability, Basic usage, Events, Example: file menu, Item selected, Keyboard navigation, Option structure, Programmatic control (+5 more)

### Community 107 - "compilerOptions"
Cohesion: 0.06
Nodes (33): compilerOptions, allowSyntheticDefaultImports, baseUrl, declaration, declarationMap, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames (+25 more)

### Community 108 - "gitTransactionState.test.ts"
Cohesion: 0.18
Nodes (6): driverSource, initializeState(), privateFile(), request(), Response, StateSession

### Community 109 - "ts_diagnostic.py"
Cohesion: 0.12
Nodes (10): check_any_usage(), check_monorepo(), check_performance(), check_tooling(), check_tsconfig(), check_type_assertions(), check_type_errors(), check_versions() (+2 more)

### Community 110 - "TypeScript Cheatsheet"
Cohesion: 0.13
Nodes (14): Best Practices, Branded Types, Conditional Types, Discriminated Unions, Generics, Mapped Types, Module Declarations, Template Literal Types (+6 more)

### Community 111 - "gitTransaction.test.ts"
Cohesion: 0.12
Nodes (28): CommitPreview, GitResult, previewCommit(), PullPreview, recoverSkillsGit(), runConfinedNodeWorker(), commitIndexTransaction(), indexFingerprint() (+20 more)

### Community 112 - "devDependencies"
Cohesion: 0.33
Nodes (6): devDependencies, tsx, @types/node, typescript, vitest, @xterm/headless

### Community 113 - "read-boundary.h"
Cohesion: 0.21
Nodes (21): boundary_identity_fd(), boundary_absolute(), boundary_check_chain(), boundary_check_parent(), boundary_cleanup_path(), boundary_content(), boundary_count_lines(), boundary_directory_identity() (+13 more)

### Community 114 - "SSH"
Cohesion: 0.13
Nodes (15): Authentication, Basic server, Builder lifecycle, Cleanup, errors, and shutdown, Host keys, Install and runtime, Logging middleware, Middleware (+7 more)

### Community 115 - "git.ts"
Cohesion: 0.10
Nodes (67): addRemoteApproved(), allowed(), allStatus(), blockingAncestor(), branchRemote(), checkRef(), commitDetails(), commitHistory() (+59 more)

### Community 116 - "gitBoundary.test.ts"
Cohesion: 0.13
Nodes (23): checkDirectory(), checkHelperPlatform(), checkIdentity(), ConfinedGitOptions, ConfinedGitResult, DirectoryIdentity, gitExecutable(), helper (+15 more)

### Community 117 - "createTestRenderer"
Cohesion: 0.25
Nodes (8): Testing, Test, Test interaction, Test keyboard input, Keyboard input, Testing strategy, Test renderer output, createTestRenderer()

### Community 118 - "tree_check_mount_fd"
Cohesion: 0.15
Nodes (25): Graph maintenance, git_tx_empty_at(), git_tx_empty_directory(), boundary_git_tree_hash(), git_tree_add_entry(), git_tree_check_directory(), git_tree_close(), git_tree_free() (+17 more)

### Community 119 - "release-smoke.mjs"
Cohesion: 0.12
Nodes (18): args, browseInTerminal(), exec, externalLock, git(), globalApp, globalBin, globalPrefix (+10 more)

### Community 120 - ".registry"
Cohesion: 0.14
Nodes (13): `SlotRenderable` options, Basic usage, Example, Lifecycle and disposal, Optional convenience helper, Plugin failure placeholders, React plugin slots, `ReactSlotOptions` (for `createSlot`) (+5 more)

### Community 121 - "onboarding.ts"
Cohesion: 0.05
Nodes (53): Events and error actions, Events and errors, Attach a process, Availability, Cursor and paint, Draw VT output, Embedded terminal, Focus and keyboard (+45 more)

### Community 122 - ".close"
Cohesion: 0.22
Nodes (8): Connection cleanup, PCM buffering and completion, PCM format and ownership, Play decoded PCM, Output streams and feeds, Borrowed callback memory, Close and destruction, cancel()

### Community 123 - "build-identity.mjs"
Cohesion: 0.27
Nodes (11): archiveIdentity(), captureBuildIdentity(), checkoutIdentity(), exec, generated, ignoredNonBuild(), objectHash(), root (+3 more)

### Community 124 - "Solid plugin slots"
Cohesion: 0.22
Nodes (8): Basic usage, Example, Lifecycle and disposal, Optional convenience helper, Plugin failure placeholders, `<Slot>` props, Solid plugin slots, `SolidSlotOptions` (for `createSlot`)

### Community 125 - "Lifecycle and cleanup"
Cohesion: 0.18
Nodes (10): Custom renderables, Destroy the renderer, Framework roots, Keep cleanup with creation, Lifecycle and cleanup, Next, React, Signal handling (+2 more)

### Community 126 - "appBuild.test.ts"
Cohesion: 0.26
Nodes (13): commitFixture(), environment(), extractArchive(), generate(), git(), productionBuildFixture(), project, readCompiledBuild() (+5 more)

### Community 127 - "skills"
Cohesion: 0.12
Nodes (19): Background skill update checks, Upstream skills versions, Vercel skills CLI updates, Execution order, Phase 1: P0 inert parsing and filesystem boundaries, Phase 2: P0 scope upstream CLI operations, Phase 3: P0 scope Git operations, Phase 4: P1 discovery, adoption, and onboarding (+11 more)

### Community 128 - "Hooks"
Cohesion: 0.20
Nodes (10): Hooks, `useBlur(handler)`, `useFocus(handler)`, `useKeyboard(handler, options?)`, `useOnResize(callback)`, `usePaste(handler)`, `useRenderer()`, `useSelectionHandler(handler)` (+2 more)

### Community 129 - "hasErrorCode"
Cohesion: 0.21
Nodes (8): atomicPrivateJson(), attemptTimestamp(), canonicalCandidate(), readPrivateJson(), readPrivateJsonState(), responseText(), validatePrivateStat(), hasErrorCode()

### Community 130 - "tui.test.ts"
Cohesion: 0.16
Nodes (10): ApplicationUpdateHandoff, applications, commitFixture(), createTrackedTui(), execFileAsync, git(), initGit(), renderers (+2 more)

### Community 131 - "Portable open-source release plan"
Cohesion: 0.12
Nodes (16): Accepted decisions, Adoption and Git safety, Approved concurrency contract, Declared author and source, Earlier candidate checks and limits, Git safety, Network and mutation policy, Plan scope (+8 more)

### Community 132 - "check-package.mjs"
Cohesion: 0.18
Nodes (8): directories, expected, generatedAssets, inspectSources(), listed, manifest, requiredAssets, root

### Community 133 - "list-boundary.h"
Cohesion: 0.41
Nodes (11): boundary_list(), boundary_list_add(), boundary_list_append(), boundary_list_check_named(), boundary_list_check_opened(), boundary_list_json_path(), boundary_list_subtree(), boundary_list_validate_name() (+3 more)

### Community 134 - "Renderables"
Cohesion: 0.25
Nodes (7): Create and update, Destruction, Hide or detach, Layout properties, Next, Renderables, Tree membership

### Community 135 - "skills-manager design doc"
Cohesion: 0.31
Nodes (4): Decisions, skills CLI (vercel-labs), skills-manager design doc, Tech stack: TypeScript, Ink, execa, gray-matter

### Community 137 - "`@opentui/core`"
Cohesion: 0.20
Nodes (10): Buffers, editing, animation, and effects, Components and component helpers, Images, audio, and native span output, Input and selection, Low-level native binding exports, `@opentui/core`, Plugins, console, and process services, Renderer and render tree (+2 more)

### Community 138 - "boundary.ts"
Cohesion: 0.08
Nodes (44): Task 6: Update flow (restore → update → re-disable), Task 9: Git status indicator, then App wiring (navigation, filter, actions), ApprovedSkillsRoot, BoundaryProcess, checkedFingerprint(), checkedName(), checkHelperPlatform(), cleanupGitIndex() (+36 more)

### Community 139 - "dependencies"
Cohesion: 0.40
Nodes (5): dependencies, execa, @opentui/core, skills, yaml

### Community 140 - "Test renderer"
Cohesion: 0.33
Nodes (6): External output, Returned setup, Setup semantics and defaults, Styled frames, Test renderer, Waiting for observable output

### Community 141 - "scripts"
Cohesion: 0.40
Nodes (5): scripts, build, dev, prepare, test

### Community 142 - "Open-source portability"
Cohesion: 0.11
Nodes (18): Application update planning, Automated releases, Browse category labels, Concurrency limits, Context, Decision, Existing repository choice, Hosted history replacement (+10 more)

### Community 143 - "run"
Cohesion: 0.36
Nodes (8): missing(), put(), run(), assertBrowseSafety(), prepare(), snapshot(), visit(), successful()

### Community 144 - "Implementation slices and dependencies"
Cohesion: 0.15
Nodes (13): 1. Prove and package build identity, 2. Add consent, scheduling, and comparison, 3. Add review and guarded handoff, 4. Refresh the Vercel skills CLI, 5. Update affected interfaces and documentation, Acceptance and runtime verification, Approved user flow, Behavior and evidence when proposed (+5 more)

### Community 145 - "Key binding pipeline callbacks"
Cohesion: 0.33
Nodes (6): `BindingExpander`, `BindingParser`, `BindingTransformer`, Key binding pipeline callbacks, `LayerBindingsTransformer`, Pipeline order and disposal

### Community 146 - "Method reference"
Cohesion: 0.33
Nodes (6): Method reference, Mixing, tap, and statistics, Output lifecycle, Playback devices, Sounds, Voices and groups

### Community 147 - "git.test.ts"
Cohesion: 0.22
Nodes (13): expectOutsideUnchanged(), git(), stagedSkill(), addFakeSignature(), git(), initialCommit(), parentPeer(), parentRepository() (+5 more)

### Community 148 - "tui.ts"
Cohesion: 0.13
Nodes (16): GitDiscovery, filterSkills(), SkillScope, SkillState, SkillFile, colors, Confirmation, ContextAction (+8 more)

### Community 149 - "Security policy"
Cohesion: 0.25
Nodes (8): Application and CLI updates, Git and remote actions, Release status, Remote actions and privacy, Report a vulnerability, Security policy, Selecting and changing skills, Threat model

### Community 150 - "contained"
Cohesion: 0.67
Nodes (4): contained(), executableWithin(), installedApp(), packageFromApp()

### Community 153 - "Intercept callbacks"
Cohesion: 0.40
Nodes (5): After key dispatch, Before key dispatch, Intercept callbacks, Intercept order, Raw input

### Community 154 - "Field compiler callbacks"
Cohesion: 0.40
Nodes (5): Command fields, Field compiler callbacks, Key binding fields, Layer fields, Reactive matchers

### Community 156 - "softwareUpdates.test.ts"
Cohesion: 0.25
Nodes (3): roots, service(), services

### Community 157 - "`@opentui/keymap`"
Cohesion: 0.18
Nodes (12): Root exports, Command callbacks, `CommandResolver`, `CommandTransformer`, Addons, Extras and graph, Frameworks and runtime modules, `@opentui/keymap` (+4 more)

### Community 158 - "options"
Cohesion: 0.50
Nodes (4): Properties, Properties, Public wrapper API, options()

### Community 159 - "Public registration APIs"
Cohesion: 0.40
Nodes (5): Commands and dispatch, Diagnostics, intercepts, and resources, Fields, tokens, and patterns, Key binding pipeline, Public registration APIs

### Community 160 - "Other `@opentui/core` entry points"
Cohesion: 0.40
Nodes (5): Other `@opentui/core` entry points, Runtime plugin support, Testing, Tree-sitter assets, worker, and Node assets, Yoga

### Community 162 - "Engine methods"
Cohesion: 0.50
Nodes (4): Engine methods, Events, intercepts, and resources, Extension registration, Layers, data, and queries

### Community 163 - "OpenTUI Skill"
Cohesion: 0.25
Nodes (8): Choose packages, Current skill entry pages, OpenTUI Skill, Path invariant, Quick routing by intent, Reading order by area, Terminal layout defaults, Working rules

## Knowledge Gaps
- **1136 isolated node(s):** `$schema`, `display`, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` (+1131 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1325 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Graph maintenance` connect `tree_check_mount_fd` to `tree.h`, `boundary.ts`, `gitTransactionState.test.ts`, `gitTransaction.test.ts`, `Implementation slices and dependencies`, `git.ts`?**
  _High betweenness centrality (0.202) - this node is a cross-community bridge._
- **Why does `SoftwareUpdateService` connect `SoftwareUpdateService` to `hasErrorCode`, `tui.test.ts`, `SkillsManagerTui`, `softwareUpdates.ts`, `.dispose`, `softwareUpdateLifecycle.test.ts`, `tui.ts`, `.registry`, `softwareUpdates.test.ts`?**
  _High betweenness centrality (0.087) - this node is a cross-community bridge._
- **Why does `text()` connect `gitTransaction.test.ts` to `tui.test.ts`, `OpenTUI Skill`, `Buffer API`, `Test renderer`, `ASCIIFont`?**
  _High betweenness centrality (0.081) - this node is a cross-community bridge._
- **Are the 38 inferred relationships involving `tree_check_mount_fd()` (e.g. with `Graph maintenance` and `fingerprint_skill()`) actually correct?**
  _`tree_check_mount_fd()` has 38 INFERRED edges - model-reasoned connections that need verification._
- **What connects `$schema`, `display`, `strict` to the rest of the system?**
  _1136 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.11764705882352941 - nodes in this community are weakly interconnected._
- **Should `skillsCli.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.058767319636884856 - nodes in this community are weakly interconnected._