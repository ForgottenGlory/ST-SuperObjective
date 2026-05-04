/**
 * Save/load/reset for SuperObjective state, plus the legacy-format migration
 * that used to live inline in the monolithic index.js.
 *
 * `saveState` snapshots in-memory state plus the relevant UI inputs into
 * `chat_metadata.objective` and asks SillyTavern to persist. `loadSettings`
 * is the inverse: it rehydrates state from `chat_metadata` (or the legacy
 * `extension_settings.objective[chatId]` location, or the pre-tree flat
 * objective format), then refreshes the UI.
 */

import { chat_metadata } from '../../../../../script.js';
import { getContext, extension_settings, saveMetadataDebounced } from '../../../../extensions.js';

import { state, defaultPrompts, defaultSettings } from './state.js';
import { ObjectiveTask, getTaskById } from './task.js';

import { updateCompletedTasksCount } from './recent-tasks.js';

// UI updates still live in index.js — repointed when those move.
import {
    setCurrentTask,
    updateUiTaskList,
    updateUpcomingTasksCount,
} from '../index.js';

/**
 * Write the in-memory state and the relevant UI inputs back into
 * `chat_metadata.objective`, then schedule a debounced metadata save.
 */
export function saveState() {
    const context = getContext();
    if (state.currentChatId == '') {
        state.currentChatId = context.chatId;
    }

    chat_metadata['objective'] = {
        currentObjectiveId: state.currentObjective.id,
        taskTree: state.taskTree.toSaveStateRecurse(),
        checkFrequency: $('#objective-check-frequency').val(),
        chatDepth: $('#objective-chat-depth').val(),
        hideTasks: $('#objective-hide-tasks').prop('checked'),
        swipesDecrement: $('#objective-swipes-decrement').prop('checked'),
        injectionFrequency: $('#objective-injection-frequency').val(),
        showCompletedTasks: $('#objective-show-completed').prop('checked'),
        completedTasksCount: $('#objective-completed-count').val(),
        recentlyCompletedTasks: state.recentlyCompletedTasks,
        showUpcomingTasks: $('#objective-show-upcoming').prop('checked'),
        upcomingTasksCount: $('#objective-upcoming-count').val(),
        upcomingTasks: state.upcomingTasks,
        prompts: state.objectivePrompts,
        selectedCustomPrompt: state.selectedCustomPrompt,
        completionHistory: chat_metadata.objective.completionHistory,
        statistics: chat_metadata.objective.statistics,
    };

    saveMetadataDebounced();
}

/**
 * Reset transient runtime state on chat change, then re-run loadSettings to
 * rehydrate from the new chat's metadata.
 */
export function resetState() {
    state.lastMessageWasSwipe = false;
    state.recentlyCompletedTasks = [];
    state.upcomingTasks = [];
    updateCompletedTasksCount();
    updateUpcomingTasksCount();
    loadSettings();
}

/**
 * Recursively rebuild a task subtree from a saved-state snapshot.
 * @param {object} savedTask
 * @returns {ObjectiveTask}
 */
function loadTaskChildrenRecurse(savedTask) {
    const task = new ObjectiveTask({
        id: savedTask.id,
        description: savedTask.description,
        completed: savedTask.completed,
        parentId: savedTask.parentId,
        completionDate: savedTask.completionDate || null,
        duration: savedTask.duration || 0,
        elapsedMessages: savedTask.elapsedMessages || 0,
    });
    for (const child of savedTask.children) {
        task.children.push(loadTaskChildrenRecurse(child));
    }
    return task;
}

/**
 * Load SuperObjective state for the active chat. Handles three migrations:
 *   1) Settings stored under extension_settings.objective[chatId] (very old).
 *   2) The pre-tree flat-objective format (`{ objective, tasks }`).
 *   3) The current `taskTree` snapshot.
 *
 * After rehydrating state, this also pushes settings into the form controls
 * and asks the task-list UI to redraw.
 */
export function loadSettings() {
    state.currentChatId = getContext().chatId;

    // Reset Objectives and Tasks in memory.
    state.taskTree = null;
    state.currentObjective = null;
    // The constructor below will bump nextTaskId past any explicit ids.
    state.nextTaskId = 1;

    // Clear the objective text field when switching chats.
    $('#objective-text').val('');

    // First-run init for global extension settings.
    if (Object.keys(extension_settings.objective).length === 0) {
        Object.assign(extension_settings.objective, {
            customPrompts: { default: defaultPrompts },
            globalStatistics: {
                tasksCompleted: 0,
                tasksCreated: 0,
                objectivesCompleted: 0,
                lastCompletionDate: null,
            },
        });
    }

    if (state.currentChatId == undefined) {
        state.currentChatId = 'no-chat-id';
    }

    // Migration 1: per-chat settings used to live under extension_settings.
    if (state.currentChatId in extension_settings.objective) {
        chat_metadata['objective'] = extension_settings.objective[state.currentChatId];
        delete extension_settings.objective[state.currentChatId];
    }

    if (!('objective' in chat_metadata)) {
        Object.assign(chat_metadata, { objective: defaultSettings });
    }

    // Migration 2: pre-tree flat objective + tasks list.
    if ('objective' in chat_metadata.objective) {
        state.taskTree = new ObjectiveTask({ id: 0, description: chat_metadata.objective.objective });
        state.currentObjective = state.taskTree;

        if ('tasks' in chat_metadata.objective) {
            let idIncrement = 0;
            state.taskTree.children = chat_metadata.objective.tasks.map(task => {
                idIncrement += 1;
                return new ObjectiveTask({
                    id: idIncrement,
                    description: task.description,
                    completed: task.completed,
                    parentId: state.taskTree.id,
                });
            });
        }
        saveState();
        delete chat_metadata.objective.objective;
        delete chat_metadata.objective.tasks;
    } else if (chat_metadata.objective.taskTree) {
        state.taskTree = loadTaskChildrenRecurse(chat_metadata.objective.taskTree);
    }

    // Always have a root task to anchor the tree.
    if (!state.taskTree) {
        state.taskTree = new ObjectiveTask({ id: 0, description: '' });
    }

    // Restore current objective (root if id missing or stale).
    if (chat_metadata.objective.currentObjectiveId !== null) {
        try {
            state.currentObjective = getTaskById(chat_metadata.objective.currentObjectiveId);
        } catch (e) {
            console.warn(`Failed to set current objective with ID ${chat_metadata.objective.currentObjectiveId}: ${e}`);
            state.currentObjective = state.taskTree;
        }
    } else {
        state.currentObjective = state.taskTree;
    }

    state.checkCounter = chat_metadata['objective'].checkFrequency;
    state.objectivePrompts = chat_metadata['objective'].prompts;
    state.recentlyCompletedTasks = chat_metadata.objective.recentlyCompletedTasks || [];
    state.upcomingTasks = chat_metadata.objective.upcomingTasks || [];

    // Backfill any prompt slots missing from a saved set.
    if (!state.objectivePrompts.additionalTasks) state.objectivePrompts.additionalTasks = defaultPrompts.additionalTasks;
    if (!state.objectivePrompts.completedTasks)  state.objectivePrompts.completedTasks  = defaultPrompts.completedTasks;
    if (!state.objectivePrompts.upcomingTasks)   state.objectivePrompts.upcomingTasks   = defaultPrompts.upcomingTasks;

    state.selectedCustomPrompt = chat_metadata['objective'].selectedCustomPrompt || 'default';
    state.injectionCounter = 0;

    $('#objective-counter').text(state.checkCounter);
    $('#objective-text').text(state.taskTree.description);

    if (!state.currentObjective || !state.currentObjective.parentId || state.currentObjective.parentId === '') {
        $('#objective-parent').hide();
    }

    // Push the chat-metadata settings into the form controls in one pass.
    const meta = chat_metadata.objective;
    $('#objective-chat-depth').val(meta.chatDepth);
    $('#objective-check-frequency').val(meta.checkFrequency);
    $('#objective-hide-tasks').prop('checked', !!meta.hideTasks);
    $('#objective-injection-frequency').val(meta.injectionFrequency || 1);
    $('#objective-swipes-decrement').prop('checked', !!meta.swipesDecrement);
    $('#objective-show-completed').prop('checked', !!meta.showCompletedTasks);
    $('#objective-completed-count').val(meta.completedTasksCount || 3);
    $('#objective-show-upcoming').prop('checked', !!meta.showUpcomingTasks);
    $('#objective-upcoming-count').val(meta.upcomingTasksCount || 3);

    if (meta.hideTasks) {
        $('#objective-tasks').hide();
    } else {
        $('#objective-tasks').show();
    }

    updateUiTaskList();
    updateCompletedTasksCount();
    updateUpcomingTasksCount();

    setCurrentTask(null, true);
}

/**
 * Console helper exposed on globalThis. Dump the relevant in-memory and
 * persisted state for debugging.
 */
export function debugObjectiveExtension() {
    console.log(JSON.stringify({
        currentTask: state.currentTask,
        currentObjective: state.currentObjective,
        taskTree: state.taskTree?.toSaveStateRecurse() ?? null,
        chat_metadata: chat_metadata['objective'],
        extension_settings: extension_settings['objective'],
        prompts: state.objectivePrompts,
    }, null, 2));
}
