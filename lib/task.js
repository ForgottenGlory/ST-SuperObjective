/**
 * The ObjectiveTask class plus the tree helpers that operate on it.
 *
 * Task methods reach back into UI/persistence/statistics/etc. modules for
 * side-effects (saveState, setCurrentTask, addToCompletionHistory, ...).
 * Some of those still live in index.js during this refactor — that creates
 * a temporary cycle, which ES modules tolerate because the references are
 * inside method bodies (resolved at call time, not module-init time). As
 * those functions move to their own modules, we'll repoint the imports.
 */

import { chat_metadata, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';

import { state } from './state.js';
import { escapeHtml } from './utils.js';

import { saveState } from './persistence.js';
import { addToCompletionHistory, updateStatistics } from './statistics.js';
import { addToRecentlyCompletedTasks, updateCompletedTasksCount } from './recent-tasks.js';
import { updateUpcomingTasks } from './upcoming-tasks.js';
import { setCurrentTask, updateUiTaskList } from './ui-tasklist.js';

//###############################//
//#       Tree helpers          #//
//###############################//

/**
 * Look up a task by id in the active tree. Throws if `taskId` is null.
 * @param {number|string} taskId
 * @returns {ObjectiveTask|null}
 */
export function getTaskById(taskId) {
    if (taskId == null) {
        throw 'Null task id';
    }
    return getTaskByIdRecurse(taskId, state.taskTree);
}

/**
 * Depth-first search for a task by id, starting at `task`.
 * @param {number|string} taskId
 * @param {ObjectiveTask|null} task
 * @returns {ObjectiveTask|null}
 */
export function getTaskByIdRecurse(taskId, task) {
    if (!task) {
        return null;
    }
    if (task.id == taskId) {
        return task;
    }
    for (const childTask of task.children) {
        const found = getTaskByIdRecurse(taskId, childTask);
        if (found != null) {
            return found;
        }
    }
    return null;
}

/**
 * Find the next incomplete task to focus on, given a starting subtree.
 *
 * Direct incomplete leaves at the current level take priority; only when
 * none exist do we recurse into incomplete children. Completed branches
 * are skipped entirely. The very root (parentId === '') is never returned
 * — it is a container, not an actionable task.
 *
 * @param {ObjectiveTask} task
 * @returns {ObjectiveTask|null}
 */
export function getNextIncompleteTaskRecurse(task) {
    if (task.children && task.children.length > 0) {
        for (const child of task.children) {
            if (child.completed === false && child.children.length === 0) {
                return child;
            }
        }
        for (const child of task.children) {
            if (child.completed === true) continue;
            const found = getNextIncompleteTaskRecurse(child);
            if (found != null) return found;
        }
    }
    if (task.completed === false && task.children.length === 0 && task.parentId !== '') {
        return task;
    }
    return null;
}

/**
 * Recursively rebuild children under `parentTask` from a plain-object array
 * (the shape produced by `toSaveStateRecurse` and stored in templates and
 * exported task JSON). Children are constructed fresh so they get newly
 * minted ids — this is intentional, since ids only need to be unique
 * within the live tree.
 *
 * @param {ObjectiveTask} parentTask
 * @param {Array<object>} childrenData
 */
export function loadChildTasksFromPlainObject(parentTask, childrenData) {
    for (const data of childrenData) {
        const child = new ObjectiveTask({
            description: data.description,
            completed: !!data.completed,
            parentId: parentTask.id,
        });
        if (data.children && data.children.length > 0) {
            loadChildTasksFromPlainObject(child, data.children);
        }
        parentTask.children.push(child);
    }
}

/**
 * Increment the elapsed-message counter on the current task, and turn its
 * duration indicator green once the threshold is met. No-op when there is
 * no current task or it's already complete.
 */
export function incrementTaskElapsedMessages() {
    if (!state.currentTask || state.currentTask.completed) {
        return;
    }
    state.currentTask.elapsedMessages += 1;
    console.debug(`Incremented elapsed messages for task ${state.currentTask.id} to ${state.currentTask.elapsedMessages}`);
    saveState();
}

//###############################//
//#         Task class          #//
//###############################//

/**
 * A node in the task tree. Created with an explicit id when loading saved
 * state, otherwise auto-allocated from `state.nextTaskId`.
 */
export class ObjectiveTask {
    id;
    description;
    completed;
    parentId;
    children;
    completionDate;
    /** Minimum messages before auto-completion is allowed (0 disables). */
    duration;
    /** Messages elapsed since this task became current. */
    elapsedMessages;

    // jQuery handles for the row this task renders into. Populated by
    // addUiElement(); cleared (implicitly) when the row is replaced.
    descriptionSpan;
    completedCheckbox;
    deleteButton;
    editButton;
    dragHandle;

    constructor({
        id = undefined,
        description,
        completed = false,
        parentId = '',
        completionDate = null,
        duration = 0,
        elapsedMessages = 0,
    }) {
        if (id === undefined) {
            this.id = state.nextTaskId++;
        } else {
            this.id = id;
            if (typeof id === 'number' && id >= state.nextTaskId) {
                state.nextTaskId = id + 1;
            }
        }
        this.description = description;
        this.completed = completed;
        this.parentId = parentId;
        this.children = [];
        this.completionDate = completionDate;
        this.duration = duration;
        this.elapsedMessages = elapsedMessages;
    }

    /**
     * Append a child task (or insert at `index`) and persist.
     * @param {string} description
     * @param {number|null} [index] Defaults to end of children.
     */
    addTask(description, index = null) {
        index = index != null ? index : this.children.length;
        const newTask = new ObjectiveTask({ description, parentId: this.id });
        this.children.splice(index, 0, newTask);

        if (chat_metadata.objective.statistics) {
            chat_metadata.objective.statistics.tasksCreated++;
        }
        if (extension_settings.objective.globalStatistics) {
            extension_settings.objective.globalStatistics.tasksCreated++;
            saveSettingsDebounced();
        }

        saveState();
        return newTask;
    }

    /** Index of this task in its parent's children array. Throws if orphaned. */
    getIndex() {
        if (this.parentId !== null) {
            const parent = getTaskById(this.parentId);
            const index = parent.children.findIndex(task => task.id === this.id);
            if (index === -1) {
                throw `getIndex failed: Task '${this.description}' not found in parent task '${parent.description}'`;
            }
            return index;
        } else {
            throw `getIndex failed: Task '${this.description}' has no parent`;
        }
    }

    /**
     * If all sibling tasks (this task's parent's children) are now complete,
     * mark the parent complete too — and recurse upward so a grandparent
     * auto-completes when its full subtree is done.
     */
    checkParentComplete() {
        if (this.parentId === '') {
            return;
        }
        const parent = getTaskById(this.parentId);
        if (!parent) return;

        const allChildrenComplete = parent.children.every(child => child.completed);
        const wasCompleted = parent.completed;
        parent.completed = allChildrenComplete;

        if (allChildrenComplete && !wasCompleted) {
            console.info(`Parent task '${parent.description}' completed after all child tasks completed.`);
        }
        if (parent.completed !== wasCompleted) {
            updateUiTaskList();
            parent.checkParentComplete();
        }
    }

    /**
     * Run the post-completion side-effects (history, stats, parent cascade,
     * pick a next task, redraw). Pulled out so onCompleteClick can reuse it
     * after performing its own cascade-to-children, without re-tripping
     * completeTask's "already completed" guard.
     */
    _runCompletionSideEffects() {
        console.info(`Task successfully completed: ${JSON.stringify(this.description)}`);
        addToCompletionHistory(this);
        addToRecentlyCompletedTasks(this);
        updateStatistics(true);
        this.checkParentComplete();

        const nextTask = getNextIncompleteTaskRecurse(state.taskTree);
        setCurrentTask(nextTask ? nextTask.id : this.id);
        updateUiTaskList();
    }

    /** Mark complete (no-op if already), then run side-effects. */
    completeTask() {
        if (this.completed) {
            return;
        }
        this.completed = true;
        this.completionDate = new Date().toISOString();
        this.elapsedMessages = 0;
        this._runCompletionSideEffects();
    }

    /**
     * Render this task as a kanban-style card into the given container and
     * wire up its handlers. The whole card surface is the click target for
     * selection — actions are tucked into a footer row.
     *
     * @param {string|JQuery} [container='#objective-tasks']
     */
    addUiElement(container = '#objective-tasks') {
        const template = `
        <div id="objective-task-item-${this.id}" class="objective-task-item">
            <div id="objective-task-drag-${this.id}" class="objective-task-button objective-task-card-drag fa-solid fa-grip-vertical fa-fw" title="Drag to reorder"></div>
            <input id="objective-task-complete-${this.id}" type="checkbox" class="objective-task-card-checkbox" ${this.completed ? 'checked' : ''}>
            <span id="objective-task-description-${this.id}" class="objective-task" contenteditable="true">${escapeHtml(this.description)}</span>
            <div id="objective-task-edit-${this.id}" class="objective-task-button objective-task-card-edit fa-solid fa-pen-to-square fa-fw" title="Open details"></div>
            <div id="objective-task-delete-${this.id}" class="objective-task-button objective-task-card-delete fa-solid fa-xmark fa-fw" title="Delete"></div>
        </div>
        `;
        $(container).append(template);

        this.completedCheckbox = $(`#objective-task-complete-${this.id}`);
        this.descriptionSpan = $(`#objective-task-description-${this.id}`);
        this.deleteButton = $(`#objective-task-delete-${this.id}`);
        this.editButton = $(`#objective-task-edit-${this.id}`);
        this.dragHandle = $(`#objective-task-drag-${this.id}`);

        $(`#objective-task-complete-${this.id}`).prop('checked', this.completed);
        $(`#objective-task-complete-${this.id}`).on('click', () => this.onCompleteClick());
        $(`#objective-task-description-${this.id}`).on('input', () => this.onDescriptionUpdate());
        $(`#objective-task-description-${this.id}`).on('focusout', () => this.onDescriptionFocusout());
        $(`#objective-task-delete-${this.id}`).on('click', () => this.onDeleteClick());

        if (state.currentTask && state.currentTask.id === this.id) {
            this.descriptionSpan.addClass('objective-task-highlight');
        }
    }

    /**
     * Recursively set this task's completed state, cascading to children.
     * @param {boolean} completed
     */
    complete(completed) {
        this.completed = completed;
        if (completed && !this.completionDate) {
            this.completionDate = new Date().toISOString();
        }
        this.children.forEach(child => child.complete(completed));
    }

    onCompleteClick() {
        const wasCompleted = this.completed;
        const isNowChecked = this.completedCheckbox.prop('checked');

        // Cascade the new state to descendants — checking a parent marks all
        // sub-tasks done, unchecking marks them undone.
        this.complete(isNowChecked);
        this.elapsedMessages = 0;

        if (!wasCompleted && isNowChecked) {
            this._runCompletionSideEffects();
            return;
        }

        if (wasCompleted && !isNowChecked) {
            state.recentlyCompletedTasks = state.recentlyCompletedTasks.filter(t => t.id !== this.id);
            updateCompletedTasksCount();

            // Re-pick current to first-incomplete in the tree. If the user
            // uncompleted something earlier than the previous current, that
            // task takes over; if they uncompleted something later, the
            // existing current is still first-incomplete and stays put.
            const next = getNextIncompleteTaskRecurse(state.taskTree);
            setCurrentTask(next ? next.id : null);
        }

        this.checkParentComplete();
        updateUiTaskList();
    }

    onDescriptionUpdate() {
        this.description = this.descriptionSpan.text();
    }

    onDescriptionFocusout() {
        this.description = this.descriptionSpan.text();
        saveState();
    }

    onDeleteClick() {
        const parent = getTaskById(this.parentId);
        const taskIndex = parent.children.findIndex(task => task.id === this.id);
        if (taskIndex === -1) {
            console.error(`Failed to find task index for deletion: ${this.id}`);
            return;
        }

        if (this.children.length > 0) {
            if (!confirm('This task has sub-tasks that will also be deleted. Are you sure?')) {
                return;
            }
        }

        parent.children.splice(taskIndex, 1);

        if (state.currentTask && state.currentTask.id === this.id) {
            setCurrentTask();
        }

        updateUiTaskList();
        updateUpcomingTasks();
        saveState();
    }

    /** Plain-object snapshot for persistence. Recurses through children. */
    toSaveStateRecurse() {
        return {
            id: this.id,
            description: this.description,
            completed: this.completed,
            parentId: this.parentId,
            completionDate: this.completionDate,
            duration: this.duration,
            elapsedMessages: this.elapsedMessages,
            children: this.children.map(c => c.toSaveStateRecurse()),
        };
    }
}
