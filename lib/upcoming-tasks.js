/**
 * "Upcoming Tasks" feature: maintains the next N incomplete tasks queued
 * after the current one and exposes them via the {{upcomingTasks}} macro
 * and a View Tasks popup.
 */

import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';

import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { getTaskById } from './task.js';
import { saveState } from './persistence.js';
import { setCurrentTask } from './ui-tasklist.js';

/**
 * Recompute the upcoming-tasks list from the current task. Direct siblings
 * after the current task fill the slots first; if there's still room, we
 * scan the rest of the tree for any other incomplete tasks.
 */
export function updateUpcomingTasks() {
    state.upcomingTasks = [];

    if (!state.currentTask || !state.currentTask.id || !state.currentObjective) {
        return;
    }

    const parent = getTaskById(state.currentTask.parentId);
    if (!parent) return;

    const currentIndex = parent.children.findIndex(t => t.id === state.currentTask.id);
    if (currentIndex === -1) return;

    const max = Number($('#objective-upcoming-count').val()) || 3;

    // Prefer siblings after the current task — most natural reading order.
    for (let i = currentIndex + 1; i < parent.children.length && state.upcomingTasks.length < max; i++) {
        const t = parent.children[i];
        if (!t.completed) {
            state.upcomingTasks.push({ id: t.id, description: t.description });
        }
    }

    // Top up from elsewhere in the tree if siblings ran out.
    if (state.upcomingTasks.length < max) {
        const allIncomplete = getAllIncompleteTasks(state.taskTree);
        const filtered = allIncomplete.filter(t =>
            t.id !== state.currentTask.id &&
            !state.upcomingTasks.some(u => u.id === t.id)
        );
        for (let i = 0; i < filtered.length && state.upcomingTasks.length < max; i++) {
            state.upcomingTasks.push({ id: filtered[i].id, description: filtered[i].description });
        }
    }

    updateUpcomingTasksCount();
}

/** Flatten the tree into all incomplete leaf-or-non-root tasks, in DFS order. */
function getAllIncompleteTasks(task) {
    let result = [];
    if (task.parentId !== '' && !task.completed) {
        result.push(task);
    }
    for (const child of task.children) {
        result = result.concat(getAllIncompleteTasks(child));
    }
    return result;
}

/** Refresh the count shown on the "View Tasks" button. */
export function updateUpcomingTasksCount() {
    const count = state.upcomingTasks.length;
    $('#objective-view-upcoming').val(count > 0 ? `View All (${count})` : 'View All');
}

/** Handler for the "Include upcoming tasks in prompt" checkbox. */
export function onShowUpcomingTasksInput() {
    setCurrentTask();
    saveState();
}

/** Handler for the "Number of upcoming tasks to include" input. */
export function onUpcomingTasksCountInput() {
    updateUpcomingTasks();
    setCurrentTask();
    saveState();
}

/** Show the "View Tasks" popup with the current upcoming list. */
export function showUpcomingTasks() {
    if (state.upcomingTasks.length === 0) {
        toastr.info('No upcoming tasks');
        return;
    }

    const rows = state.upcomingTasks.map(t => `
        <li class="objective_history_item">
            <div class="objective_history_task">${escapeHtml(t.description)}</div>
        </li>`).join('');

    const popupText = `
    <div class="objective_statistics_modal">
        <h3 class="stats-header">Upcoming Tasks</h3>

        <div class="stats-container">
            <div class="stats-section">
                <h4 class="stats-section-header">Task Queue</h4>
                <p>These tasks are derived live from your task tree and are included in the AI's context when "Include upcoming tasks in prompt" is enabled.</p>

                <div class="objective_completion_history">
                    <ul class="objective_history_list">${rows}</ul>
                </div>
            </div>
        </div>
    </div>`;

    callGenericPopup(popupText, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true, wider: true });
}
