/**
 * The main task-list UI: rendering the list, the drag-to-reorder behavior,
 * the progress bar, and `setCurrentTask` (which both updates the highlight
 * and rewrites the extension prompt that's injected into the LLM context).
 */

import {
    chat_metadata,
    extension_prompt_types,
    extension_prompt_roles,
    substituteParams,
} from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';

import { state } from './state.js';
import { substituteParamsPrompts } from './prompts.js';
import { getTaskById, getNextIncompleteTaskRecurse } from './task.js';
import { saveState } from './persistence.js';
import { updateUpcomingTasks } from './upcoming-tasks.js';
import { updateCompletedTasksCount } from './recent-tasks.js';
import { refreshWorkspace } from './ui-workspace.js';

const MODULE_NAME = 'SuperObjective';

/**
 * Set the active task (or clear it) and synchronize the extension prompt.
 *
 * - If `taskId` is null, the next incomplete task in the tree is picked.
 * - If `skipSave` is true, no `saveState()` is fired (used during load).
 *
 * The injected prompt is rebuilt only when the task changed, when the
 * injection counter rolled to zero, or when explicitly forced. Otherwise
 * the extension prompt is cleared so the host can fall through to its
 * normal context.
 *
 * @param {number|null} [taskId]
 * @param {boolean} [skipSave]
 */
export function setCurrentTask(taskId = null, skipSave = false) {
    const context = getContext();

    const previousTaskId = state.currentTask?.id ?? null;

    if (taskId === null) {
        state.currentTask = getNextIncompleteTaskRecurse(state.taskTree);
    } else {
        try {
            state.currentTask = getTaskById(taskId);
        } catch (e) {
            console.warn(`Failed to set current task with ID ${taskId}: ${e}`);
            state.currentTask = getNextIncompleteTaskRecurse(state.taskTree);
        }
    }

    const description = state.currentTask?.description ?? null;
    if (description) {
        if (previousTaskId !== state.currentTask.id) {
            state.currentTask.elapsedMessages = 0;
            console.debug(`Reset elapsed messages counter for new current task ${state.currentTask.id}`);
        }

        // Always inject when: just-loaded settings (skipSave), the
        // injection counter is at zero, or the active task changed.
        const shouldInjectTask = skipSave
            || state.injectionCounter === 0
            || previousTaskId !== state.currentTask.id;

        if (shouldInjectTask) {
            let extensionPromptText = substituteParamsPrompts(state.objectivePrompts.currentTask, true);

            if ($('#objective-show-completed').prop('checked') && state.recentlyCompletedTasks.length > 0) {
                const text = state.recentlyCompletedTasks.map(t => `[${t.description}]`).join(', ');
                let prompt = state.objectivePrompts.completedTasks.replace(/{{completedTasks}}/gi, text);
                prompt = substituteParams(prompt);
                extensionPromptText = `${extensionPromptText}\n${prompt}`;
            }

            updateUpcomingTasks();

            if ($('#objective-show-upcoming').prop('checked') && state.upcomingTasks.length > 0) {
                const text = state.upcomingTasks.map(t => `[${t.description}]`).join(', ');
                let prompt = state.objectivePrompts.upcomingTasks.replace(/{{upcomingTasks}}/gi, text);
                prompt = substituteParams(prompt);
                extensionPromptText = `${extensionPromptText}\n${prompt}`;
            }

            const promptRole = chat_metadata.objective.promptRole || extension_prompt_roles.SYSTEM;

            context.setExtensionPrompt(
                MODULE_NAME,
                extensionPromptText,
                extension_prompt_types.IN_CHAT,
                Number($('#objective-chat-depth').val()),
                true,
                promptRole,
            );
            console.info(`[SuperObjective] injected extensionPrompt[${MODULE_NAME}] = ${JSON.stringify(context.extensionPrompts[MODULE_NAME])}`);
        } else {
            context.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, 0);
            console.info('Skipping task injection due to frequency setting');
        }

        // Always refresh the highlight in the UI.
        $('.objective-task').removeClass('objective-task-highlight');
        $('.objective-task').css({ 'border-color': '', 'border-width': '' });
        if (state.currentTask.descriptionSpan) {
            state.currentTask.descriptionSpan.addClass('objective-task-highlight');
        }
    } else {
        context.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, 0);
        console.info('No current task');
    }

    if (!skipSave) {
        saveState();
    }
}

/**
 * Repopulate the task-list DOM from `state.currentObjective.children`,
 * wire up drag-and-drop, and refresh the progress bar.
 */
export function updateUiTaskList() {
    $('#objective-tasks').empty();
    $('#objective-filter-sort').remove();

    $('#objective-text').val(state.currentObjective ? state.currentObjective.description : '');

    if (state.currentObjective && state.currentObjective.children.length > 0) {
        $('#objective-generate-more').show();
    } else {
        $('#objective-generate-more').hide();
    }

    const allChildren = state.currentObjective?.children ?? [];
    const incompleteChildren = allChildren.filter(t => !t.completed);

    if (incompleteChildren.length > 0) {
        // Upcoming column is the incomplete subset. The completed subset
        // renders into the Completed column via refreshWorkspace below.
        for (const task of incompleteChildren) {
            task.addUiElement();
        }

        // Preserve the existing current task across re-renders. Only pick a
        // new one when there isn't one, the old one's gone, or the old one
        // is now complete — otherwise an unrelated UI refresh (an Add, a
        // drag) would yank current away from where the AI is focused.
        const stillValid = state.currentTask
            && getTaskById(state.currentTask.id)
            && !state.currentTask.completed;

        if (stillValid) {
            setCurrentTask(state.currentTask.id, true);
        } else {
            setCurrentTask(incompleteChildren[0].id, true);
        }
    } else if (allChildren.length === 0) {
        $('#objective-tasks').append('<input id="objective-task-add-first" type="button" class="menu_button" value="Add Task">');
        $('#objective-task-add-first').on('click', () => {
            const newTask = state.currentObjective.addTask('');
            updateUiTaskList();
            setCurrentTask(newTask.id);
        });
        setCurrentTask(null, true);
    } else {
        // All children are complete — Upcoming is empty, but the task tree
        // itself isn't (everything is in the Completed column).
        setCurrentTask(null, true);
    }

    initSortable();
    updateProgressBar();
    refreshWorkspace();
}

/**
 * Rebuild `parent.children` from the visible DOM order across both an
 * incomplete-tasks container and a completed-tasks container, preserving
 * the original interleaving (each slot's completion state is respected;
 * only the within-subset order changes).
 *
 * @param {ObjectiveTask} parent
 * @param {string|JQuery} incompleteContainer
 * @param {string|JQuery} completedContainer
 */
export function reorderChildrenFromUI(parent, incompleteContainer, completedContainer) {
    const readIds = (sel) => $(sel).children('.objective-task-item')
        .map((_, el) => parseInt(el.id.replace('objective-task-item-', '')))
        .get();

    const incompleteOrder = readIds(incompleteContainer);
    const completedOrder = readIds(completedContainer);

    const oldChildren = [...parent.children];
    const cIter = completedOrder[Symbol.iterator]();
    const uIter = incompleteOrder[Symbol.iterator]();
    parent.children = oldChildren.map(child => {
        const id = (child.completed ? cIter.next() : uIter.next()).value;
        return oldChildren.find(t => t.id === id) ?? child;
    });
}

/**
 * Attach jQuery UI sortable to a container of `.objective-task-item` rows.
 * `onUpdate(taskIds)` fires after a drag with the new id order.
 *
 * Note: deliberately does NOT call `.disableSelection()` — that attaches a
 * global `mousedown.preventDefault()` that blocks focus into contenteditable
 * task spans on Chrome/Chromium. The `handle` option already restricts
 * drag-init to the grip icon, and `cancel` excludes interactive elements as
 * a belt-and-braces.
 *
 * @param {string|JQuery} container
 * @param {(taskIds: number[]) => void} onUpdate
 */
export function attachSortable(container, onUpdate) {
    if (!$.fn.sortable) return;

    $(container).sortable({
        items: '> .objective-task-item',
        handle: '[id^=objective-task-drag-]',
        cancel: 'input,textarea,button,select,option,[contenteditable="true"]',
        placeholder: 'ui-sortable-placeholder',
        opacity: 0.7,
        cursor: 'grabbing',
        tolerance: 'pointer',
        update() {
            const items = $(this).sortable('toArray', { attribute: 'id' });
            const taskIds = items.map(id => parseInt(id.replace('objective-task-item-', '')));
            onUpdate(taskIds);
        },
    });
}

function initSortable() {
    if (!$.fn.sortable) {
        console.warn('jQuery UI sortable not available. Drag-and-drop task reordering is disabled.');
        if (state.currentObjective && state.currentObjective.children.length > 0) {
            $('#objective-tasks').prepend(
                '<div class="sortable-notice" style="font-size: 0.8em; opacity: 0.7; margin-bottom: 10px;">Note: Drag-and-drop ordering requires jQuery UI.</div>'
            );
        }
        return;
    }

    attachSortable('#objective-tasks', () => onTopLevelReorder());
}

/**
 * Drag-update handler shared between the Upcoming and Completed columns
 * (both render slices of `state.currentObjective.children`). Either column's
 * drop merges back into the same children array, preserving the unchanged
 * column's order and the completed/incomplete interleaving.
 */
export function onTopLevelReorder() {
    reorderChildrenFromUI(
        state.currentObjective,
        '#objective-tasks',
        '#objective-recently-completed-list',
    );
    updateUpcomingTasks();
    updateCompletedTasksCount();
    saveState();
}

/**
 * Update the workspace progress bar. The container is part of the workspace
 * template, so we just update its label and bar width.
 */
function updateProgressBar() {
    const container = $('#objective-progress-container');
    if (!container.length) return;

    const label = container.find('.objective-workspace-progress-label');
    const bar = $('#objective-progress-bar');

    if (!state.currentObjective || state.currentObjective.children.length === 0) {
        label.text('No tasks yet');
        bar.css('width', '0%');
        return;
    }

    const totalCount = state.currentObjective.children.length;
    const completedCount = state.currentObjective.children.filter(t => t.completed).length;
    const progressPercent = Math.round((completedCount / totalCount) * 100);

    label.text(`${completedCount}/${totalCount} tasks (${progressPercent}%)`);
    bar.css('width', `${progressPercent}%`);
}
