# Graph Report - skill-manager  (2026-11-04)

## Corpus Check
- 172 files · ~250,807 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 10 file(s) not represented in the graph (top: (none) 9, .0 1)

## Summary
- 2391 nodes · 4876 edges · 154 communities (143 shown, 11 thin omitted)
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 319 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5178c7a1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ~/.agent universal skills repo
- package.json
- src/ui/App.tsx
- Skill
- repo.ts
- tree.h
- compilerOptions
- SkillsManagerTui
- ref_node_path
- list-boundary.h
- git-transaction.h
- gitTransactionWorker.ts
- upstreamProvenance.ts
- skills-manager
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
- Embedded terminal
- Input
- Markdown
- Plugin slots
- Buffer API
- NativeImage
- SSH
- Yoga API
- Select
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
- React plugin slots
- Solid plugin slots
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
- OpenTUI Skill
- TypeScript Expert
- Getting started
- Node.js SEA
- Quickstart
- Native crash debugging
- whats-next-for-opentui.mdx
- fixing-markdown-tables.mdx
- packages.md
- skillsCli.ts
- compilerOptions
- .close
- ts_diagnostic.py
- TypeScript Cheatsheet
- tree_check_mount_entry
- gitTransaction.test.ts
- tree_check_mount_fd
- boundary.ts
- git.ts
- gitBoundary.test.ts
- tui.ts
- git-tree-hash.h
- release-smoke.mjs
- previewPull
- tui.test.ts
- checkUpdates.ts
- gitTransaction.ts
- onboarding.ts
- Lifecycle and cleanup
- cli.ts
- gitTransactionState.test.ts
- Hooks
- CommandResult
- `@opentui/core`
- Portable open-source release plan
- check-package.mjs
- containment.h
- Renderables
- skills-manager design doc
- Execution order
- createTestRenderer
- tree_same_snapshot
- `@opentui/keymap`
- Test renderer
- Key binding pipeline callbacks
- Open-source portability
- Services and registrations
- Intercept callbacks
- Field compiler callbacks
- Public registration APIs
- Other `@opentui/core` entry points
- types.ts
- Security policy
- sandbox.ts
- withSkillsLock

## God Nodes (most connected - your core abstractions)
1. `SkillsManagerTui` - 96 edges
2. `tree_check_mount_fd()` - 43 edges
3. `tree_check_mount_entry()` - 38 edges
4. `tree_same_snapshot()` - 36 edges
5. `git_transaction_serve()` - 34 edges
6. `pull()` - 31 edges
7. `fail()` - 29 edges
8. `prepareSourceChange()` - 27 edges
9. `vitest` - 26 edges
10. `withSkillsLock()` - 26 edges

## Surprising Connections (you probably didn't know these)
- `External output` --references--> `text()`  [INFERRED]
  .agents/skills/opentui/docs/core-concepts/testing.mdx → tests/actions/gitTransaction.test.ts
- `Test keyboard input` --references--> `createTestRenderer()`  [INFERRED]
  .agents/skills/opentui/docs/core-concepts/keyboard.mdx → tests/tui.test.ts
- `Test the integration` --references--> `createTestRenderer()`  [INFERRED]
  .agents/skills/opentui/docs/keymap/react.mdx → tests/tui.test.ts
- `Test the integration` --references--> `createTestRenderer()`  [INFERRED]
  .agents/skills/opentui/docs/keymap/solid.mdx → tests/tui.test.ts
- `Testing` --references--> `createTestRenderer()`  [INFERRED]
  .agents/skills/opentui/docs/reference/api-index.mdx → tests/tui.test.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Skill update flow (snapshot/restore/update/re-disable)** — docs_superpowers_specs_2026_09_16_skills_manager_design_update_flow, docs_superpowers_specs_2026_09_16_skills_manager_design_skills_cli, src_actions_update [INFERRED 0.75]
- **Enable/disable skill flow** — agents_enable_disable_mechanism, docs_superpowers_specs_2026_09_16_skills_manager_design_enable_disable_mechanism, src_actions_toggle, docs_superpowers_specs_2026_09_16_skills_manager_design_agent_repo [INFERRED 0.80]
- **Provenance derivation pattern** — docs_superpowers_specs_2026_09_16_skills_manager_design_provenance, docs_superpowers_specs_2026_09_16_skills_manager_design_skill_lock_json, src_state_provenance, agents_provenance [INFERRED 0.80]

## Communities (154 total, 11 thin omitted)

### Community 0 - "~/.agent universal skills repo"
Cohesion: 0.15
Nodes (7): ~/.agent universal skills repo, skills CLI, skills-manager (project), ~/.agent repo (design doc), User-owned skills repository (historical design), .skill-lock.json, UI: Status line

### Community 1 - "package.json"
Cohesion: 0.06
Nodes (32): bin, skills-manager, cpu, dependencies, execa, @opentui/core, skills, yaml (+24 more)

### Community 2 - "src/ui/App.tsx"
Cohesion: 0.33
Nodes (6): src/cli.tsx, src/ui/App.tsx, UI: Detail pane, src/ui/Detail.tsx, UI: List view, src/ui/List.tsx

### Community 3 - "Skill"
Cohesion: 0.11
Nodes (21): Global constraints, skills-manager implementation plan, Task 11: CLI entry point and manual smoke test, Task 1: Project scaffolding, Task 2: Types and provenance classification, Task 4: Enable/disable toggle, Task 5: `skills` CLI wrapper, Task 7: Display formatting (+13 more)

### Community 4 - "repo.ts"
Cohesion: 0.16
Nodes (17): Data model: reconciling three sources of truth, countSkillPathLines(), readSkillPath(), declaredAuthors(), countSkillFileLines(), listSkillFiles(), previewText(), readFrontmatter() (+9 more)

### Community 5 - "tree.h"
Cohesion: 0.19
Nodes (26): fingerprint_skill(), git_tx_ref_lock_open(), git_state_digest(), boundary_identity_fd(), tree_component(), tree_copy_at(), tree_fingerprint_at(), tree_hash_link() (+18 more)

### Community 6 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, declaration, esModuleInterop, module, moduleResolution, outDir, resolveJsonModule, rootDir (+4 more)

### Community 7 - "SkillsManagerTui"
Cohesion: 0.08
Nodes (10): PreparedSkillChange, SkillsRootSelection, SkillFile, escapeCharacter(), escapeTerminalMultiline(), escapeTerminalSingleLine(), quoteTerminalPath(), errorMessage() (+2 more)

### Community 8 - "ref_node_path"
Cohesion: 0.13
Nodes (10): vitest, flags, helpers, nativeDir, FileOpener, openFile(), openRepository(), openTarget() (+2 more)

### Community 9 - "list-boundary.h"
Cohesion: 0.41
Nodes (11): boundary_list(), boundary_list_add(), boundary_list_append(), boundary_list_check_named(), boundary_list_check_opened(), boundary_list_json_path(), boundary_list_subtree(), boundary_list_validate_name() (+3 more)

### Community 10 - "git-transaction.h"
Cohesion: 0.08
Nodes (82): git_transaction_serve(), git_tx_absent(), git_tx_body_drain(), git_tx_body_read(), git_tx_check_mount_entry(), git_tx_check_mount_fd(), git_tx_copy_body(), git_tx_empty_at() (+74 more)

### Community 11 - "gitTransactionWorker.ts"
Cohesion: 0.08
Nodes (72): Events and errors, acquire(), applyPullWorktree(), blobContent(), checkCleanupEvidence(), checkPullTransition(), cleanup(), cleanupPull() (+64 more)

### Community 12 - "upstreamProvenance.ts"
Cohesion: 0.16
Nodes (26): execa, approveSkillsRoot(), fingerprintSkillContents(), gitTreeHash(), readManagedMetadata(), readParentSkillLock(), prepareReplacement(), prepareUpdate() (+18 more)

### Community 13 - "skills-manager"
Cohesion: 0.33
Nodes (6): Development, More information, Quick start, Requirements, skills-manager, Using the app safely

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
Cohesion: 0.08
Nodes (24): Active keys, Command queries, Commands, Construct the engine, Core keymap API, Default key syntax, Display helpers, Engine methods (+16 more)

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
Cohesion: 0.10
Nodes (19): Audio, Control voices and groups, Create the engine, Events and errors, Load sounds, Low-level start options, Method reference, Mix PCM and inspect the master tap (+11 more)

### Community 24 - "Audio capture and recording"
Cohesion: 0.11
Nodes (17): Audio capture and recording, `AudioCaptureStream`, `AudioRecorder`, Capture a PCM stream, Capture options, Capture start-option detail, Direct method reference, Exclusive capture ownership (+9 more)

### Community 25 - "Clipboard"
Cohesion: 0.11
Nodes (18): Cancellation, Clearing, Clipboard, Demo, Disposal, Host-only usage, Limits and options, Next (+10 more)

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

### Community 32 - "Embedded terminal"
Cohesion: 0.12
Nodes (16): Events and error actions, Attach a process, Availability, Cursor and paint, Draw VT output, Embedded terminal, Focus and keyboard, I/O model (+8 more)

### Community 33 - "Input"
Cohesion: 0.12
Nodes (15): Availability, Basic usage, Change event, Enter event, Events, Example: login form, Focus states, Getting the current value (+7 more)

### Community 34 - "Markdown"
Cohesion: 0.12
Nodes (15): Availability, Basic usage, Concealment, Custom fenced-code languages, Custom node rendering, Fenced language normalization, Markdown, Markdown tables (+7 more)

### Community 35 - "Plugin slots"
Cohesion: 0.12
Nodes (15): Concepts, Create a registry, Define slots and host context, Error handling, Next, Ordering, Plugin interface, Plugin slots (+7 more)

### Community 36 - "Buffer API"
Cohesion: 0.13
Nodes (14): Basic drawing, Boxes and grids, Buffer API, Cell model, Clipping and opacity, Color transforms, Compose buffers and views, Create and destroy a buffer (+6 more)

### Community 37 - "NativeImage"
Cohesion: 0.12
Nodes (15): Accepted sources, Encoded PNG retention, Errors and limits, Format behavior, Load and dispose an image, Load options, Metadata, NativeImage (+7 more)

### Community 38 - "SSH"
Cohesion: 0.13
Nodes (15): Authentication, Basic server, Builder lifecycle, Cleanup, errors, and shutdown, Host keys, Install and runtime, Logging middleware, Middleware (+7 more)

### Community 39 - "Yoga API"
Cohesion: 0.12
Nodes (15): Baselines and containing blocks, `Config`, Enum styles, Enums and constants, Factories and tree ownership, Imports, Layout state, Measure and dirtied callbacks (+7 more)

### Community 40 - "Select"
Cohesion: 0.13
Nodes (14): Availability, Basic usage, Events, Example: file menu, Item selected, Keyboard navigation, Option structure, Programmatic control (+6 more)

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
Cohesion: 0.14
Nodes (13): Availability, Basic usage, Events, Example: tabbed interface, Item selected, Keyboard navigation, Programmatic control, Properties (+5 more)

### Community 47 - "skills-boundary.c"
Cohesion: 0.16
Nodes (49): ascii_name_equal(), bootstrap_file(), check_owned_entry(), checked_fingerprint(), clear_journal(), close_context(), create_owned_file(), decode_hex() (+41 more)

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
Cohesion: 0.15
Nodes (12): Basic usage, Core plugin slots, `CoreManagedSlot` interface, `CorePlugin` interface, Example, Instance API, Managed slot contributions, Node ownership (+4 more)

### Community 53 - "QR encoder"
Cohesion: 0.15
Nodes (12): Encode text, Encoding options, GS1/FNC1, Matrix and metadata, Other encoders, QR encoder, Raw bytes and explicit ECI, Root exports and limits (+4 more)

### Community 54 - "ASCIIFont"
Cohesion: 0.18
Nodes (10): ASCIIFont, Availability, Available fonts, Basic usage, Color effects, Dynamic text, Example: welcome screen, Positioning (+2 more)

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
Cohesion: 0.20
Nodes (10): Configure component key bindings, Control propagation, Handle app-wide keys, Handle raw sequences, Keyboard input, Next, Paste events, Read `KeyEvent` (+2 more)

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

### Community 71 - "React plugin slots"
Cohesion: 0.20
Nodes (9): Basic usage, Example, Lifecycle and disposal, Optional convenience helper, Plugin failure placeholders, React plugin slots, `ReactSlotOptions` (for `createSlot`), `<Slot>` props (+1 more)

### Community 72 - "Solid plugin slots"
Cohesion: 0.20
Nodes (9): Basic usage, Example, Lifecycle and disposal, Optional convenience helper, Plugin failure placeholders, `<Slot>` props, Solid plugin slots, `SolidSlotOptions` (for `createSlot`) (+1 more)

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
Cohesion: 0.11
Nodes (32): ascii_equal(), ascii_lower(), config_is_bare(), failure(), invalid(), main(), match_decimal_identity(), name_character() (+24 more)

### Community 87 - "Deploy an OpenTUI application"
Cohesion: 0.25
Nodes (7): Build a Node.js SEA, Build Bun executables, Choose a deployment form, Deploy an OpenTUI application, Expose an SSH service, Next, Release checks

### Community 88 - "OpenTUI Skill"
Cohesion: 0.29
Nodes (7): Choose packages, Current skill entry pages, OpenTUI Skill, Path invariant, Reading order by area, Terminal layout defaults, Working rules

### Community 89 - "TypeScript Expert"
Cohesion: 0.06
Nodes (35): Advanced Patterns, Advanced Type System Expertise, AI-Assisted Development, Biome vs ESLint, CLI Debugging Tools, Code Organization, Code Review Checklist, Current Best Practices (+27 more)

### Community 90 - "Getting started"
Cohesion: 0.29
Nodes (6): Choose a framework, Explore the examples, Find a topic, Getting started, Give an agent the docs, Start with the quickstart

### Community 91 - "Node.js SEA"
Cohesion: 0.29
Nodes (6): Bun, Extraction ownership, Linux libc, Node asset manifest, Node.js SEA, Standalone executables

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

### Community 98 - "skillsCli.ts"
Cohesion: 0.11
Nodes (31): skills CLI (vercel-labs), directoryIdentity(), fingerprintSkill(), fingerprintTree(), listSkillPaths(), readSkillFiles(), removeDisposableTree(), runSingle() (+23 more)

### Community 107 - "compilerOptions"
Cohesion: 0.06
Nodes (33): compilerOptions, allowSyntheticDefaultImports, baseUrl, declaration, declarationMap, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames (+25 more)

### Community 108 - ".close"
Cohesion: 0.22
Nodes (8): Connection cleanup, PCM buffering and completion, PCM format and ownership, Play decoded PCM, Output streams and feeds, Borrowed callback memory, Close and destruction, Public wrapper API

### Community 109 - "ts_diagnostic.py"
Cohesion: 0.12
Nodes (10): check_any_usage(), check_monorepo(), check_performance(), check_tooling(), check_tsconfig(), check_type_assertions(), check_type_errors(), check_versions() (+2 more)

### Community 110 - "TypeScript Cheatsheet"
Cohesion: 0.13
Nodes (14): Best Practices, Branded Types, Conditional Types, Discriminated Unions, Generics, Mapped Types, Module Declarations, Template Literal Types (+6 more)

### Community 111 - "tree_check_mount_entry"
Cohesion: 0.31
Nodes (9): bootstrap_file_matches(), bootstrap_state(), check_marker(), cleanup_bootstrap(), open_owned_read(), owned_regular(), owned_regular_stat(), tree_check_created() (+1 more)

### Community 112 - "gitTransaction.test.ts"
Cohesion: 0.16
Nodes (18): Properties, Capture operations, Complex Error Patterns, GitResult, previewCommit(), baseCommit(), crashPreparedCommit(), git() (+10 more)

### Community 113 - "tree_check_mount_fd"
Cohesion: 0.27
Nodes (21): boundary_absolute(), boundary_check_chain(), boundary_check_parent(), boundary_cleanup_path(), boundary_content(), boundary_count_lines(), boundary_directory_identity(), boundary_dispose_error() (+13 more)

### Community 114 - "boundary.ts"
Cohesion: 0.09
Nodes (24): Task 6: Update flow (restore → update → re-disable), Task 9: Git status indicator, then App wiring (navigation, filter, actions), ApprovedSkillsRoot, checkedFingerprint(), checkedName(), deleteReviewedSkill(), encode(), fingerprintReviewedSkill() (+16 more)

### Community 115 - "git.ts"
Cohesion: 0.14
Nodes (25): Quick routing by intent, allowed(), blockingAncestor(), commitDetails(), config, currentRoots(), environment(), FetchPreview (+17 more)

### Community 116 - "gitBoundary.test.ts"
Cohesion: 0.12
Nodes (22): checkDirectory(), checkHelperPlatform(), checkIdentity(), ConfinedGitOptions, ConfinedGitResult, DirectoryIdentity, gitExecutable(), helper (+14 more)

### Community 117 - "tui.ts"
Cohesion: 0.10
Nodes (24): Task 10: Git panel (diff, commit, push), hasIndexTransaction(), fileIdentity(), GitDiscovery, initializationGuard(), initializeSkillsRepo(), previewFetch(), previewInitialize() (+16 more)

### Community 118 - "git-tree-hash.h"
Cohesion: 0.20
Nodes (17): boundary_git_tree_hash(), git_tree_add_entry(), git_tree_check_directory(), git_tree_close(), git_tree_free(), git_tree_hash_blob(), git_tree_hash_directory(), git_tree_open_entry() (+9 more)

### Community 119 - "release-smoke.mjs"
Cohesion: 0.14
Nodes (18): args, browseInTerminal(), exec, externalLock, git(), home, manifest, missing() (+10 more)

### Community 120 - "previewPull"
Cohesion: 0.22
Nodes (24): assertApprovedSkillsRoot(), allStatus(), branchRemote(), checkRef(), commitHistory(), decodeGitOutput(), digest(), discoverGit() (+16 more)

### Community 121 - "tui.test.ts"
Cohesion: 0.23
Nodes (7): fingerprintContents(), commitFixture(), execFileAsync, git(), initGit(), roots, savedSourceFixture()

### Community 122 - "checkUpdates.ts"
Cohesion: 0.15
Nodes (11): checkForUpdates(), githubRepository(), GitHubTree, GitHubTreeEntry, isGitHubTree(), skillDirectory(), TreeFetcher, UpdateCheckReport (+3 more)

### Community 123 - "gitTransaction.ts"
Cohesion: 0.28
Nodes (12): CommitPreview, GitBinding, PullPreview, commitIndexTransaction(), indexFingerprint(), Operation, pullIndexWorktreeTransaction(), recoverIndexTransaction() (+4 more)

### Community 124 - "onboarding.ts"
Cohesion: 0.27
Nodes (10): DirectoryCandidate, DirectorySelectionOptions, documentedSkillsDirectories(), InspectedSkillsDirectory, inspectSelectedSkillsDirectory(), isMissing(), OnboardingIO, resolveMissingDirectory() (+2 more)

### Community 125 - "Lifecycle and cleanup"
Cohesion: 0.18
Nodes (10): Custom renderables, Destroy the renderer, Framework roots, Keep cleanup with creation, Lifecycle and cleanup, Next, React, Signal handling (+2 more)

### Community 126 - "cli.ts"
Cohesion: 0.35
Nodes (7): main(), CliOptions, helpText, parseCliOptions(), runtimeError(), SkillsOnboardingResult, SkillsManagerTuiOptions

### Community 127 - "gitTransactionState.test.ts"
Cohesion: 0.18
Nodes (6): driverSource, initializeState(), privateFile(), request(), Response, StateSession

### Community 128 - "Hooks"
Cohesion: 0.20
Nodes (10): Hooks, `useBlur(handler)`, `useFocus(handler)`, `useKeyboard(handler, options?)`, `useOnResize(callback)`, `usePaste(handler)`, `useRenderer()`, `useSelectionHandler(handler)` (+2 more)

### Community 129 - "CommandResult"
Cohesion: 0.33
Nodes (7): Root exports, Command callbacks, `CommandResolver`, `CommandTransformer`, Root engine, CommandResult, Command

### Community 130 - "`@opentui/core`"
Cohesion: 0.20
Nodes (10): Buffers, editing, animation, and effects, Components and component helpers, Images, audio, and native span output, Input and selection, Low-level native binding exports, `@opentui/core`, Plugins, console, and process services, Renderer and render tree (+2 more)

### Community 131 - "Portable open-source release plan"
Cohesion: 0.12
Nodes (17): Accepted decisions, Adoption and Git safety, Approved concurrency contract, Declared author and source, Git safety, Implementation verification, 2026-11-04, Network and mutation policy, Platform coverage (+9 more)

### Community 132 - "check-package.mjs"
Cohesion: 0.20
Nodes (7): directories, expected, inspectSources(), listed, manifest, requiredAssets, root

### Community 133 - "containment.h"
Cohesion: 0.09
Nodes (10): skills_apply_write_boundary(), skills_apply_write_boundary_with_remote(), skills_boundary_directory(), skills_boundary_escape(), skills_boundary_null_device(), skills_boundary_path_matches(), skills_boundary_paths_match(), skills_write_boundary_profile() (+2 more)

### Community 134 - "Renderables"
Cohesion: 0.25
Nodes (7): Create and update, Destruction, Hide or detach, Layout properties, Next, Renderables, Tree membership

### Community 135 - "skills-manager design doc"
Cohesion: 0.44
Nodes (3): Decisions, skills-manager design doc, Tech stack: TypeScript, Ink, execa, gray-matter

### Community 136 - "Execution order"
Cohesion: 0.25
Nodes (8): Execution order, Phase 1: P0 inert parsing and filesystem boundaries, Phase 2: P0 scope upstream CLI operations, Phase 3: P0 scope Git operations, Phase 4: P1 discovery, adoption, and onboarding, Phase 5: P1 identity, ownership, and recoverable mutations, Phase 6: P1 platform behavior and offline policy, Phase 7: P1 runtime, release artifact, and public documentation

### Community 137 - "createTestRenderer"
Cohesion: 0.29
Nodes (7): Testing, Test, Test interaction, Keyboard input, Testing strategy, Test renderer output, createTestRenderer()

### Community 138 - "tree_same_snapshot"
Cohesion: 0.27
Nodes (23): git_state_check_baseline(), git_state_check_control_file(), git_state_delete_request(), git_state_directory_current(), git_state_discard_known(), git_state_moved_matches(), git_state_named_identity(), git_state_open() (+15 more)

### Community 139 - "`@opentui/keymap`"
Cohesion: 0.40
Nodes (5): Addons, Extras and graph, Frameworks and runtime modules, `@opentui/keymap`, Testing and hosts

### Community 140 - "Test renderer"
Cohesion: 0.33
Nodes (6): External output, Returned setup, Setup semantics and defaults, Styled frames, Test renderer, Waiting for observable output

### Community 141 - "Key binding pipeline callbacks"
Cohesion: 0.33
Nodes (6): `BindingExpander`, `BindingParser`, `BindingTransformer`, Key binding pipeline callbacks, `LayerBindingsTransformer`, Pipeline order and disposal

### Community 142 - "Open-source portability"
Cohesion: 0.17
Nodes (12): Automated releases, Concurrency limits, Context, Decision, Hosted history replacement, Implementation choices, In-app keyboard help, macOS arm64 verification (+4 more)

### Community 143 - "Services and registrations"
Cohesion: 0.40
Nodes (5): Audio, Clipboard, Keymap and plugin slots, Services and registrations, Tree-sitter

### Community 144 - "Intercept callbacks"
Cohesion: 0.40
Nodes (5): After key dispatch, Before key dispatch, Intercept callbacks, Intercept order, Raw input

### Community 145 - "Field compiler callbacks"
Cohesion: 0.40
Nodes (5): Command fields, Field compiler callbacks, Key binding fields, Layer fields, Reactive matchers

### Community 146 - "Public registration APIs"
Cohesion: 0.40
Nodes (5): Commands and dispatch, Diagnostics, intercepts, and resources, Fields, tokens, and patterns, Key binding pipeline, Public registration APIs

### Community 147 - "Other `@opentui/core` entry points"
Cohesion: 0.40
Nodes (5): Other `@opentui/core` entry points, Runtime plugin support, Testing, Tree-sitter assets, worker, and Node assets, Yoga

### Community 148 - "types.ts"
Cohesion: 0.26
Nodes (12): Task 3: Repo scanner, yaml, checkDocumentBudget(), checkSyntaxDepth(), FrontmatterError, ParsedSkillDocument, parseSkillDocument(), SizeAndDepth (+4 more)

### Community 149 - "Security policy"
Cohesion: 0.25
Nodes (7): Git and backup, Release status, Remote actions and privacy, Report a vulnerability, Security policy, Selecting and changing skills, Threat model

### Community 150 - "sandbox.ts"
Cohesion: 0.22
Nodes (13): cleanEnvironment(), execFileAsync, invoke(), linuxArguments(), locatePackage(), MacGit, macProfile(), PackageLocation (+5 more)

### Community 153 - "withSkillsLock"
Cohesion: 0.33
Nodes (12): cleanupGitIndex(), inspectGitIndex(), withSkillsLock(), addRemoteApproved(), commitSelected(), fetchApproved(), frozenRemote(), mutation() (+4 more)

## Knowledge Gaps
- **1118 isolated node(s):** `$schema`, `display`, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` (+1113 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1285 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createTestRenderer()` connect `createTestRenderer` to `Keyboard input`, `React keymap integration`, `Solid keymap integration`, `Other `@opentui/core` entry points`, `tui.test.ts`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Why does `OpenTUI Skill` connect `OpenTUI Skill` to `git.ts`, `opentui/SKILL.md`?**
  _High betweenness centrality (0.046) - this node is a cross-community bridge._
- **Why does `Quick routing by intent` connect `git.ts` to `OpenTUI Skill`, `gitTransaction.test.ts`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Are the 37 inferred relationships involving `tree_check_mount_fd()` (e.g. with `fingerprint_skill()` and `git_tx_check_mount_fd()`) actually correct?**
  _`tree_check_mount_fd()` has 37 INFERRED edges - model-reasoned connections that need verification._
- **Are the 30 inferred relationships involving `tree_check_mount_entry()` (e.g. with `fingerprint_skill()` and `git_tx_check_mount_entry()`) actually correct?**
  _`tree_check_mount_entry()` has 30 INFERRED edges - model-reasoned connections that need verification._
- **Are the 31 inferred relationships involving `tree_same_snapshot()` (e.g. with `fingerprint_skill()` and `git_tx_empty_at()`) actually correct?**
  _`tree_same_snapshot()` has 31 INFERRED edges - model-reasoned connections that need verification._
- **What connects `$schema`, `display`, `strict` to the rest of the system?**
  _1118 weakly-connected nodes found - possible documentation gaps or missing edges._