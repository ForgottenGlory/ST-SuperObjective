# SillyTavern-SuperObjective

## This extension is currently in beta testing, there may be bugs or other weirdness. Please open an issue if you find any problems.

## What is it?

A major expansion and partial rewrite of the original SillyTavern [Objective](https://docs.sillytavern.app/extensions/objective/) extension.

The SuperObjective extension lets you specify an objective for the AI to strive towards during your chat. This objective is broken down into step-by-step tasks that can be organized in a hierarchical structure. Tasks may be branched, where child tasks can be created automatically or manually, giving you the ability to create complex task trees.

This differs from static prompting by adding sequential and paced directives for the AI to follow without user intervention, creating a more genuine experience of the AI autonomously working toward a goal.

## Prerequisites

Before you begin, ensure you've met the following prerequisites:

- **Uninstall the Objectives extension using the "Manage Extensions" button in the Extensions panel.**
- Install the ST-SuperObjective extension using this link: https://github.com/ForgottenGlory/ST-SuperObjective.git and the "Install extension" button on the extensions panel.

### Trying the new workspace UI (test branch)

The kanban-style workspace described in this README lives on the `test` branch while it's in beta. SillyTavern's **Install extension** dialog clones the default branch (`main`), so a standard install will give you the older inline-drawer UI. To get the new UI, pick whichever option fits your setup:

**Option 1 — Install, then check out the test branch:**

```
cd <SillyTavern>/data/default-user/extensions/ST-SuperObjective
git fetch && git checkout test
```

Refresh SillyTavern when done.

**Option 2 — Clone the test branch directly (skip the Install dialog):**

```
cd <SillyTavern>/data/default-user/extensions/
git clone -b test https://github.com/ForgottenGlory/ST-SuperObjective.git
```

Refresh SillyTavern when done.

**Option 3 — Recent SillyTavern builds:** the Install extension dialog has a separate **branch** field. Paste the repo URL above and type `test` in the branch field.

To go back to the stable UI later, run `git checkout main && git pull` inside the extension directory.

## Common Use Cases

Your imagination is the limit! You can give the AI any objective you wish, and it will plan out how to achieve it. Examples include:
- Planning how to slay a dragon
- Designing a marketing campaign
- Creating a detailed story outline
- Developing a business strategy
- Building a fictional world

## Getting Started

1. Open the Extensions panel in SillyTavern, find the SuperObjective drawer, and click **Open SuperObjective**.
2. Type your goal into the **Objective** field at the top of the workspace (e.g. *"Conquer the world"*).
3. Click **Generate** in the Upcoming Tasks column header — the AI builds a task list from your objective.
4. Watch the AI work through the tasks. Check tasks off manually any time, or let auto-completion handle it.

> Tip: try `examples/conquer-the-world.json` (six top-level steps with subtasks) via **⋯ → Import Tasks** to see a fully-populated workspace.

## The Workspace

Clicking **Open SuperObjective** drops you into a kanban-style overlay:

- **Top bar** — extension name, objective progress bar, **⋯** overflow menu (Settings / Prompts / Templates / Statistics / Export / Import), and close button.
- **Objective ribbon** — your overarching goal. Edits save on focus-out.
- **Current Task ribbon** — what the AI is actively driving toward, plus a "next check in N" counter.
- **Upcoming Tasks** column — incomplete top-level tasks as kanban cards. Drag handle, checkbox, description, pencil (open detail), delete.
- **Completed Tasks** column — checked-off tasks. Uncheck to send them back to Upcoming.

Each card shows a `Subtasks: 1/3` hint when it has children, so you can see depth at a glance.

## Key Features

### Task Generation and Management

- **Generate** rebuilds the task list from your current objective.
- **More** appends additional tasks that complement the existing ones.
- **+Add** in either column header inserts a blank task you can rename inline.
- **Drag-reorder** within and across both columns.
- **Inline rename** — click the description text on any card and type.

### Task Detail Modal

Click the **pencil** on any card to open the task detail modal. From there you can:

- Rename the task in a prominent inline title field.
- Add and reorder **subtasks** (which themselves get the same row affordances — click their pencil to drill in further).
- Navigate up the parent chain via the **breadcrumb** or the **← Back** button.
- Set a per-task **duration** (minimum messages before auto-completion).
- **Delete** the task and any subtasks under it.

### Task Hierarchy

Subtasks live one click away, not in a permanent panel — open a task's detail modal and add children there. Click a subtask's pencil to drill deeper; the breadcrumb tracks your path back. Parent tasks auto-complete when all of their subtasks are done.

### Task Progress Visualization

Progress bar in the top bar shows `X/Y tasks (Z%)` for the objective and updates live as tasks complete or uncomplete.

### Task Completion Tracking

- Automatic task completion checking at configurable intervals.
- Manual completion via the checkbox on any card.
- Manual check or "Complete Current Task" via the SillyTavern Extras (wand) menu.
- Parent tasks auto-complete when all children are done; uncompleting a task earlier in the list takes back focus from a later one.

### Task Duration

Set a minimum number of messages that must pass before a task can be auto-completed. Useful for goals that need extended conversation. Live progress (`elapsed/duration`) shows next to the duration field in the detail modal; **Reset Progress** zeroes the counter.

### Recently Completed Tasks

The Completed column tracks every completed top-level task. Footer controls let you:

- Toggle **Include in prompt** to inject recently-completed task descriptions into the AI's context.
- Set **Count** for how many completed tasks the prompt should reference.
- **View All** to see the prompt-injection cache as a list.

### Upcoming Tasks

The Upcoming column footer mirrors the same toggles for upcoming tasks — control how many appear in the AI's context and whether to inject them at all.

### Templates, Import / Export, Statistics

Available from the **⋯** menu in the top bar:

- **Prompts** — edit and save the prompts used for generation and checking.
- **Templates** — save reusable task structures (without completion state) and reload them later.
- **Statistics** — chat and global counters for tasks created / completed / objectives finished.
- **Export Tasks / Import Tasks** — round-trip the current task tree as JSON. The format includes durations and completion state.

## Configuration

Open via **⋯ → Settings**:

- **Position in Chat** — depth at which the task is injected into the AI's context.
- **Task Check Frequency** — how often the AI checks if a task is complete (3 default, 0 disables).
- **Count swipes toward task check frequency** — include or exclude message swipes from decrementing the check counter (disabled by default).
- **Task Injection Frequency** — messages between task injections (1 default = every message).
- **Task Prompt Role** — Assistant, User, or System. Works with both chat-completion and text-completion APIs.
- **Hide Tasks** — hide the task list for a more mysterious experience.
- **Purge Completed Tasks** — clear the recently-completed prompt cache.

## Usage Tips

### Current Task Selection

The current task is always the first incomplete leaf in the tree (depth-first). Editing the tree triggers a re-pick — uncompleting an earlier task hands focus back to it; adding a task elsewhere doesn't change focus.

### Hiding Tasks

If you want to stay in the dark about what the AI is pursuing, enable **Hide Tasks** in Settings. Best done before clicking Generate.

### Task Context Awareness

With Include-in-prompt toggled on for both Completed and Upcoming, the AI sees both recent wins and the queue ahead — useful for keeping conversations goal-directed without you needing to remind it manually.

## Warning

Task checking happens in a separate API request. Setting Task Check Frequency to 1 will double your API calls to the LLM service. Be careful with this if you are using a paid service.