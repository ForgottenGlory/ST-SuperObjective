/**
 * Per-chat and global completion statistics, and the Statistics popup.
 *
 * `addToCompletionHistory` and `updateStatistics` are side-effect calls
 * fired from ObjectiveTask completion. `showStatistics` renders the
 * read-only Statistics modal. `countTasks` is a small helper used by the
 * modal — exported in case other modules want it later.
 */

import { chat_metadata, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings, saveMetadataDebounced } from '../../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';

import { state } from './state.js';
import { escapeHtml } from './utils.js';

const ZERO_STATS = () => ({
    tasksCompleted: 0,
    tasksCreated: 0,
    objectivesCompleted: 0,
    lastCompletionDate: null,
});

/**
 * Append a task to the completion history. Re-completions replace the
 * existing entry rather than duplicating it. History is capped at 100 rows.
 * @param {ObjectiveTask} task
 */
export function addToCompletionHistory(task) {
    const history = chat_metadata.objective.completionHistory ??= [];

    // Drop any prior entry for the same task so a re-completion (uncheck +
    // recheck) shows up once with the latest timestamp.
    const filtered = history.filter(entry => entry.id !== task.id);
    filtered.push({
        id: task.id,
        description: task.description,
        completionDate: task.completionDate,
        objectiveDescription: state.currentObjective.description,
    });

    chat_metadata.objective.completionHistory = filtered.length > 100
        ? filtered.slice(-100)
        : filtered;

    saveMetadataDebounced();
}

/**
 * Bump the per-chat and global completion counters when a task is marked
 * done. Also bumps the objectives-completed counter when the active
 * objective just had its last child finished.
 * @param {boolean} taskCompleted
 */
export function updateStatistics(taskCompleted = false) {
    chat_metadata.objective.statistics ??= ZERO_STATS();
    extension_settings.objective.globalStatistics ??= ZERO_STATS();

    if (taskCompleted) {
        const now = new Date().toISOString();
        chat_metadata.objective.statistics.tasksCompleted++;
        chat_metadata.objective.statistics.lastCompletionDate = now;
        extension_settings.objective.globalStatistics.tasksCompleted++;
        extension_settings.objective.globalStatistics.lastCompletionDate = now;

        const allCompleted = state.currentObjective.children.every(t => t.completed);
        if (allCompleted && state.currentObjective.children.length > 0) {
            chat_metadata.objective.statistics.objectivesCompleted++;
            extension_settings.objective.globalStatistics.objectivesCompleted++;
        }

        saveSettingsDebounced();
    }

    saveMetadataDebounced();
}

/**
 * Single-pass count of total + completed tasks in the tree, excluding root.
 * @param {ObjectiveTask} task
 * @returns {{total: number, completed: number}}
 */
export function countTasks(task) {
    let total = 0;
    let completed = 0;
    if (task.parentId !== '') {
        total = 1;
        if (task.completed) completed = 1;
    }
    for (const child of task.children) {
        const counts = countTasks(child);
        total += counts.total;
        completed += counts.completed;
    }
    return { total, completed };
}

/** Render the most recent 10 completion history rows. */
function generateCompletionHistoryHtml() {
    const history = chat_metadata.objective.completionHistory;
    if (!history || history.length === 0) {
        return '<p>No completed tasks yet</p>';
    }

    const recent = [...history].reverse().slice(0, 10);
    return `<ul class="objective_history_list">${recent.map(c => {
        const formatted = new Date(c.completionDate).toLocaleString();
        return `
        <li class="objective_history_item">
            <div class="objective_history_task">${escapeHtml(c.description)}</div>
            <div class="objective_history_objective">Objective: ${escapeHtml(c.objectiveDescription)}</div>
            <div class="objective_history_date">${escapeHtml(formatted)}</div>
        </li>`;
    }).join('')}</ul>`;
}

/** Show the Statistics popup. */
export function showStatistics() {
    chat_metadata.objective.statistics ??= ZERO_STATS();
    extension_settings.objective.globalStatistics ??= ZERO_STATS();

    const { total: totalTasks, completed: completedTasks } = countTasks(state.taskTree);
    const completionRate = totalTasks > 0
        ? Math.round((completedTasks / totalTasks) * 100)
        : 0;

    const fmtDate = (iso) => iso ? new Date(iso).toLocaleString() : 'Never';
    const lastCompletionText = fmtDate(chat_metadata.objective.statistics.lastCompletionDate);
    const globalLastCompletionText = fmtDate(extension_settings.objective.globalStatistics.lastCompletionDate);

    const popupText = `
    <div class="objective_statistics_modal">
        <h3 class="stats-header">Task Statistics</h3>

        <div class="stats-container">
            <div class="stats-section justifyCenter">
                <h4 class="stats-section-header">Current Objective</h4>
                <div class="stats-grid">
                    <div class="stats-label">Total Tasks:</div>
                    <div class="stats-value">${totalTasks}</div>

                    <div class="stats-label">Completed Tasks:</div>
                    <div class="stats-value">${completedTasks}</div>

                    <div class="stats-label">Completion Rate:</div>
                    <div class="stats-value">${completionRate}%</div>
                </div>
            </div>

            <div class="stats-section justifyCenter">
                <h4 class="stats-section-header">Current Chat Statistics</h4>
                <div class="stats-grid">
                    <div class="stats-label">Tasks Completed:</div>
                    <div class="stats-value">${chat_metadata.objective.statistics.tasksCompleted}</div>

                    <div class="stats-label">Objectives Completed:</div>
                    <div class="stats-value">${chat_metadata.objective.statistics.objectivesCompleted}</div>

                    <div class="stats-label">Last Completion:</div>
                    <div class="stats-value">${escapeHtml(lastCompletionText)}</div>
                </div>
            </div>

            <div class="stats-section justifyCenter">
                <h4 class="stats-section-header">Global Statistics</h4>
                <div class="stats-grid">
                    <div class="stats-label">Total Tasks Completed:</div>
                    <div class="stats-value">${extension_settings.objective.globalStatistics.tasksCompleted}</div>

                    <div class="stats-label">Total Objectives Completed:</div>
                    <div class="stats-value">${extension_settings.objective.globalStatistics.objectivesCompleted}</div>

                    <div class="stats-label">Total Tasks Created:</div>
                    <div class="stats-value">${extension_settings.objective.globalStatistics.tasksCreated}</div>

                    <div class="stats-label">Last Completion:</div>
                    <div class="stats-value">${escapeHtml(globalLastCompletionText)}</div>
                </div>
            </div>
        </div>

        <div class="stats-section completion-history-section">
            <h4 class="stats-section-header">Recent Completions</h4>
            <div class="objective_completion_history">
                ${generateCompletionHistoryHtml()}
            </div>
        </div>
    </div>`;

    callGenericPopup(popupText, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true, wider: true });
}
