/**
 * The SuperObjective workspace UI: a dashboard-style overlay with two
 * columns (Upcoming + Completed) of kanban task cards, plus a detail
 * modal that opens from each card's pencil icon. The modal owns the
 * deeper editing — description, subtasks, duration, delete — and supports
 * drilling into subtasks via breadcrumb navigation.
 *
 * Form inputs the rest of the codebase pokes at by id (chat depth, check
 * frequency, the show-completed/upcoming checkboxes, etc.) all live
 * inside the workspace template — we mount it once at startup, hidden,
 * so `loadSettings()` can find those inputs even before the user opens
 * the workspace.
 */

import { state } from './state.js';
import { getTaskById } from './task.js';
import { attachSortable, onTopLevelReorder, updateUiTaskList } from './ui-tasklist.js';
import { saveState } from './persistence.js';

/**
 * Mount the workspace template into the document and wire its open/close
 * interactions. Idempotent — does nothing if already mounted.
 */
export function mountWorkspace(workspaceHtml) {
    if ($('#objective-workspace').length > 0) return;

    $('body').append(workspaceHtml);

    $('#objective-workspace-close').on('click', closeWorkspace);
    $('.objective-workspace-backdrop').on('click', closeWorkspace);

    $('#objective-workspace-settings-btn').on('click', () => {
        closeOverflowMenu();
        toggleSettingsPanel();
    });
    $('#objective-workspace-settings-close').on('click', closeSettingsPanel);

    // Overflow menu: open on ⋯ click, close on item click or click-outside.
    $('#objective-workspace-more').on('click', (e) => {
        e.stopPropagation();
        toggleOverflowMenu();
    });
    $('#objective-workspace-overflow-menu').on('click', '.menu_button', () => {
        closeOverflowMenu();
    });
    $(document).on('click.objective-workspace-overflow', (e) => {
        if (!$(e.target).closest('#objective-workspace-overflow-menu, #objective-workspace-more').length) {
            closeOverflowMenu();
        }
    });

    // Detail modal wiring.
    $('.objective-task-detail-backdrop').on('click', closeTaskDetail);
    $('#objective-task-detail-close').on('click', closeTaskDetail);
    $('#objective-task-detail-back').on('click', navigateUpFromDetail);

    // Inline-editable title at the top of the modal. Enter commits (blurs)
    // rather than inserting a newline since this is single-line content.
    $('#objective-task-detail-title').on('focusout', () => {
        const task = getDetailTask();
        if (!task) return;
        const next = $('#objective-task-detail-title').text().trim();
        if (task.description !== next) {
            task.description = next;
            saveState();
            updateUiTaskList();
        }
    });
    $('#objective-task-detail-title').on('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            $(e.target).blur();
        }
    });

    $('#objective-task-detail-add-subtask').on('click', () => {
        const task = getDetailTask();
        if (!task) return;
        task.addTask('New Subtask');
        renderTaskDetail();
        updateUiTaskList();
    });

    $('#objective-task-detail-duration').on('change', () => {
        const task = getDetailTask();
        if (!task) return;
        const raw = parseInt($('#objective-task-detail-duration').val(), 10);
        task.duration = Number.isNaN(raw) ? 0 : Math.max(0, raw);
        if (task.duration === 0) task.elapsedMessages = 0;
        renderTaskDetail();
        saveState();
    });

    $('#objective-task-detail-duration-reset').on('click', () => {
        const task = getDetailTask();
        if (!task) return;
        task.elapsedMessages = 0;
        renderTaskDetail();
        saveState();
    });

    $('#objective-task-detail-delete').on('click', () => {
        const task = getDetailTask();
        if (!task) return;
        // onDeleteClick handles the cascade-children confirm prompt + tree
        // mutation + redraw. If the user cancels, the task is still in the
        // tree and we leave the modal where it is.
        const taskId = task.id;
        const parentId = task.parentId;
        task.onDeleteClick();
        const stillExists = !!getTaskById(taskId);
        if (stillExists) return;

        if (typeof parentId === 'number' && parentId !== 0) {
            openTaskDetail(parentId);
        } else {
            closeTaskDetail();
        }
    });

    // Card pencil click → open detail. Delegated since cards re-render.
    $('#objective-workspace').on('click', '.objective-task-card-edit', function (e) {
        e.stopPropagation();
        const itemEl = $(this).closest('.objective-task-item');
        const id = Number(itemEl.attr('id')?.replace('objective-task-item-', ''));
        if (!Number.isNaN(id)) openTaskDetail(id);
    });

    $(document).on('keydown.objective-workspace', (e) => {
        if (e.key !== 'Escape' || !isWorkspaceOpen()) return;

        if ($('#objective-workspace-overflow-menu').is(':visible')) {
            closeOverflowMenu();
        } else if ($('#objective-task-detail-modal').is(':visible')) {
            closeTaskDetail();
        } else if ($('#objective-workspace-settings-panel').is(':visible')) {
            closeSettingsPanel();
        } else {
            closeWorkspace();
        }
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
    closeOverflowMenu();
    closeTaskDetail();
    $('#objective-workspace').hide();
}

function toggleSettingsPanel() {
    const panel = $('#objective-workspace-settings-panel');
    if (panel.is(':visible')) closeSettingsPanel();
    else panel.css('display', 'flex');
}

function closeSettingsPanel() {
    $('#objective-workspace-settings-panel').hide();
}

function toggleOverflowMenu() {
    const menu = $('#objective-workspace-overflow-menu');
    if (menu.is(':visible')) closeOverflowMenu();
    else menu.css('display', 'flex');
}

function closeOverflowMenu() {
    $('#objective-workspace-overflow-menu').hide();
}

/**
 * Repaint the workspace chrome — current-task readout and the Completed
 * column. The main task list is rendered by `updateUiTaskList()` in
 * ui-tasklist.js. The detail modal repaints separately on its own state
 * changes (open/navigate/etc.).
 */
export function refreshWorkspace() {
    if (!$('#objective-workspace').length) return;

    renderCurrentTaskHeader();
    renderRecentlyCompleted();

    if (state.detailTaskId != null && $('#objective-task-detail-modal').is(':visible')) {
        renderTaskDetail();
    }
}

function renderCurrentTaskHeader() {
    const text = state.currentTask?.description?.trim() || 'No active task';
    $('#objective-workspace-current-task-text').text(text);
}

/**
 * Render the Completed column with completed top-level tree tasks. Each
 * row uses the same template as Upcoming — checkbox doubles as the
 * "uncomplete" affordance.
 */
function renderRecentlyCompleted() {
    const list = $('#objective-recently-completed-list');
    if (!list.length) return;

    list.empty();

    const completed = state.currentObjective?.children?.filter(t => t.completed) ?? [];

    if (completed.length === 0) {
        list.html('<div class="objective-workspace-empty">No completed tasks yet</div>');
        return;
    }

    for (const task of completed) {
        task.addUiElement(list);
    }

    attachSortable('#objective-recently-completed-list', () => onTopLevelReorder());
}

/* ============================================================
 *                  Detail modal
 * ============================================================ */

function getDetailTask() {
    if (state.detailTaskId == null) return null;
    try {
        return getTaskById(state.detailTaskId);
    } catch (_) {
        return null;
    }
}

/** Open the detail modal showing the given task. */
export function openTaskDetail(taskId) {
    state.detailTaskId = taskId;
    $('#objective-task-detail-modal').css('display', 'flex');
    renderTaskDetail();
}

function closeTaskDetail() {
    state.detailTaskId = null;
    $('#objective-task-detail-modal').hide();
}

/** Walk one level up the parent chain, or close if we're at the top. */
function navigateUpFromDetail() {
    const task = getDetailTask();
    if (!task) {
        closeTaskDetail();
        return;
    }
    if (typeof task.parentId === 'number' && task.parentId !== 0) {
        openTaskDetail(task.parentId);
    } else {
        closeTaskDetail();
    }
}

/** Build the parent chain (excluding the root) for breadcrumb display. */
function getDetailBreadcrumb(task) {
    const chain = [];
    let cursor = task;
    while (cursor && cursor.parentId !== '' && typeof cursor.parentId === 'number') {
        let parent;
        try { parent = getTaskById(cursor.parentId); } catch (_) { break; }
        if (!parent || parent.parentId === '') break;  // skip root
        chain.unshift(parent);
        cursor = parent;
    }
    return chain;
}

function renderTaskDetail() {
    const task = getDetailTask();
    if (!task) {
        closeTaskDetail();
        return;
    }

    // Inline title — set text only when not focused, so we don't yank the
    // user's caret while they're editing.
    const $title = $('#objective-task-detail-title');
    if (!$title.is(':focus')) {
        $title.text(task.description?.trim() || '');
    }

    // Breadcrumb shows the parent chain only (current task lives in the
    // title). Empty when at top level.
    const $crumb = $('#objective-task-detail-breadcrumb');
    $crumb.empty();
    const chain = getDetailBreadcrumb(task);
    chain.forEach((ancestor, i) => {
        const link = $('<a>')
            .addClass('objective-task-detail-breadcrumb-link')
            .text(ancestor.description?.trim() || '(unnamed)')
            .attr('href', '#')
            .on('click', (e) => {
                e.preventDefault();
                openTaskDetail(ancestor.id);
            });
        $crumb.append(link);
        if (i < chain.length - 1) $crumb.append(' › ');
    });
    $('#objective-task-detail-back').toggle(chain.length > 0);

    // Subtasks list (single unified list — sort with drag).
    const $subtasks = $('#objective-task-detail-subtasks');
    $subtasks.empty();
    if (task.children && task.children.length > 0) {
        for (const child of task.children) {
            child.addUiElement($subtasks);
        }
        attachSortable('#objective-task-detail-subtasks', () => {
            const ids = $subtasks.children('.objective-task-item')
                .map((_, el) => parseInt(el.id.replace('objective-task-item-', '')))
                .get();
            const old = [...task.children];
            task.children = ids
                .map(id => old.find(t => t.id === id))
                .filter(Boolean);
            saveState();
        });
    } else {
        $subtasks.html('<div class="objective-workspace-empty">No subtasks yet</div>');
    }

    // Duration controls.
    $('#objective-task-detail-duration').val(task.duration ?? 0);
    if (task.duration > 0) {
        const elapsed = task.elapsedMessages ?? 0;
        const status = elapsed >= task.duration ? ' (complete)' : '';
        $('#objective-task-detail-duration-progress').text(
            `${elapsed}/${task.duration} messages${status}`,
        );
        $('#objective-task-detail-duration-reset').show();
    } else {
        $('#objective-task-detail-duration-progress').text('');
        $('#objective-task-detail-duration-reset').hide();
    }
}
