/**
 * Shared mutable state and default values for the SuperObjective extension.
 *
 * The state object is a single mutable singleton — other modules import it
 * and read/write its properties directly. We use a single object (rather
 * than per-binding `export let`) because ES modules do not allow other
 * files to reassign exported `let` bindings, and the previous monolithic
 * file relied on free reassignment of these singletons.
 */

import { extension_prompt_roles } from '../../../../../script.js';

/**
 * Built-in prompt set. Users can override these via the Manage Prompts UI;
 * any field omitted from a saved set falls back to these defaults.
 */
export const defaultPrompts = {
    'createTask': 'Ignore previous instructions. Please generate a numbered list of plain text tasks to complete an objective. The objective that you must make a numbered task list for is: "{{objective}}". The tasks created should take into account the character traits of {{char}}. These tasks may or may not involve {{user}} directly. Include the objective as the final task.\n\nThe list should be formatted using a number followed by a fullstop and the task on each line, e.g. "1. Take over the world". Include only the list in your reply.',
    'checkTaskCompleted': 'Ignore previous instructions. Determine if this task is completed: [{{currentTask}}]. To do this, examine the most recent messages. Your response must only contain either true or false, and nothing else. Example output: true',
    'currentTask': 'Your current task is [{{currentTask}}]. Balance existing roleplay with completing this task.',
    'completedTasks': 'Recently completed tasks: {{completedTasks}}',
    'upcomingTasks': 'Upcoming tasks: {{upcomingTasks}}',
    'additionalTasks': 'Ignore previous instructions. Please generate additional numbered tasks to complete the objective: "{{objective}}". The tasks created should take into account the character traits of {{char}}. These tasks may or may not involve {{user}} directly.\n\nThe following tasks have already been created:\n{{existingTasks}}\n\nPlease generate additional tasks that complement these existing tasks. Continue the numbering from where the list left off. Do not repeat any existing tasks.\n\nThe list should be formatted using a number followed by a fullstop and the task on each line, e.g. "4. Investigate the mysterious cave". Include only the list in your reply.'
};

/**
 * Default per-chat settings. Used when a chat has no SuperObjective metadata
 * yet, and as the source of truth for any setting missing from saved data.
 */
export const defaultSettings = {
    currentObjectiveId: null,
    taskTree: null,
    chatDepth: 2,
    checkFrequency: 3,
    hideTasks: false,
    swipesDecrement: false,
    injectionFrequency: 1,
    promptRole: extension_prompt_roles.SYSTEM,
    showCompletedTasks: false,
    completedTasksCount: 3,
    recentlyCompletedTasks: [],
    showUpcomingTasks: false,
    upcomingTasksCount: 3,
    upcomingTasks: [],
    prompts: defaultPrompts,
    templates: {},
    completionHistory: [],
    statistics: {
        tasksCompleted: 0,
        tasksCreated: 0,
        objectivesCompleted: 0,
        lastCompletionDate: null,
    },
};

/**
 * Mutable runtime state. Every field here was previously a top-level `let`
 * in index.js. Property semantics are preserved exactly: assigning
 * `state.taskTree = x` is equivalent to the old `taskTree = x`.
 */
export const state = {
    /** Root ObjectiveTask of the current chat (id 0, parentId ''). */
    taskTree: null,
    /** SillyTavern chat id we last loaded settings for. */
    currentChatId: '',
    /** ObjectiveTask whose children are shown in the task list (root or a branch). */
    currentObjective: null,
    /** ObjectiveTask the AI is currently focused on (null when none). */
    currentTask: null,
    /** Messages remaining until the next AI completion check. */
    checkCounter: 0,
    /** Set on MESSAGE_SWIPED, consulted on next MESSAGE_RECEIVED. */
    lastMessageWasSwipe: false,
    /** Name of the saved custom-prompt set in use. */
    selectedCustomPrompt: 'default',
    /** Recent completions, newest first. Capped by user setting. */
    recentlyCompletedTasks: [],
    /** Tasks queued after the current one. Refreshed when current task changes. */
    upcomingTasks: [],
    /** Counts down with each MESSAGE_RECEIVED until task is re-injected. */
    injectionCounter: 0,
    /** Monotonic id allocator for new ObjectiveTasks. Reset per chat in loadSettings. */
    nextTaskId: 1,
    /** Active prompt set. Initialized to defaults; replaced when state loads. */
    objectivePrompts: defaultPrompts,
};
