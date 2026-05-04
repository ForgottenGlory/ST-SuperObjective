/**
 * The SuperObjective workspace UI: a dashboard-style overlay that replaces
 * the old inline-drawer popout. Contains the header readouts, the editable
 * task list, a recently-completed list, and a subtasks panel that follows
 * the user's selected task (with `state.currentTask` as the fallback).
 *
 * The form inputs that the rest of the codebase pokes at by id (chat depth,
 * check frequency, the show-completed/upcoming checkboxes, etc.) all live
 * inside the workspace template — we mount it once at startup, hidden, so
 * `loadSettings()` can find those inputs even before the user opens the UI.
 */

import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { getTaskById, getNextIncompleteTaskRecurse } from './task.js';
import { attachSortable } from './ui-tasklist.js';
import { saveState } from './persistence.js';

/**
 * Mount the workspace template into the document and wire its open/close
 * interactions. Idempotent — does nothing if already mounted.
 *
 * @param {string} workspaceHtml The rendered workspace.html content.
 */
export function mountWorkspace(workspaceHtml) {
    if ($('#objective-workspace').length > 0) return;

    $('body').append(workspaceHtml);

    $('#objective-workspace-close').on('click', closeWorkspace);
    $('.objective-workspace-backdrop').on('click', closeWorkspace);

    $('#objective-workspace-settings-btn').on('click', toggleSettingsPanel);
    $('#objective-workspace-settings-close').on('click', closeSettingsPanel);

    $('#objective-subtasks-up').on('click', onSubtasksUpClick);

    $(document).on('keydown.objective-workspace', (e) => {
        if (e.key === 'Escape' && isWorkspaceOpen()) {
            if ($('#objective-workspace-settings-panel').is(':visible')) {
                closeSettingsPanel();
            } else {
                closeWorkspace();
            }
        }
    });

    // Click on a task row's chrome (drag handle, blank area) to select it.
    // We deliberately skip the description span — selecting a subtask via
    // its description would re-render the right column, removing the row
    // mid-click and stealing focus before edit can begin.
    $('#objective-workspace').on('mousedown.workspace-select', '.objective-task-item', (e) => {
        const $t = $(e.target);
        if ($t.is('input[type="checkbox"]')) return;
        if ($t.closest('[id^=objective-task-description-],[id^=objective-task-delete-],[id^=objective-task-add-],[id^=objective-task-duration-]').length) return;

        const item = $(e.currentTarget);
        const id = Number(item.attr('id')?.replace('objective-task-item-', ''));
        if (!Number.isNaN(id)) setSelectedTask(id);
    });
}

export function isWorkspaceOpen() {
    return $('#objective-workspace').is(':visible');
}

export function openWorkspace() {
    $('#objective-workspace').css('display', 'flex');
    refreshWorkspace();
}

export function closeWorkspace() {
    closeSettingsPanel();
    $('#objective-workspace').hide();
}

function toggleSettingsPanel() {
    const panel = $('#objective-workspace-settings-panel');
    if (panel.is(':visible')) {
        closeSettingsPanel();
    } else {
        panel.css('display', 'flex');
    }
}

function closeSettingsPanel() {
    $('#objective-workspace-settings-panel').hide();
}

/**
 * Resolve the task whose subtasks should appear in the right column.
 * Explicit user selection wins; otherwise we fall back to the AI's current
 * task. A stale selection (task deleted) silently reverts to the fallback.
 */
export function getSelectedTask() {
    if (state.selectedTaskId != null) {
        try {
            const t = getTaskById(state.selectedTaskId);
            if (t) return t;
        } catch (_) {
            // fall through
        }
        state.selectedTaskId = null;
    }
    return state.currentTask;
}

/** Set selected-task explicitly (taskId === null follows currentTask). */
export function setSelectedTask(taskId) {
    state.selectedTaskId = taskId;
    refreshWorkspace();
}

/**
 * Resolve the parent we'd navigate to when "Up" is clicked. Returns null
 * when the selected task has no non-root parent (i.e. the user is already
 * at the top of the tree, or nothing is selected).
 */
function resolveUpTarget(selected) {
    if (!selected || selected.parentId == null || selected.parentId === '') return null;
    let parent = null;
    try { parent = getTaskById(selected.parentId); } catch (_) { return null; }
    if (!parent || parent.parentId === '') return null;
    return parent;
}

/** "Up" button handler — wired in mountWorkspace. */
function onSubtasksUpClick() {
    const upTarget = resolveUpTarget(getSelectedTask());
    if (upTarget) setSelectedTask(upTarget.id);
}

/**
 * Repaint every workspace panel. Called whenever the underlying state
 * changes — task tree, current task, recently-completed list, etc. The
 * task-list itself is rendered by `updateUiTaskList()` in ui-tasklist.js;
 * we just paint the surrounding chrome.
 */
export function refreshWorkspace() {
    if (!$('#objective-workspace').length) return;

    renderCurrentTaskHeader();
    renderRecentlyCompleted();
    renderSubtasksPanel();
    renderSelectionHighlight();
}

function renderCurrentTaskHeader() {
    const text = state.currentTask?.description?.trim() || 'No active task';
    $('#objective-workspace-current-task-text').text(text);
}

function renderRecentlyCompleted() {
    const list = $('#objective-recently-completed-list');
    if (!list.length) return;

    if (!state.recentlyCompletedTasks || state.recentlyCompletedTasks.length === 0) {
        list.html('<div class="objective-workspace-empty">No completed tasks yet</div>');
        return;
    }

    const rows = state.recentlyCompletedTasks.map((t) => {
        const when = t.completionDate
            ? new Date(t.completionDate).toLocaleString()
            : '';
        return `
            <div class="objective-workspace-card objective-workspace-card-completed">
                <div class="objective-workspace-card-text">${escapeHtml(t.description || '')}</div>
                ${when ? `<div class="objective-workspace-card-meta">${escapeHtml(when)}</div>` : ''}
            </div>
        `;
    }).join('');

    list.html(rows);
}

function renderSubtasksPanel() {
    const selected = getSelectedTask();
    const selectedText = selected?.description?.trim() || 'No task selected';
    $('#objective-workspace-selected-task-text').text(selectedText);
    $('#objective-add-subtask').prop('disabled', !selected);

    // Up is enabled only when the selected task has a non-root ancestor —
    // navigating "up" to the root would just show the top-level list, which
    // already lives in the middle column.
    const upTarget = resolveUpTarget(selected);
    $('#objective-subtasks-up').prop('disabled', !upTarget);

    let currentSubtaskText = '—';
    if (selected) {
        const next = getNextIncompleteTaskRecurse(selected);
        if (next && next.id !== selected.id) {
            currentSubtaskText = next.description?.trim() || '—';
        } else if (selected.children?.length === 0) {
            currentSubtaskText = '(no subtasks)';
        } else {
            currentSubtaskText = '(all subtasks complete)';
        }
    }
    $('#objective-workspace-current-subtask-text').text(currentSubtaskText);

    const completedList = $('#objective-subtasks-completed');
    const upcomingList  = $('#objective-subtasks-upcoming');
    completedList.empty();
    upcomingList.empty();

    if (!selected || !selected.children || selected.children.length === 0) {
        completedList.html('<div class="objective-workspace-empty">—</div>');
        upcomingList.html('<div class="objective-workspace-empty">—</div>');
        return;
    }

    // Render each child as a full task row (drag, complete, edit, delete,
    // add-sibling, duration) into the appropriate sub-column.
    for (const child of selected.children) {
        const target = child.completed ? completedList : upcomingList;
        child.addUiElement(target);
    }

    if (completedList.children().length === 0) {
        completedList.html('<div class="objective-workspace-empty">—</div>');
    }
    if (upcomingList.children().length === 0) {
        upcomingList.html('<div class="objective-workspace-empty">—</div>');
    }

    attachSubtaskSortable(selected);
}

/**
 * Wire drag-reorder on both sub-columns. Each sub-column reorders its own
 * subset; when an update fires, we rebuild `parent.children` so that each
 * slot in the original array gets refilled by the next id of the matching
 * (completed/upcoming) sub-order. The interleaving is preserved — only the
 * within-subset order changes.
 */
function attachSubtaskSortable(parent) {
    const onUpdate = () => {
        const completedOrder = $('#objective-subtasks-completed')
            .sortable('toArray', { attribute: 'id' })
            .map(id => parseInt(id.replace('objective-task-item-', '')));
        const upcomingOrder = $('#objective-subtasks-upcoming')
            .sortable('toArray', { attribute: 'id' })
            .map(id => parseInt(id.replace('objective-task-item-', '')));

        const oldChildren = [...parent.children];
        const cIter = completedOrder[Symbol.iterator]();
        const uIter = upcomingOrder[Symbol.iterator]();
        parent.children = oldChildren.map(child => {
            const id = (child.completed ? cIter.next() : uIter.next()).value;
            return oldChildren.find(t => t.id === id) ?? child;
        });
        saveState();
    };

    attachSortable('#objective-subtasks-completed', onUpdate);
    attachSortable('#objective-subtasks-upcoming',  onUpdate);
}

/** Add a `is-selected` class to whichever task row matches the selected id. */
function renderSelectionHighlight() {
    $('.objective-task-item').removeClass('objective-task-item-selected');
    const selected = getSelectedTask();
    if (selected) {
        $(`#objective-task-item-${selected.id}`).addClass('objective-task-item-selected');
    }
}
