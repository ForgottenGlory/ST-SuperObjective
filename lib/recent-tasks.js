/**
 * "Recently Completed Tasks" feature: tracks the last N completed tasks in
 * a chat-local list, which gets surfaced to the AI via the {{completedTasks}}
 * macro and to the user via the View Tasks popup.
 */

import { callGenericPopup, Popup, POPUP_TYPE } from '../../../../popup.js';

import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { saveState } from './persistence.js';
import { setCurrentTask } from './ui-tasklist.js';

/**
 * Append `task` to the recent-completions list, capped by the user's
 * configured count. Re-completing a task moves it to the top rather than
 * duplicating it.
 * @param {ObjectiveTask} task
 */
export function addToRecentlyCompletedTasks(task) {
    state.recentlyCompletedTasks = state.recentlyCompletedTasks.filter(t => t.id !== task.id);
    state.recentlyCompletedTasks.unshift({
        id: task.id,
        description: task.description,
        completionDate: task.completionDate,
    });

    const maxCompleted = Number($('#objective-completed-count').val()) || 3;
    if (state.recentlyCompletedTasks.length > maxCompleted) {
        state.recentlyCompletedTasks = state.recentlyCompletedTasks.slice(0, maxCompleted);
    }

    updateCompletedTasksCount();
    setCurrentTask();
}

/** Refresh the count shown on the "View Tasks" button. */
export function updateCompletedTasksCount() {
    const count = state.recentlyCompletedTasks.length;
    $('#objective-view-completed').val(count > 0 ? `View Tasks (${count})` : 'View Tasks');
}

/** Handler for the "Include completed tasks in prompt" checkbox. */
export function onShowCompletedTasksInput() {
    setCurrentTask();
    saveState();
}

/** Handler for the "Number of completed tasks to include" input. */
export function onCompletedTasksCountInput() {
    const max = Number($('#objective-completed-count').val()) || 3;
    if (state.recentlyCompletedTasks.length > max) {
        state.recentlyCompletedTasks = state.recentlyCompletedTasks.slice(0, max);
        updateCompletedTasksCount();
    }
    setCurrentTask();
    saveState();
}

/** Handler for the "Purge Tasks" button — wipe the recent-completions list. */
export async function onPurgeCompletedTasksClick() {
    if (state.recentlyCompletedTasks.length === 0) {
        toastr.info('No recently completed tasks to purge');
        return;
    }

    const ok = await Popup.show.confirm('Are you sure you want to purge all recently completed tasks?', null);
    if (!ok) return;

    state.recentlyCompletedTasks = [];
    updateCompletedTasksCount();
    setCurrentTask();
    saveState();
    toastr.success('Recently completed tasks have been purged');
}

/** Show the "View Tasks" popup with the full recent-completions list. */
export function showRecentlyCompletedTasks() {
    if (state.recentlyCompletedTasks.length === 0) {
        toastr.info('No recently completed tasks');
        return;
    }

    const rows = state.recentlyCompletedTasks.map(task => {
        const formatted = new Date(task.completionDate).toLocaleString();
        return `
        <li class="objective_history_item">
            <div class="objective_history_task">${escapeHtml(task.description)}</div>
            <div class="objective_history_date">Completed: ${escapeHtml(formatted)}</div>
        </li>`;
    }).join('');

    const popupText = `
    <div class="objective_statistics_modal">
        <h3 class="stats-header">Recently Completed Tasks</h3>

        <div class="stats-container">
            <div class="stats-section">
                <h4 class="stats-section-header">Task History</h4>
                <p>These tasks are included in the AI's context when "Include completed tasks in prompt" is enabled.</p>

                <div class="objective_completion_history">
                    <ul class="objective_history_list">${rows}</ul>
                </div>
            </div>

            <div class="stats-section">
                <h4 class="stats-section-header">Actions</h4>
                <p>Clearing completed tasks will remove them from the prompt context.</p>
                <div class="flex-container justifyCenter marginTop10">
                    <button id="recently-completed-tasks-purge" class="menu_button">Purge All Completed Tasks</button>
                </div>
            </div>
        </div>
    </div>`;

    callGenericPopup(popupText, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true, wider: true });

    $('#recently-completed-tasks-purge').on('click', () => {
        onPurgeCompletedTasksClick();
        $('.popup_cross').click();
    });
}
