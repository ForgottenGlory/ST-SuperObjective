import { chat_metadata, saveSettingsDebounced, is_send_press, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';
import { getContext, extension_settings, saveMetadataDebounced, renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    substituteParams,
    eventSource,
    event_types,
    generateQuietPrompt,
    animation_duration,
} from '../../../../script.js';
import { waitUntilCondition } from '../../../utils.js';
import { is_group_generating, selected_group } from '../../../group-chats.js';
import { dragElement } from '../../../../scripts/RossAscends-mods.js';
import { loadMovingUIState } from '../../../../scripts/power-user.js';
import { callGenericPopup, Popup, POPUP_TYPE } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';

const MODULE_NAME = 'SuperObjective';


let taskTree = null;
let currentChatId = '';
let currentObjective = null;
let currentTask = null;
let checkCounter = 0;
let lastMessageWasSwipe = false;
let selectedCustomPrompt = 'default';
let recentlyCompletedTasks = []; // Array to store recently completed tasks
let upcomingTasks = []; // Array to store upcoming tasks

// Add a new variable to track messages since last injection
let injectionCounter = 0;


const defaultPrompts = {
    'createTask': 'Ignore previous instructions. Please generate a numbered list of plain text tasks to complete an objective. The objective that you must make a numbered task list for is: "{{objective}}". The tasks created should take into account the character traits of {{char}}. These tasks may or may not involve {{user}} directly. Include the objective as the final task.\n\nThe list should be formatted using a number followed by a fullstop and the task on each line, e.g. "1. Take over the world". Include only the list in your reply.',
    'checkTaskCompleted': 'Ignore previous instructions. Determine if this task is completed: [{{currentTask}}]. To do this, examine the most recent messages. Your response must only contain either true or false, and nothing else. Example output: true',
    'currentTask': 'Your current task is [{{currentTask}}]. Balance existing roleplay with completing this task.',
    'completedTasks': 'Recently completed tasks: {{completedTasks}}',
    'upcomingTasks': 'Upcoming tasks: {{upcomingTasks}}',
    'additionalTasks': 'Ignore previous instructions. Please generate additional numbered tasks to complete the objective: "{{objective}}". The tasks created should take into account the character traits of {{char}}. These tasks may or may not involve {{user}} directly.\n\nThe following tasks have already been created:\n{{existingTasks}}\n\nPlease generate additional tasks that complement these existing tasks. Continue the numbering from where the list left off. Do not repeat any existing tasks.\n\nThe list should be formatted using a number followed by a fullstop and the task on each line, e.g. "4. Investigate the mysterious cave". Include only the list in your reply.'
};

let objectivePrompts = defaultPrompts;

//###############################//
//#       Task Management       #//
//###############################//

// Return the task and index or throw an error
function getTaskById(taskId) {
    if (taskId == null) {
        throw 'Null task id';
    }
    return getTaskByIdRecurse(taskId, taskTree);
}

function getTaskByIdRecurse(taskId, task) {
    if (task.id == taskId) {
        return task;
    }
    for (const childTask of task.children) {
        const foundTask = getTaskByIdRecurse(taskId, childTask);
        if (foundTask != null) {
            return foundTask;
        }
    }
    return null;
}

function substituteParamsPrompts(content, substituteGlobal) {
    if (!content) {
        return '';
    }

    // Clone the content so we don't modify the original
    let result = content;

    // Always replace objective regardless of other settings
    result = result.replace(/{{objective}}/gi, currentObjective?.description ?? '');

    // Replace global params regardless of injection frequency
    if (substituteGlobal) {
        result = result.replace(/{{task}}/gi, currentTask?.description ?? '');
        result = result.replace(/{{parent}}/gi, currentTask?.parent?.description ?? '');
    }

    // Replace task-specific params
    if (currentTask && currentTask.id) {
        result = result.replace(/{{currentTask}}/g, currentTask.description);

        // Handle completed tasks if needed
        if (result.includes('{{completedTasks}}')) {
            if (recentlyCompletedTasks.length > 0) {
                const completedTasksText = recentlyCompletedTasks
                    .map(task => `[${task.description}]`)
                    .join(', ');
                result = result.replace(/{{completedTasks}}/gi, completedTasksText);
            } else {
                // Replace with a message indicating no completed tasks
                result = result.replace(/{{completedTasks}}/gi, "No tasks completed yet");
            }
        }

        // Handle upcoming tasks if needed
        if (result.includes('{{upcomingTasks}}')) {
            if (upcomingTasks.length > 0) {
                const upcomingTasksText = upcomingTasks
                    .map(task => `[${task.description}]`)
                    .join(', ');
                result = result.replace(/{{upcomingTasks}}/gi, upcomingTasksText);
            } else {
                // Replace with a message indicating no upcoming tasks
                result = result.replace(/{{upcomingTasks}}/gi, "No upcoming tasks yet");
            }
        }
    } else {
        // If there's no current task, remove task-related placeholders
        result = result.replace(/{{currentTask}}/g, '');
        result = result.replace(/{{completedTasks}}/g, '');
        result = result.replace(/{{upcomingTasks}}/g, '');
    }

    return result;
}

// Call Quiet Generate to create task list using character context, then convert to tasks. Should not be called much.
async function generateTasks() {
    const prompt = substituteParamsPrompts(objectivePrompts.createTask, false);
    console.log('Generating tasks for objective with prompt');
    toastr.info('Generating tasks for objective', 'Please wait...');
    const taskResponse = await generateQuietPrompt(prompt, false, false);

    // Clear all existing objective tasks when generating
    currentObjective.children = [];
    const numberedListPattern = /^\d+\./;

    // Track the first task we add
    let firstTask = null;

    // Create tasks from generated task list
    for (const task of taskResponse.split('\n').map(x => x.trim())) {
        if (task.match(numberedListPattern) != null) {
            const newTask = currentObjective.addTask(task.replace(numberedListPattern, '').trim());
            if (!firstTask) {
                firstTask = newTask;
            }
        }
    }
    updateUiTaskList();

    // Find and highlight the first task
    if (firstTask) {
        setCurrentTask(firstTask.id);
    } else {
        setCurrentTask();
    }

    console.info(`Response for Objective: '${currentObjective.description}' was \n'${taskResponse}', \nwhich created tasks \n${JSON.stringify(currentObjective.children.map(v => { return v.toSaveState(); }), null, 2)} `);
    toastr.success(`Generated ${currentObjective.children.length} tasks`, 'Done!');
}

// Generate additional tasks without clearing existing ones
async function generateAdditionalTasks() {
    // If there are no existing tasks, just use the regular generate function
    if (!currentObjective || currentObjective.children.length === 0) {
        return generateTasks();
    }

    // Create a list of existing tasks for the prompt
    let existingTasksText = currentObjective.children.map((task, index) =>
        `${index + 1}. ${task.description}`).join('\n');

    // Use the additionalTasks prompt with the existing tasks inserted
    let additionalPrompt = objectivePrompts.additionalTasks || defaultPrompts.additionalTasks;
    additionalPrompt = additionalPrompt.replace(/{{existingTasks}}/gi, existingTasksText);

    // Make sure objective is replaced before calling substituteParamsPrompts
    additionalPrompt = additionalPrompt.replace(/{{objective}}/gi, currentObjective?.description ?? '');

    additionalPrompt = substituteParamsPrompts(additionalPrompt, false);

    console.log('Generating additional tasks for objective');
    toastr.info('Generating additional tasks', 'Please wait...');

    const taskResponse = await generateQuietPrompt(additionalPrompt, false, false);
    const initialTaskCount = currentObjective.children.length;
    const numberedListPattern = /^\d+\./;

    // Track the first new task we add
    let firstNewTask = null;

    // Add new tasks to the existing list
    for (const task of taskResponse.split('\n').map(x => x.trim())) {
        if (task.match(numberedListPattern) != null) {
            const newTask = currentObjective.addTask(task.replace(numberedListPattern, '').trim());
            if (!firstNewTask) {
                firstNewTask = newTask;
            }
        }
    }

    const newTaskCount = currentObjective.children.length - initialTaskCount;
    updateUiTaskList();

    // If new tasks were added, highlight the first new task
    if (newTaskCount > 0 && firstNewTask) {
        setCurrentTask(firstNewTask.id);
    } else {
        // Otherwise find the first incomplete task
        const nextTask = getNextIncompleteTaskRecurse(taskTree);
        if (nextTask) {
            setCurrentTask(nextTask.id);
        } else {
            setCurrentTask();
        }
    }

    console.info(`Generated ${newTaskCount} additional tasks for objective: '${currentObjective.description}'`);
    toastr.success(`Added ${newTaskCount} additional tasks`, 'Done!');
}

async function markTaskCompleted() {
    // Make sure there's a current task
    if (jQuery.isEmptyObject(currentTask)) {
        console.warn('No current task to mark as completed');
        toastr.warning('No current task to mark as completed');
        return;
    }

    console.info(`User determined task '${currentTask.description}' is completed.`);

    // Store the current task ID before completing it
    const taskId = currentTask.id;

    // Only add to recently completed tasks if it wasn't already completed
    if (!currentTask.completed) {
        currentTask.completeTask();

        // After completing the task, find the next task and highlight it
        const nextTask = getNextIncompleteTaskRecurse(taskTree);
        if (nextTask) {
            setCurrentTask(nextTask.id);
        } else {
            // If no next task, keep the completed task highlighted
            setCurrentTask(taskId);
        }
    } else {
        toastr.info('Task was already marked as completed');
    }
}

// Call Quiet Generate to check if a task is completed
async function checkTaskCompleted() {
    // Make sure there are tasks
    if (jQuery.isEmptyObject(currentTask)) {
        console.warn('No current task to check');
        return String(false);
    }

    // Show toast immediately at the start of the function
    const toast = toastr.info('Checking for task completion...', 'Task Check');

    try {
        // Wait for group to finish generating
        if (selected_group) {
            await waitUntilCondition(() => is_group_generating === false, 10000, 100);
        }
        // Another extension might be doing something with the chat, so wait for it to finish
        await waitUntilCondition(() => is_send_press === false, 30000, 100);
    } catch {
        console.debug('Failed to wait for group to finish generating');
        // Clear the toast if we're failing early
        toastr.clear(toast);
        return String(false);
    }

    // Store the current task ID before checking
    const taskId = currentTask.id;

    // Check if the task has a duration set and if enough messages have passed
    if (currentTask.duration > 0) {
        // If not enough messages have passed, skip the completion check
        if (currentTask.elapsedMessages < currentTask.duration) {
            console.debug(`Task ${currentTask.id} has duration ${currentTask.duration}, but only ${currentTask.elapsedMessages} messages have passed`);

            // Prepare the check prompt (but don't send it yet)
            const prompt = substituteParamsPrompts(objectivePrompts.checkTaskCompleted, false);

            // Run a quiet check to see if the task would be completed
            const taskResponse = (await generateQuietPrompt(prompt, false, false)).toLowerCase();

            // Clear the initial toast
            toastr.clear(toast);

            // If the task would be completed but duration requirement not met, show a special message
            if (taskResponse.includes('true')) {
                console.debug(`Task ${currentTask.id} would be completed but duration requirement not met: ${currentTask.elapsedMessages}/${currentTask.duration} messages passed`);
                toastr.warning(`Task would be completed but duration requirement not met: ${currentTask.elapsedMessages}/${currentTask.duration} messages needed`, 'Task Duration Not Met');
            }

            // Reset counter but don't check completion yet
            checkCounter = Number($('#objective-check-frequency').val());

            // Make sure to preserve the highlight
            setCurrentTask(taskId);

            return String(false);
        }

        console.debug(`Task ${currentTask.id} duration requirement met: ${currentTask.elapsedMessages}/${currentTask.duration} messages passed`);
    }

    // At this point either there's no duration requirement or the requirement has been met
    // Generate the prompt and get response
    const prompt = substituteParamsPrompts(objectivePrompts.checkTaskCompleted, false);
    const taskResponse = (await generateQuietPrompt(prompt, false, false)).toLowerCase();

    // Clear the "checking" toast
    toastr.clear(toast);

    // Reset check counter for next time
    checkCounter = Number($('#objective-check-frequency').val());

    // Check response if task complete
    if (taskResponse.includes('true')) {
        console.info(`Character determined task '${currentTask.description}' is completed.`);
        currentTask.completeTask();
        toastr.success(`Task "${currentTask.description}" completed!`, 'Task Completed');
        return String(true);
    } else if (!(taskResponse.includes('false'))) {
        console.warn(`checkTaskCompleted response did not contain true or false. taskResponse: ${taskResponse}`);
    } else {
        console.debug(`Checked task completion. taskResponse: ${taskResponse}`);
        // Show a toast notification when task is not completed
        toastr.info(`Task "${currentTask.description}" is not complete yet`, 'Task Incomplete');
        // If task is not completed, make sure to preserve the highlight
        setCurrentTask(taskId);
    }

    return String(false);
}

function getNextIncompleteTaskRecurse(task) {
    // First check direct children to prioritize tasks at the top level
    if (task.children && task.children.length > 0) {
        for (const childTask of task.children) {
            // Return the first incomplete task at this level
            if (childTask.completed === false && childTask.children.length === 0) {
                return childTask;
            }
        }

        // If no direct incomplete children, then recurse into each child
        for (const childTask of task.children) {
            if (childTask.completed === true) { // Don't recurse into completed tasks
                continue;
            }
            const foundTask = getNextIncompleteTaskRecurse(childTask);
            if (foundTask != null) {
                return foundTask;
            }
        }
    }

    // If this is a leaf task and it's incomplete, return it
    if (task.completed === false
        && task.children.length === 0
        && task.parentId !== '') {
        return task;
    }

    return null;
}

// Increment elapsed messages count for the current task
function incrementTaskElapsedMessages() {
    if (!currentTask || jQuery.isEmptyObject(currentTask) || currentTask.completed) {
        return;
    }

    // Increment the elapsed messages counter for the current task
    currentTask.elapsedMessages += 1;
    console.debug(`Incremented elapsed messages for task ${currentTask.id} to ${currentTask.elapsedMessages}`);

    // Update the duration button color if the task has now met its duration
    if (currentTask.duration > 0 && currentTask.elapsedMessages >= currentTask.duration) {
        currentTask.durationButton.css({ 'color': '#33cc33' }); // Change to green when duration is met
    }

    // Save the state to persist the counter
    saveState();
}

// Set a task in extensionPrompt context. Defaults to first incomplete
function setCurrentTask(taskId = null, skipSave = false) {
    const context = getContext();

    // Store the previous current task ID
    const previousTaskId = currentTask && !jQuery.isEmptyObject(currentTask) ? currentTask.id : null;

    // TODO: Should probably null this rather than set empty object
    currentTask = {};

    // Find the task, either next incomplete, or by provided taskId
    if (taskId === null) {
        currentTask = getNextIncompleteTaskRecurse(taskTree) || {};
    } else {
        try {
            currentTask = getTaskById(taskId);
        } catch (e) {
            console.warn(`Failed to set current task with ID ${taskId}: ${e}`);
            currentTask = getNextIncompleteTaskRecurse(taskTree) || {};
        }
    }

    // Don't just check for a current task, check if it has data
    const description = currentTask.description || null;
    if (description) {
        // If this is a different task than before, reset the elapsed messages counter
        if (previousTaskId !== currentTask.id) {
            currentTask.elapsedMessages = 0;
            console.debug(`Reset elapsed messages counter for new current task ${currentTask.id}`);
        }

        // Check if we should inject the task based on the injection counter
        // Always inject if:
        // - skipSave is true (usually means we just loaded from settings)
        // - injectionCounter is 0 (it's time to inject based on frequency)
        // - it's a new task (previous task ID is different)
        const shouldInjectTask = skipSave || injectionCounter === 0 || previousTaskId !== currentTask.id;

        if (shouldInjectTask) {
            let extensionPromptText = substituteParamsPrompts(objectivePrompts.currentTask, true);

            // Add recently completed tasks if enabled
            if ($('#objective-show-completed').prop('checked') && recentlyCompletedTasks.length > 0) {
                const completedTasksText = recentlyCompletedTasks
                    .map(task => `[${task.description}]`)
                    .join(', ');

                let completedTasksPrompt = objectivePrompts.completedTasks.replace(/{{completedTasks}}/gi, completedTasksText);
                completedTasksPrompt = substituteParams(completedTasksPrompt);

                extensionPromptText = `${extensionPromptText}\n${completedTasksPrompt}`;
            }

            // Update upcoming tasks based on the current task
            updateUpcomingTasks();

            // Add upcoming tasks if enabled
            if ($('#objective-show-upcoming').prop('checked') && upcomingTasks.length > 0) {
                const upcomingTasksText = upcomingTasks
                    .map(task => `[${task.description}]`)
                    .join(', ');

                let upcomingTasksPrompt = objectivePrompts.upcomingTasks.replace(/{{upcomingTasks}}/gi, upcomingTasksText);
                upcomingTasksPrompt = substituteParams(upcomingTasksPrompt);

                extensionPromptText = `${extensionPromptText}\n${upcomingTasksPrompt}`;
            }

            // Get the prompt role from settings (default to SYSTEM if not set)
            const promptRole = chat_metadata.objective.promptRole || extension_prompt_roles.SYSTEM;

            // Update the extension prompt
            context.setExtensionPrompt(
                MODULE_NAME,
                extensionPromptText,
                extension_prompt_types.IN_CHAT,
                Number($('#objective-chat-depth').val()),
                true, // allowWIScan - should typically be true
                promptRole // Pass the prompt role to determine how the task appears in chat
            );
            console.info(`Current task in context.extensionPrompts.Objective is ${JSON.stringify(context.extensionPrompts.Objective)}`);
        } else {
            // If we're not supposed to inject the task, remove it from the prompt
            context.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, 0);
            console.info('Skipping task injection due to frequency setting');
        }

        // Always update UI
        // Remove highlights from all tasks
        $('.objective-task').removeClass('objective-task-highlight');
        $('.objective-task').css({ 'border-color': '', 'border-width': '' });

        // Highlight only the current task with the new class
        if (currentTask.descriptionSpan) {
            currentTask.descriptionSpan.addClass('objective-task-highlight');
        }
    } else {
        context.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, 0);
        console.info('No current task');
    }

    if (!skipSave) {
        saveState();
    }
}

function getHighestTaskIdRecurse(task) {
    let nextId = task.id;

    for (const childTask of task.children) {
        const childId = getHighestTaskIdRecurse(childTask);
        if (childId > nextId) {
            nextId = childId;
        }
    }
    return nextId;
}

//###############################//
//#         Task Class          #//
//###############################//
class ObjectiveTask {
    id;
    description;
    completed;
    parentId;
    children;
    completionDate;
    duration; // Task duration (minimum messages before auto-completion)
    elapsedMessages; // Track elapsed messages since the task became current

    taskHtml;
    descriptionSpan;
    completedCheckbox;
    deleteTaskButton;
    addTaskButton;
    branchButton;
    dragHandle;
    durationButton; // UI element for duration settings

    constructor({ id = undefined, description, completed = false, parentId = '', completionDate = null, duration = 0, elapsedMessages = 0 }) {
        this.id = id === undefined ? getHighestTaskIdRecurse(taskTree) + 1 : id;
        this.description = description;
        this.completed = completed;
        this.parentId = parentId;
        this.children = [];
        this.completionDate = completionDate;
        this.duration = duration; // Initialize duration property
        this.elapsedMessages = elapsedMessages; // Initialize elapsed messages counter
    }

    // Accepts optional index. Defaults to adding to end of list.
    addTask(description, index = null) {
        index = index != null ? index : index = this.children.length;
        const newTask = new ObjectiveTask(
            { description: description, parentId: this.id }
        );
        this.children.splice(index, 0, newTask);

        // Update statistics - both chat-specific and global
        if (chat_metadata.objective.statistics) {
            chat_metadata.objective.statistics.tasksCreated++;
        }

        // Update global statistics
        if (extension_settings.objective.globalStatistics) {
            extension_settings.objective.globalStatistics.tasksCreated++;
            saveSettingsDebounced();
        }

        saveState();
        return newTask;
    }

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

    // Used to set parent to complete when all child tasks are completed
    checkParentComplete() {
        let all_completed = true;
        if (this.parentId !== '') {
            const parent = getTaskById(this.parentId);
            for (const child of parent.children) {
                if (!child.completed) {
                    all_completed = false;
                    break;
                }
            }
            if (all_completed) {
                parent.completed = true;
                console.info(`Parent task '${parent.description}' completed after all child tasks complated.`);
                updateUiTaskList();
            } else {
                parent.completed = false;
            }
        }
    }

    // Complete the current task, setting next task to next incomplete task
    completeTask() {
        // If already completed, don't do anything
        if (this.completed) {
            return;
        }

        // Store the current task ID before completing it
        const taskId = this.id;

        this.completed = true;
        this.completionDate = new Date().toISOString();

        // Reset the elapsed messages counter when the task is completed
        this.elapsedMessages = 0;

        console.info(`Task successfully completed: ${JSON.stringify(this.description)}`);

        // Add to completion history
        addToCompletionHistory(this);

        // Add to recently completed tasks
        addToRecentlyCompletedTasks(this);

        // Update statistics
        updateStatistics(true);

        this.checkParentComplete();

        // Find the next task to highlight
        const nextTask = getNextIncompleteTaskRecurse(taskTree);
        if (nextTask) {
            setCurrentTask(nextTask.id);
        } else {
            // If no next task, keep the completed task highlighted
            setCurrentTask(taskId);
        }

        updateUiTaskList();
    }

    // Add a single task to the UI and attach event listeners for user edits
    addUiElement() {
        // Use template string, assign ids to elements for later reference
        const template = `
        <div id="objective-task-item-${this.id}" class="objective-task-item">
            <div id="objective-task-label-${this.id}" class="flex1 checkbox_label alignItemsCenter">
                <div id="objective-task-drag-${this.id}" class="objective-task-button fa-solid fa-grip-vertical fa-fw fa-lg" title="Drag to reorder"></div>
                <input id="objective-task-complete-${this.id}" type="checkbox" ${this.completed ? 'checked' : ''}>
                <span id="objective-task-description-${this.id}" class="text_pole objective-task" contenteditable="true">${this.description}</span>
                <div id="objective-task-delete-${this.id}" class="objective-task-button fa-solid fa-xmark fa-fw fa-lg" title="Delete Task"></div>
                <div id="objective-task-add-${this.id}" class="objective-task-button fa-solid fa-plus fa-fw fa-lg" title="Add Task"></div>
                <div id="objective-task-add-branch-${this.id}" class="objective-task-button fa-solid fa-code-fork fa-fw fa-lg" title="Branch Task"></div>
                <div id="objective-task-duration-${this.id}" class="objective-task-button fa-solid fa-clock fa-fw fa-lg" title="Task Duration Settings"></div>
            </div>
        </div>
        `;

        // Add the filled out template
        $('#objective-tasks').append(template);

        this.completedCheckbox = $(`#objective-task-complete-${this.id}`);
        this.descriptionSpan = $(`#objective-task-description-${this.id}`);
        this.addButton = $(`#objective-task-add-${this.id}`);
        this.deleteButton = $(`#objective-task-delete-${this.id}`);
        this.taskHtml = $(`#objective-task-label-${this.id}`);
        this.branchButton = $(`#objective-task-add-branch-${this.id}`);
        this.dragHandle = $(`#objective-task-drag-${this.id}`);
        this.durationButton = $(`#objective-task-duration-${this.id}`);

        // Handle sub-task forking style
        if (this.children.length > 0) {
            this.branchButton.css({ 'color': '#33cc33' });
        } else {
            this.branchButton.css({ 'color': '' });
        }

        // Style duration button based on duration settings and progress
        if (this.duration > 0) {
            if (this.elapsedMessages >= this.duration) {
                // Green if duration requirement met
                this.durationButton.css({ 'color': '#33cc33' });
            } else {
                // Yellow if duration set but not yet met
                this.durationButton.css({ 'color': '#ffcc00' });
            }
        } else {
            // Default color if no duration set
            this.durationButton.css({ 'color': '' });
        }

        // Add event listeners and set properties
        $(`#objective-task-complete-${this.id}`).prop('checked', this.completed);
        $(`#objective-task-complete-${this.id}`).on('click', () => (this.onCompleteClick()));
        $(`#objective-task-description-${this.id}`).on('keyup', () => (this.onDescriptionUpdate()));
        $(`#objective-task-description-${this.id}`).on('focusout', () => (this.onDescriptionFocusout()));
        $(`#objective-task-delete-${this.id}`).on('click', () => (this.onDeleteClick()));
        $(`#objective-task-add-${this.id}`).on('click', () => (this.onAddClick()));
        this.branchButton.on('click', () => (this.onBranchClick()));
        this.durationButton.on('click', () => (this.onDurationClick()));

        // If this is the current task, highlight it
        if (currentTask && currentTask.id === this.id) {
            this.descriptionSpan.addClass('objective-task-highlight');
        }
    }

    onBranchClick() {
        currentObjective = this;
        updateUiTaskList();

        // Find the first incomplete task in this branch
        const nextTask = getNextIncompleteTaskRecurse(this);
        if (nextTask) {
            setCurrentTask(nextTask.id);
        } else {
            // If no incomplete tasks in this branch, highlight the branch itself
            setCurrentTask(this.id);
        }
    }

    complete(completed) {
        this.completed = completed;

        // If marking as completed, set completion date if it doesn't exist
        if (completed && !this.completionDate) {
            this.completionDate = new Date().toISOString();
        }

        // Apply to all children recursively
        this.children.forEach(child => child.complete(completed));
    }
    onCompleteClick() {
        const wasCompleted = this.completed;
        this.complete(this.completedCheckbox.prop('checked'));

        // If task was just marked as completed, add to recently completed tasks
        if (!wasCompleted && this.completed) {
            // Set completion date if it doesn't exist
            if (!this.completionDate) {
                this.completionDate = new Date().toISOString();
            }

            // Add to recently completed tasks
            addToRecentlyCompletedTasks(this);

            // Add to completion history
            addToCompletionHistory(this);

            // Update statistics
            updateStatistics(true);

            // Find the next incomplete task to highlight
            const nextTask = getNextIncompleteTaskRecurse(taskTree);
            if (nextTask) {
                setCurrentTask(nextTask.id);
            } else {
                // If no next task, keep the completed task highlighted
                setCurrentTask(this.id);
            }
        }
        // If task was just marked as not completed, remove from recently completed tasks
        else if (wasCompleted && !this.completed) {
            // Remove from recently completed tasks
            recentlyCompletedTasks = recentlyCompletedTasks.filter(task => task.id !== this.id);

            // Update the UI with the new count
            updateCompletedTasksCount();

            // This task is now the first incomplete task, so highlight it
            setCurrentTask(this.id);
        }
        // If the completion state didn't change, just keep the current task highlighted
        else {
            setCurrentTask(this.id);
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

        // Check if this task has children
        if (this.children.length > 0) {
            // Ask for confirmation when deleting a task with children
            const confirmMessage = "This task has sub-tasks that will also be deleted. Are you sure?";
            if (!confirm(confirmMessage)) {
                return;
            }
        }

        // Remove this task from its parent's children array
        parent.children.splice(taskIndex, 1);

        // If this is the current task, find a new current task
        if (currentTask && currentTask.id === this.id) {
            // Look for the next incomplete task
            setCurrentTask();
        }

        // Update the UI
        updateUiTaskList();
        updateUpcomingTasks();

        // Save the updated state
        saveState();
    }

    onAddClick() {
        const addAtIndex = this.getIndex() + 1;
        currentObjective.addTask('New Task', addAtIndex);
        updateUiTaskList();
        saveState();
    }

    onDurationClick() {
        // Store task reference for use in event handlers
        const task = this;

        // Create the popup HTML
        const popupContent = `
        <div class="objective_duration_modal">
            <h4>Task Duration Settings</h4>
            <div class="objective_block objective_block_control marginBottom10">
                <label for="task-duration-value-${this.id}">Minimum messages before auto-completion:</label>
                <input id="task-duration-value-${this.id}" type="number" min="0" max="50" value="${this.duration}" class="text_pole widthUnset">
                <small>(0 = no delay)</small>
            </div>
            ${this.duration > 0 ? `
            <div class="objective_block marginBottom10" id="task-duration-progress-${this.id}">
                <strong>Current progress:</strong> ${this.elapsedMessages}/${this.duration} messages
                ${this.elapsedMessages >= this.duration ? '<span class="task-duration-progress-complete"> (Complete)</span>' : ''}
            </div>
            ` : ''}
            ${this.duration > 0 ? `
            <div class="objective_block flex-container flexWrap">
                <input id="task-duration-reset-${this.id}" class="menu_button" type="button" value="Reset Progress">
            </div>
            ` : ''}
        </div>
        `;

        // Function to save the duration value
        const saveDuration = function () {
            // Get the duration value from the input
            const duration = parseInt($(`#task-duration-value-${task.id}`).val());

            // Update the task duration
            task.duration = isNaN(duration) ? 0 : duration;

            // Reset the elapsed messages if duration is changed to 0
            if (task.duration === 0) {
                task.elapsedMessages = 0;
            }

            // Update the duration button style
            if (task.duration > 0) {
                if (task.elapsedMessages >= task.duration) {
                    task.durationButton.css({ 'color': '#33cc33' }); // Green if duration requirement met
                } else {
                    task.durationButton.css({ 'color': '#ffcc00' }); // Yellow if duration set but not yet met
                }
            } else {
                task.durationButton.css({ 'color': '' }); // Default color if no duration
            }

            // Save the state
            saveState();
        };

        // Show the popup and register the callback for when OK is clicked
        callGenericPopup(popupContent, POPUP_TYPE.TEXT, 'Task Duration Settings', {
            allowVerticalScrolling: true,
            okButton: 'Save',
            onClose: saveDuration
        });

        // Add event listener for reset button if it exists
        if (this.duration > 0) {
            $(`#task-duration-reset-${this.id}`).on('click', function () {
                // Reset the elapsed messages counter
                task.elapsedMessages = 0;

                // Update the button color
                task.durationButton.css({ 'color': '#ffcc00' });

                // Update the progress display in the popup
                const progressHtml = `
                <strong>Current progress:</strong> 0/${task.duration} messages
                `;
                $(`#task-duration-progress-${task.id}`).html(progressHtml);

                // Save the state
                saveState();
            });
        }
    }

    toSaveStateRecurse() {
        const saveState = {
            id: this.id,
            description: this.description,
            completed: this.completed,
            parentId: this.parentId,
            completionDate: this.completionDate,
            duration: this.duration,
            elapsedMessages: this.elapsedMessages,
            children: []
        };

        if (this.children.length > 0) {
            for (const child of this.children) {
                saveState.children.push(child.toSaveStateRecurse());
            }
        }

        return saveState;
    }
}

//###############################//
//#       Custom Prompts        #//
//###############################//

function onEditPromptClick() {
    let popupText = '';
    popupText += `
    <div class="objective_prompt_modal">
        <div class="objective_prompt_block justifyCenter">
            <label for="objective-custom-prompt-select">Custom Prompt Select</label>
            <select id="objective-custom-prompt-select" class="text_pole"><select>
        </div>
        <div class="objective_prompt_block justifyCenter">
            <input id="objective-custom-prompt-new" class="menu_button" type="submit" value="New Prompt" />
            <input id="objective-custom-prompt-save" class="menu_button" type="submit" value="Update Prompt" />
            <input id="objective-custom-prompt-delete" class="menu_button" type="submit" value="Delete Prompt" />
        </div>
        <div class="objective_prompt_block justifyCenter">
            <input id="objective-custom-prompt-export" class="menu_button" type="submit" value="Export Selected Prompt" />
            <input id="objective-custom-prompt-import" class="menu_button" type="submit" value="Import Prompts" />
        </div>
        <hr class="m-t-1 m-b-1">
        <small>Edit prompts used by Objective for this session. You can use {{objective}} or {{currentTask}} plus any other standard template variables. Save template to persist changes.</small>
        <hr class="m-t-1 m-b-1">
        <div>
            <label for="objective-prompt-generate">Generation Prompt</label>
            <textarea id="objective-prompt-generate" type="text" class="text_pole textarea_compact" rows="6"></textarea>
            <label for="objective-prompt-additional">Additional Tasks Prompt</label>
            <textarea id="objective-prompt-additional" type="text" class="text_pole textarea_compact" rows="6"></textarea>
            <label for="objective-prompt-check">Completion Check Prompt</label>
            <textarea id="objective-prompt-check" type="text" class="text_pole textarea_compact" rows="6"></textarea>
            <label for="objective-prompt-extension-prompt">Injected Prompt</label>
            <textarea id="objective-prompt-extension-prompt" type="text" class="text_pole textarea_compact" rows="6"></textarea>
            <label for="objective-prompt-completed-tasks">Completed Tasks Prompt</label>
            <textarea id="objective-prompt-completed-tasks" type="text" class="text_pole textarea_compact" rows="6"></textarea>
            <label for="objective-prompt-upcoming-tasks">Upcoming Tasks Prompt</label>
            <textarea id="objective-prompt-upcoming-tasks" type="text" class="text_pole textarea_compact" rows="6"></textarea>
        </div>
    </div>`;
    callGenericPopup(popupText, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true, wide: true });
    populateCustomPrompts(selectedCustomPrompt);

    // Set current values
    $('#objective-prompt-generate').val(objectivePrompts.createTask);
    $('#objective-prompt-additional').val(objectivePrompts.additionalTasks || defaultPrompts.additionalTasks);
    $('#objective-prompt-check').val(objectivePrompts.checkTaskCompleted);
    $('#objective-prompt-extension-prompt').val(objectivePrompts.currentTask);
    $('#objective-prompt-completed-tasks').val(objectivePrompts.completedTasks || defaultPrompts.completedTasks);
    $('#objective-prompt-upcoming-tasks').val(objectivePrompts.upcomingTasks || defaultPrompts.upcomingTasks);

    // Handle value updates
    $('#objective-prompt-generate').on('input', () => {
        objectivePrompts.createTask = String($('#objective-prompt-generate').val());
        saveState();
        setCurrentTask();
    });
    $('#objective-prompt-additional').on('input', () => {
        objectivePrompts.additionalTasks = String($('#objective-prompt-additional').val());
        saveState();
        setCurrentTask();
    });
    $('#objective-prompt-check').on('input', () => {
        objectivePrompts.checkTaskCompleted = String($('#objective-prompt-check').val());
        saveState();
        setCurrentTask();
    });
    $('#objective-prompt-extension-prompt').on('input', () => {
        objectivePrompts.currentTask = String($('#objective-prompt-extension-prompt').val());
        saveState();
        setCurrentTask();
    });
    $('#objective-prompt-completed-tasks').on('input', () => {
        objectivePrompts.completedTasks = String($('#objective-prompt-completed-tasks').val());
        saveState();
        setCurrentTask();
    });
    $('#objective-prompt-upcoming-tasks').on('input', () => {
        objectivePrompts.upcomingTasks = String($('#objective-prompt-upcoming-tasks').val());
        saveState();
        setCurrentTask();
    });

    // Handle new
    $('#objective-custom-prompt-new').on('click', () => {
        newCustomPrompt();
    });

    // Handle save
    $('#objective-custom-prompt-save').on('click', () => {
        saveCustomPrompt();
    });

    // Handle delete
    $('#objective-custom-prompt-delete').on('click', () => {
        deleteCustomPrompt();
    });

    // Handle export
    $('#objective-custom-prompt-export').on('click', () => {
        exportCustomPrompts();
    });

    // Handle import
    $('#objective-custom-prompt-import').on('click', () => {
        importCustomPrompts();
    });

    // Handle load
    $('#objective-custom-prompt-select').on('change', loadCustomPrompt);
}

async function newCustomPrompt() {
    const customPromptName = await Popup.show.input('Custom Prompt name', null);

    if (!customPromptName) {
        toastr.warning('Please set custom prompt name to save.');
        return;
    }
    if (customPromptName == 'default') {
        toastr.error('Cannot save over default prompt');
        return;
    }

    // Make sure we have all prompt types, including additionalTasks
    if (!objectivePrompts.additionalTasks) {
        objectivePrompts.additionalTasks = defaultPrompts.additionalTasks;
    }

    // Make sure we have the completed tasks prompt
    if (!objectivePrompts.completedTasks) {
        objectivePrompts.completedTasks = defaultPrompts.completedTasks;
    }

    // Make sure we have the upcoming tasks prompt
    if (!objectivePrompts.upcomingTasks) {
        objectivePrompts.upcomingTasks = defaultPrompts.upcomingTasks;
    }

    extension_settings.objective.customPrompts[customPromptName] = {};
    Object.assign(extension_settings.objective.customPrompts[customPromptName], objectivePrompts);
    saveSettingsDebounced();
    populateCustomPrompts(customPromptName);
}

function saveCustomPrompt() {
    const customPromptName = String($('#objective-custom-prompt-select').find(':selected').val());
    if (customPromptName == 'default') {
        toastr.error('Cannot save over default prompt');
        return;
    }
    Object.assign(extension_settings.objective.customPrompts[customPromptName], objectivePrompts);
    saveSettingsDebounced();
    populateCustomPrompts(customPromptName);
    toastr.success('Prompt saved as ' + customPromptName);
}

async function deleteCustomPrompt() {
    const customPromptName = String($('#objective-custom-prompt-select').find(':selected').val());

    if (customPromptName == 'default') {
        toastr.error('Cannot delete default prompt');
        return;
    }

    const confirmation = await Popup.show.confirm('Are you sure you want to delete this prompt?', null);

    if (!confirmation) {
        return;
    }

    delete extension_settings.objective.customPrompts[customPromptName];
    saveSettingsDebounced();
    selectedCustomPrompt = 'default';
    populateCustomPrompts(selectedCustomPrompt);
    loadCustomPrompt();
}

// Export prompt sets to a JSON file
async function exportCustomPrompts() {
    const promptName = $('#objective-custom-prompt-select').val();

    // Check if a prompt is selected
    if (!promptName) {
        toastr.warning('Please select a prompt to export');
        return;
    }

    // Check if the prompt exists
    if (!extension_settings.objective.customPrompts || !extension_settings.objective.customPrompts[promptName]) {
        toastr.error('Prompt not found');
        return;
    }

    // Prepare export data with only the selected prompt
    const exportData = {
        customPrompts: {
            [promptName]: extension_settings.objective.customPrompts[promptName]
        },
        exportDate: new Date().toISOString(),
        version: '1.0'
    };

    // Convert to JSON string
    const jsonString = JSON.stringify(exportData, null, 2);

    // Create default filename based on prompt name
    const defaultFilename = `objective-prompt-${promptName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').substring(0, 30)}.json`;

    // Ask user for custom filename
    let filename = await Popup.show.input('Enter filename for export', defaultFilename);

    // If user cancels or provides empty filename, use the default
    if (!filename) {
        filename = defaultFilename;
    }

    // Ensure filename has .json extension
    if (!filename.toLowerCase().endsWith('.json')) {
        filename += '.json';
    }

    // Create download link
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    // Create and trigger download link
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    // Clean up
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);

    toastr.success(`Prompt "${promptName}" exported as "${filename}"`);
}

// Import prompt sets from a JSON file
async function importCustomPrompts() {
    // Create file input element
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';

    // Handle file selection
    fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            // Read file
            const text = await file.text();
            const importData = JSON.parse(text);

            // Validate import data
            if (!importData.customPrompts || typeof importData.customPrompts !== 'object') {
                throw new Error('Invalid prompt file format');
            }

            // Count prompts to import
            const promptCount = Object.keys(importData.customPrompts).length;
            if (promptCount === 0) {
                throw new Error('No prompts found in the import file');
            }

            // Initialize customPrompts object if it doesn't exist
            if (!extension_settings.objective.customPrompts) {
                extension_settings.objective.customPrompts = {};
            }

            // Check for existing prompts with the same names
            const existingPrompts = [];
            for (const promptName in importData.customPrompts) {
                if (extension_settings.objective.customPrompts[promptName]) {
                    existingPrompts.push(promptName);
                }
            }

            // If there are existing prompts, ask for conflict resolution choice
            if (existingPrompts.length > 0) {
                let choice = 'skip'; // Default to skip if no choice is made

                // Check if Popup.show.select is available
                if (typeof Popup.show.select === 'function') {
                    const options = [
                        { text: 'Overwrite existing prompts', value: 'overwrite' },
                        { text: 'Import with numbered suffix (e.g. "prompt-2")', value: 'rename' },
                        { text: 'Skip conflicting prompts', value: 'skip' }
                    ];

                    choice = await Popup.show.select(
                        `${existingPrompts.length} prompt(s) already exist with the same name. How would you like to handle this?`,
                        options
                    );
                } else {
                    // Fallback to confirm dialog if select is not available
                    const confirmation = await Popup.show.confirm(
                        `${existingPrompts.length} prompt(s) already exist with the same name. Would you like to overwrite them?`,
                        null
                    );

                    if (confirmation) {
                        choice = 'overwrite';
                    } else {
                        // Ask if user wants to rename instead of skip
                        const renameConfirmation = await Popup.show.confirm(
                            'Would you like to import with numbered suffixes (e.g. "prompt-2") instead?',
                            null
                        );

                        if (renameConfirmation) {
                            choice = 'rename';
                        }
                    }
                }

                if (!choice || choice === 'skip') {
                    // User chose to skip, so filter out existing prompts
                    for (const promptName of existingPrompts) {
                        delete importData.customPrompts[promptName];
                    }
                } else if (choice === 'rename') {
                    // User chose to rename, so add numbered suffix to conflicting prompts
                    const renamedPrompts = {};

                    for (const promptName in importData.customPrompts) {
                        if (extension_settings.objective.customPrompts[promptName]) {
                            // Find an available name with suffix
                            let newName = promptName;
                            let suffix = 2;

                            while (extension_settings.objective.customPrompts[newName] || renamedPrompts[newName]) {
                                newName = `${promptName}-${suffix}`;
                                suffix++;
                            }

                            // Add with new name
                            renamedPrompts[newName] = importData.customPrompts[promptName];
                        } else {
                            // No conflict, keep original name
                            renamedPrompts[promptName] = importData.customPrompts[promptName];
                        }
                    }

                    // Replace with renamed prompts
                    importData.customPrompts = renamedPrompts;
                }
                // If choice was 'overwrite', we keep the original names and overwrite
            }

            // Merge imported prompts with existing ones
            Object.assign(extension_settings.objective.customPrompts, importData.customPrompts);
            saveSettingsDebounced();

            // Refresh the prompt select dropdown
            populateCustomPrompts();

            // Show success message
            const importedCount = Object.keys(importData.customPrompts).length;
            toastr.success(`Imported ${importedCount} prompts successfully`);

        } catch (error) {
            console.error('Prompt import error:', error);
            toastr.error('Failed to import prompts: ' + error.message);
        }
    };

    // Trigger file selection
    fileInput.click();
}

function loadCustomPrompt() {
    const optionSelected = String($('#objective-custom-prompt-select').find(':selected').val());
    Object.assign(objectivePrompts, extension_settings.objective.customPrompts[optionSelected]);
    selectedCustomPrompt = optionSelected;

    $('#objective-prompt-generate').val(objectivePrompts.createTask).trigger('input');
    $('#objective-prompt-additional').val(objectivePrompts.additionalTasks || defaultPrompts.additionalTasks).trigger('input');
    $('#objective-prompt-check').val(objectivePrompts.checkTaskCompleted);
    $('#objective-prompt-extension-prompt').val(objectivePrompts.currentTask);
    $('#objective-prompt-completed-tasks').val(objectivePrompts.completedTasks || defaultPrompts.completedTasks);
    $('#objective-prompt-upcoming-tasks').val(objectivePrompts.upcomingTasks || defaultPrompts.upcomingTasks);

    saveState();
    setCurrentTask();
}

/**
 * Populate the custom prompt select dropdown with saved prompts.
 * @param {string} selected Optional selected prompt
 */
function populateCustomPrompts(selected) {
    if (!selected) {
        selected = selectedCustomPrompt || 'default';
    }

    // Populate saved prompts
    $('#objective-custom-prompt-select').empty();
    for (const customPromptName in extension_settings.objective.customPrompts) {
        const option = document.createElement('option');
        option.innerText = customPromptName;
        option.value = customPromptName;
        option.selected = customPromptName === selected;
        $('#objective-custom-prompt-select').append(option);
    }
}

//###############################//
//#       UI AND Settings       #//
//###############################//


const defaultSettings = {
    currentObjectiveId: null,
    taskTree: null,
    chatDepth: 2,
    checkFrequency: 3,
    hideTasks: false,
    swipesDecrement: false,
    injectionFrequency: 1,
    promptRole: extension_prompt_roles.SYSTEM, // Default role for task injection
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
        lastCompletionDate: null
    }
};

// Convenient single call. Not much at the moment.
function resetState() {
    lastMessageWasSwipe = false;
    recentlyCompletedTasks = [];
    upcomingTasks = [];
    updateCompletedTasksCount();
    updateUpcomingTasksCount();
    loadSettings();
}

//
function saveState() {
    const context = getContext();

    if (currentChatId == '') {
        currentChatId = context.chatId;
    }

    chat_metadata['objective'] = {
        currentObjectiveId: currentObjective.id,
        taskTree: taskTree.toSaveStateRecurse(),
        checkFrequency: $('#objective-check-frequency').val(),
        chatDepth: $('#objective-chat-depth').val(),
        hideTasks: $('#objective-hide-tasks').prop('checked'),
        swipesDecrement: $('#objective-swipes-decrement').prop('checked'),
        injectionFrequency: $('#objective-injection-frequency').val(),
        showCompletedTasks: $('#objective-show-completed').prop('checked'),
        completedTasksCount: $('#objective-completed-count').val(),
        recentlyCompletedTasks: recentlyCompletedTasks,
        showUpcomingTasks: $('#objective-show-upcoming').prop('checked'),
        upcomingTasksCount: $('#objective-upcoming-count').val(),
        upcomingTasks: upcomingTasks,
        prompts: objectivePrompts,
        selectedCustomPrompt: selectedCustomPrompt,
        completionHistory: chat_metadata.objective.completionHistory,
        statistics: chat_metadata.objective.statistics
    };

    saveMetadataDebounced();
}

// Dump core state
function debugObjectiveExtension() {
    console.log(JSON.stringify({
        'currentTask': currentTask,
        'currentObjective': currentObjective,
        'taskTree': taskTree.toSaveStateRecurse(),
        'chat_metadata': chat_metadata['objective'],
        'extension_settings': extension_settings['objective'],
        'prompts': objectivePrompts,
    }, null, 2));
}

globalThis.debugObjectiveExtension = debugObjectiveExtension;


// Populate UI task list
function updateUiTaskList() {
    // Clear existing task list
    $('#objective-tasks').empty();

    // Remove existing filter/sort controls to prevent duplication
    $('#objective-filter-sort').remove();

    // Show button to navigate back to parent objective if parent exists
    if (currentObjective) {
        if (currentObjective.parentId !== '') {
            $('#objective-parent').show();
        } else {
            $('#objective-parent').hide();
        }
    } else {
        // If no current objective, hide the parent button
        $('#objective-parent').hide();
    }

    // Show the objective text in the text area
    $('#objective-text').val(currentObjective ? currentObjective.description : '');

    // Show/hide Generate More Tasks button based on whether there are existing tasks
    if (currentObjective && currentObjective.children.length > 0) {
        $('#objective-generate-more').show();
    } else {
        $('#objective-generate-more').hide();
    }

    if (currentObjective && currentObjective.children.length > 0) {
        // Add tasks to UI
        for (const task of currentObjective.children) {
            task.addUiElement();
        }

        // Find the first incomplete task in the current objective's children
        const firstIncompleteTask = currentObjective.children.find(task => !task.completed);
        if (firstIncompleteTask) {
            setCurrentTask(firstIncompleteTask.id, true);
        } else if (currentObjective.children.length > 0) {
            // If all tasks are completed, highlight the first task
            setCurrentTask(currentObjective.children[0].id, true);
        }
    } else {
        // Show button to add tasks if there are none
        $('#objective-tasks').append(`
        <input id="objective-task-add-first" type="button" class="menu_button" value="Add Task">
        `);
        $('#objective-task-add-first').on('click', () => {
            const newTask = currentObjective.addTask('');
            updateUiTaskList();
            setCurrentTask(newTask.id);
        });
    }

    // Make the task list sortable
    initSortable();

    // Update the progress bar
    updateProgressBar();
}

// Initialize sortable functionality for task items
function initSortable() {
    // Check if jQuery UI sortable is available
    if ($.fn.sortable) {
        $('#objective-tasks').sortable({
            items: '> .objective-task-item',
            handle: '[id^=objective-task-drag-]',
            placeholder: 'ui-sortable-placeholder',
            opacity: 0.7,
            cursor: 'grabbing',
            tolerance: 'pointer',
            update: function (event, ui) {
                // Get the new order of task elements
                const items = $(this).sortable('toArray', { attribute: 'id' });

                // Extract the task IDs from the element IDs
                const taskIds = items.map(id => parseInt(id.replace('objective-task-item-', '')));

                // Rearrange the children array based on the new order
                const newChildren = [];
                for (const taskId of taskIds) {
                    const task = currentObjective.children.find(t => t.id === taskId);
                    if (task) {
                        newChildren.push(task);
                    }
                }

                // Replace the children array with the new ordered array
                currentObjective.children = newChildren;

                // Update upcoming tasks list and other UI elements
                updateUpcomingTasks();
                updateCompletedTasksCount();

                // Remove all highlights first
                $('.objective-task').removeClass('objective-task-highlight');
                $('.objective-task').css({ 'border-color': '', 'border-width': '' });

                // After reordering, always select the first incomplete task based on the new order
                const firstIncompleteTask = currentObjective.children.find(task => !task.completed);
                if (firstIncompleteTask) {
                    // Use setCurrentTask to properly update the current task and apply highlighting
                    setCurrentTask(firstIncompleteTask.id);
                } else if (currentObjective.children.length > 0) {
                    // If all tasks are completed, select the first task
                    setCurrentTask(currentObjective.children[0].id);
                }

                // Save the new state
                saveState();
            }
        }).disableSelection();
    } else {
        console.warn("jQuery UI sortable not available. Drag-and-drop task reordering is disabled.");
        // Add a small notice at the top of the task list
        if (currentObjective && currentObjective.children.length > 0) {
            $('#objective-tasks').prepend('<div class="sortable-notice" style="font-size: 0.8em; opacity: 0.7; margin-bottom: 10px;">Note: Drag-and-drop ordering requires jQuery UI.</div>');
        }
    }
}

// Calculate and update the progress bar
function updateProgressBar() {
    if (!currentObjective || currentObjective.children.length === 0) {
        // No tasks to show progress for
        $('#objective-progress-container').hide();
        return;
    }

    // Count completed tasks
    let completedCount = 0;
    let totalCount = currentObjective.children.length;

    for (const task of currentObjective.children) {
        if (task.completed) {
            completedCount++;
        }
    }

    const progressPercent = Math.round((completedCount / totalCount) * 100);

    // Create or update progress bar
    if ($('#objective-progress-container').length === 0) {
        // Create new progress bar if it doesn't exist
        $('#objective-tasks').before(`
            <div id="objective-progress-container" class="flex-container flexColumn marginTop10 marginBottom20">
                <div class="flex-container flexRow alignItemsCenter">
                    <div class="flex1">Progress: ${completedCount}/${totalCount} tasks (${progressPercent}%)</div>
                </div>
                <div class="progress-bar-container">
                    <div id="objective-progress-bar" class="progress-bar" style="width: ${progressPercent}%"></div>
                </div>
            </div>
        `);
    } else {
        // Update existing progress bar
        $('#objective-progress-container').show();
        $('#objective-progress-container .flex1').text(`Progress: ${completedCount}/${totalCount} tasks (${progressPercent}%)`);
        $('#objective-progress-bar').css('width', `${progressPercent}%`);
    }
}

function onParentClick() {
    currentObjective = getTaskById(currentObjective.parentId);
    updateUiTaskList();
    setCurrentTask();
}

// Trigger creation of new tasks with given objective.
async function onGenerateObjectiveClick() {
    await generateTasks();
    saveState();
}

// Trigger creation of additional tasks for the current objective
async function onGenerateAdditionalTasksClick() {
    await generateAdditionalTasks();
    saveState();
}

// Update extension prompts
function onChatDepthInput() {
    saveState();
    setCurrentTask(); // Ensure extension prompt is updated
}

function onObjectiveTextFocusOut() {
    if (currentObjective) {
        currentObjective.description = $('#objective-text').val();
        saveState();
    }
}

// Update how often we check for task completion
function onCheckFrequencyInput() {
    checkCounter = Number($('#objective-check-frequency').val());
    $('#objective-counter').text(checkCounter);
    saveState();
}

function onSwipesDecrementInput() {
    saveState();
}

function onHideTasksInput() {
    $('#objective-tasks').prop('hidden', $('#objective-hide-tasks').prop('checked'));
    saveState();
}

function onClearTasksClick() {
    if (currentObjective) {
        currentObjective.children = [];
        // Clear recently completed tasks as well
        recentlyCompletedTasks = [];

        // Update the UI with the new count
        updateCompletedTasksCount();

        updateUiTaskList();
        setCurrentTask();
        saveState();
        toastr.success('All tasks cleared');
    }
}

function loadTaskChildrenRecurse(savedTask) {
    let tempTaskTree = new ObjectiveTask({
        id: savedTask.id,
        description: savedTask.description,
        completed: savedTask.completed,
        parentId: savedTask.parentId,
        completionDate: savedTask.completionDate || null,
        duration: savedTask.duration || 0, // Load the duration property, default to 0 if not present
        elapsedMessages: savedTask.elapsedMessages || 0, // Load the elapsed messages counter
    });
    for (const task of savedTask.children) {
        const childTask = loadTaskChildrenRecurse(task);
        tempTaskTree.children.push(childTask);
    }
    return tempTaskTree;
}

function loadSettings() {
    // Load/Init settings for chatId
    currentChatId = getContext().chatId;

    // Reset Objectives and Tasks in memory
    taskTree = null;
    currentObjective = null;

    // Clear the objective text field when switching chats
    $('#objective-text').val('');

    // Init extension settings
    if (Object.keys(extension_settings.objective).length === 0) {
        Object.assign(extension_settings.objective, {
            'customPrompts': { 'default': defaultPrompts },
            'globalStatistics': {
                tasksCompleted: 0,
                tasksCreated: 0,
                objectivesCompleted: 0,
                lastCompletionDate: null
            }
        });
    }

    // Generate a temporary chatId if none exists
    if (currentChatId == undefined) {
        currentChatId = 'no-chat-id';
    }

    // Migrate existing settings
    if (currentChatId in extension_settings.objective) {
        // TODO: Remove this soon
        chat_metadata['objective'] = extension_settings.objective[currentChatId];
        delete extension_settings.objective[currentChatId];
    }

    if (!('objective' in chat_metadata)) {
        Object.assign(chat_metadata, { objective: defaultSettings });
    }

    // Migrate legacy flat objective to new objectiveTree and currentObjective
    if ('objective' in chat_metadata.objective) {

        // Create root objective from legacy objective
        taskTree = new ObjectiveTask({ id: 0, description: chat_metadata.objective.objective });
        currentObjective = taskTree;

        // Populate root objective tree from legacy tasks
        if ('tasks' in chat_metadata.objective) {
            let idIncrement = 0;
            taskTree.children = chat_metadata.objective.tasks.map(task => {
                idIncrement += 1;
                return new ObjectiveTask({
                    id: idIncrement,
                    description: task.description,
                    completed: task.completed,
                    parentId: taskTree.id,
                });
            });
        }
        saveState();
        delete chat_metadata.objective.objective;
        delete chat_metadata.objective.tasks;
    } else {
        // Load Objectives and Tasks (Normal path)
        if (chat_metadata.objective.taskTree) {
            taskTree = loadTaskChildrenRecurse(chat_metadata.objective.taskTree);
        }
    }

    // Make sure there's a root task
    if (!taskTree) {
        taskTree = new ObjectiveTask({ id: 0, description: '' });
    }

    // Set current objective
    if (chat_metadata.objective.currentObjectiveId !== null) {
        try {
            currentObjective = getTaskById(chat_metadata.objective.currentObjectiveId);
        } catch (e) {
            console.warn(`Failed to set current objective with ID ${chat_metadata.objective.currentObjectiveId}: ${e}`);
            currentObjective = taskTree;
        }
    } else {
        currentObjective = taskTree;
    }

    checkCounter = chat_metadata['objective'].checkFrequency;
    objectivePrompts = chat_metadata['objective'].prompts;

    // Load recently completed tasks
    recentlyCompletedTasks = chat_metadata.objective.recentlyCompletedTasks || [];

    // Load upcoming tasks
    upcomingTasks = chat_metadata.objective.upcomingTasks || [];

    // Ensure all prompt types exist
    if (!objectivePrompts.additionalTasks) {
        objectivePrompts.additionalTasks = defaultPrompts.additionalTasks;
    }

    if (!objectivePrompts.completedTasks) {
        objectivePrompts.completedTasks = defaultPrompts.completedTasks;
    }

    if (!objectivePrompts.upcomingTasks) {
        objectivePrompts.upcomingTasks = defaultPrompts.upcomingTasks;
    }

    selectedCustomPrompt = chat_metadata['objective'].selectedCustomPrompt || 'default';

    // Update UI elements
    $('#objective-counter').text(checkCounter);
    $('#objective-text').text(taskTree.description);

    // Ensure parent button is hidden when at root objective
    if (!currentObjective || !currentObjective.parentId || currentObjective.parentId === '') {
        $('#objective-parent').hide();
    }

    updateUiTaskList();
    $('#objective-chat-depth').val(chat_metadata['objective'].chatDepth);
    $('#objective-check-frequency').val(chat_metadata['objective'].checkFrequency);
    $('#objective-hide-tasks').prop('checked', chat_metadata['objective'].hideTasks);
    $('#objective-tasks').prop('hidden', $('#objective-hide-tasks').prop('checked'));

    // Set recently completed tasks UI elements
    $('#objective-show-completed').prop('checked', chat_metadata.objective.showCompletedTasks || false);
    $('#objective-completed-count').val(chat_metadata.objective.completedTasksCount || 3);

    // Set upcoming tasks UI elements
    $('#objective-show-upcoming').prop('checked', chat_metadata.objective.showUpcomingTasks || false);
    $('#objective-upcoming-count').val(chat_metadata.objective.upcomingTasksCount || 3);

    // Update the UI with the count of recently completed tasks
    updateCompletedTasksCount();

    // Update the UI with the count of upcoming tasks
    updateUpcomingTasksCount();

    setCurrentTask(null, true);

    // Set swipes decrement checkbox
    $('#objective-swipes-decrement').prop('checked', chat_metadata.objective.swipesDecrement || false);

    // Set injection frequency input
    $('#objective-injection-frequency').val(chat_metadata.objective.injectionFrequency || 1);

    // Reset injection counter
    injectionCounter = 0;

    // Set UI controls from the loaded settings
    $('#objective-chat-depth').val(chat_metadata.objective.chatDepth);
    $('#objective-check-frequency').val(chat_metadata.objective.checkFrequency);
    $('#objective-hide-tasks').prop('checked', chat_metadata.objective.hideTasks);
    $('#objective-injection-frequency').val(chat_metadata.objective.injectionFrequency);
    $('#objective-swipes-decrement').prop('checked', chat_metadata.objective.swipesDecrement);

    // Set the task show/hide state from settings
    if (chat_metadata.objective.hideTasks) {
        $('#objective-tasks').hide();
    } else {
        $('#objective-tasks').show();
    }

    // Set completed tasks settings
    $('#objective-show-completed').prop('checked', chat_metadata.objective.showCompletedTasks);
    $('#objective-completed-count').val(chat_metadata.objective.completedTasksCount);

    // Set upcoming tasks settings
    $('#objective-show-upcoming').prop('checked', chat_metadata.objective.showUpcomingTasks);
    $('#objective-upcoming-count').val(chat_metadata.objective.upcomingTasksCount);

    // Update the UI
    updateUiTaskList();
    updateCompletedTasksCount();
    updateUpcomingTasksCount();
}

function addManualTaskCheckUi() {
    const getWandContainer = () => $(document.getElementById('objective_wand_container') ?? document.getElementById('extensionsMenu'));
    const container = getWandContainer();
    container.append(`
        <div id="objective-task-manual-check-menu-item" class="list-group-item flex-container flexGap5">
            <div id="objective-task-manual-check" class="extensionsMenuExtensionButton fa-regular fa-square-check"/></div>
            Manual Task Check
        </div>`);
    container.append(`
        <div id="objective-task-complete-current-menu-item" class="list-group-item flex-container flexGap5">
            <div id="objective-task-complete-current" class="extensionsMenuExtensionButton fa-regular fa-list-check"/></div>
            Complete Current Task
        </div>`);
    $('#objective-task-manual-check-menu-item').attr('title', 'Trigger AI check of completed tasks').on('click', checkTaskCompleted);
    $('#objective-task-complete-current-menu-item').attr('title', 'Mark the current task as completed.').on('click', markTaskCompleted);
}

// Helper Interval for use with an AbortController for cancellable intervals;
function watchdog(ms, signal, task) {
    const intervalID = setInterval(task, ms);
    signal.addEventListener('abort', () => {
        clearInterval(intervalID);
    });
}

function doPopout(e) {
    const target = e.target;

    //repurposes the zoomed avatar template to server as a floating div
    if ($('#objectiveExtensionPopout').length === 0) {
        console.debug('did not see popout yet, creating');
        const originalHTMLClone = $(target).parent().parent().parent().find('.inline-drawer-content').html();
        const originalElement = $(target).parent().parent().parent().find('.inline-drawer-content');
        const template = $('#zoomed_avatar_template').html();
        const controlBarHtml = `<div class="panelControlBar flex-container">
        <div id="objectiveExtensionPopoutheader" class="fa-solid fa-grip drag-grabber hoverglow"></div>
        <div id="objectiveExtensionPopoutClose" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
        </div>`;
        const newElement = $(template);
        newElement
            .attr('id', 'objectiveExtensionPopout')
            .removeClass('zoomed_avatar')
            .addClass('draggable')
            .empty();
        originalElement.html('<div class="flex-container alignitemscenter justifyCenter wide100p"><small>Currently popped out</small></div>');
        newElement.append(controlBarHtml).append(originalHTMLClone);
        $('#movingDivs').append(newElement);
        $('#objectiveExtensionDrawerContents').addClass('scrollY');
        loadSettings();
        loadMovingUIState();

        $('#objectiveExtensionPopout').css('display', 'flex').fadeIn(animation_duration);
        dragElement(newElement);

        var objectivePopoutHTML = $('#objectiveExtensionDrawerContents');
        const controller = new AbortController();

        //setup listener for close button to restore extensions menu
        $('#objectiveExtensionPopoutClose').off('click').on('click', function () {
            $('#objectiveExtensionDrawerContents').removeClass('scrollY');
            objectivePopoutHTML = $('#objectiveExtensionDrawerContents');
            $('#objectiveExtensionPopout').fadeOut(animation_duration, () => {
                originalElement.empty();
                originalElement.append(objectivePopoutHTML);
                $('#objectiveExtensionPopout').remove();
                controller.abort();
            });
            loadSettings();
        });

        watchdog(5000, controller.signal, () => {
            console.log("watchdog");
            if ($('#objectiveExtensionDrawerContents').length === 0) {
                console.debug("detected broken popup, restoring");
                originalElement.empty();
                originalElement.append(objectivePopoutHTML);
                loadSettings();
                controller.abort();
                $('#objectiveExtensionPopout').remove();
            }
        });

    } else {
        console.debug('saw existing popout, removing');
        $('#objectiveExtensionPopout').fadeOut(animation_duration, () => { $('#objectiveExtensionPopoutClose').trigger('click'); });
    }
}

/*
function doPopout(e) {
    const target = e.target;

    //repurposes the zoomed avatar template to server as a floating div
    if ($('#objectiveExtensionPopout').length === 0 && $('#objectiveExtensionDrawerContents').length !== 0) {
        console.debug('did not see popout yet, creating');
        const originalHTMLClone = $(target).parent().parent().parent().find('.inline-drawer-content').html();
        const originalElement = $(target).parent().parent().parent().find('.inline-drawer-content');
        const template = $('#zoomed_avatar_template').html();
        const controlBarHtml = `<div class="panelControlBar flex-container">
        <div id="objectiveExtensionPopoutheader" class="fa-solid fa-grip drag-grabber hoverglow"></div>
        <div id="objectiveExtensionPopoutClose" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
    </div>`;
        const newElement = $(template);
        newElement.attr('id', 'objectiveExtensionPopout')
            .removeClass('zoomed_avatar')
            .addClass('draggable')
            .empty();
        originalElement.html('<div class="flex-container alignitemscenter justifyCenter wide100p"><small>Currently popped out</small></div>');
        newElement.append(controlBarHtml).append(originalHTMLClone);
        $('#movingDivs').append(newElement);
        $('#objectiveExtensionDrawerContents').addClass('scrollY');
        loadSettings();
        loadMovingUIState();

        $('#objectiveExtensionPopout').css('display', 'flex').fadeIn(animation_duration);
        dragElement(newElement);

        const objectivePopoutHTML = $('#objectiveExtensionDrawerContents');
        const controller = new AbortController();

        //setup listener for close button to restore extensions menu
        $('#objectiveExtensionPopoutClose').off('click').on('click', function () {
            $('#objectiveExtensionDrawerContents').removeClass('scrollY');
            objectivePopoutHTML = $('#objectiveExtensionDrawerContents');
            $('#objectiveExtensionPopout').fadeOut(animation_duration, () => {
                originalElement.empty();
                originalElement.append(objectivePopoutHTML);
                $('#objectiveExtensionPopout').remove();
                controller.abort();
            });
            loadSettings();
        });

        watchdog(5000, controller.signal).then(() => {
            if ($('#objectiveExtensionDrawerContents').length === 0) {
                originalElement.html = objectivePopoutHTML;
                controller.abort();
                loadSettings();
            }
        });

    } else {
        console.debug('saw existing popout, removing');
        $('#objectiveExtensionPopout').fadeOut(animation_duration, () => { $('#objectiveExtensionPopoutClose').trigger('click'); });
    }
}
*/

// Add template management UI
function onManageTemplatesClick() {
    let popupText = '';
    popupText += `
    <div class="objective_templates_modal">
        <div class="objective_prompt_block justifyCenter">
            <label for="objective-template-select">Task Templates</label>
            <select id="objective-template-select" class="text_pole"><select>
        </div>
        <div class="objective_prompt_block justifyCenter">
            <input id="objective-template-save" class="menu_button" type="submit" value="Save Current Tasks as Template" />
            <input id="objective-template-load" class="menu_button" type="submit" value="Load Template" />
            <input id="objective-template-delete" class="menu_button" type="submit" value="Delete Template" />
        </div>
        <div class="objective_prompt_block justifyCenter">
            <input id="objective-template-export" class="menu_button" type="submit" value="Export Selected Template" />
            <input id="objective-template-import" class="menu_button" type="submit" value="Import Templates" />
        </div>
        <hr class="m-t-1 m-b-1">
        <small>Save your current task structure as a template to reuse later. Templates include all tasks and subtasks but not their completion status.</small>
        <hr class="m-t-1 m-b-1">
        <div id="objective-template-preview" class="objective_template_preview">
            <p>Select a template to preview</p>
        </div>
    </div>`;

    callGenericPopup(popupText, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true, wide: true });
    populateTemplateSelect();

    // Handle save
    $('#objective-template-save').on('click', saveTaskTemplate);

    // Handle load
    $('#objective-template-load').on('click', loadTaskTemplate);

    // Handle delete
    $('#objective-template-delete').on('click', deleteTaskTemplate);

    // Handle export
    $('#objective-template-export').on('click', exportTaskTemplates);

    // Handle import
    $('#objective-template-import').on('click', importTaskTemplates);

    // Handle preview on select change
    $('#objective-template-select').on('change', previewTaskTemplate);
}

// Save current tasks as a template
async function saveTaskTemplate() {
    if (!currentObjective || currentObjective.children.length === 0) {
        toastr.warning('No tasks to save as template');
        return;
    }

    const templateName = await Popup.show.input('Template name', null);

    if (!templateName) {
        toastr.warning('Please provide a template name');
        return;
    }

    // Initialize templates object if it doesn't exist
    if (!extension_settings.objective.templates) {
        extension_settings.objective.templates = {};
    }

    // Save template without completion status
    const templateTasks = JSON.parse(JSON.stringify(currentObjective.children));
    clearCompletionStatusRecursive(templateTasks);

    extension_settings.objective.templates[templateName] = {
        description: currentObjective.description,
        tasks: templateTasks
    };

    saveSettingsDebounced();
    populateTemplateSelect(templateName);
    // Update the preview to show the newly created template
    previewTaskTemplate();
    toastr.success(`Template "${templateName}" saved`);
}

// Clear completion status from all tasks recursively
function clearCompletionStatusRecursive(tasks) {
    for (const task of tasks) {
        task.completed = false;
        if (task.children && task.children.length > 0) {
            clearCompletionStatusRecursive(task.children);
        }
    }
}

// Load selected template
async function loadTaskTemplate() {
    const templateName = $('#objective-template-select').val();

    if (!templateName) {
        toastr.warning('Please select a template');
        return;
    }

    // Confirm if current tasks exist
    if (currentObjective.children.length > 0) {
        const confirmation = await Popup.show.confirm(
            'This will replace your current tasks. Continue?',
            null
        );

        if (!confirmation) {
            return;
        }
    }

    const template = extension_settings.objective.templates[templateName];

    if (!template) {
        toastr.error('Template not found');
        return;
    }

    // Update objective description if it exists in template
    if (template.description) {
        currentObjective.description = template.description;
    }

    // Clear current tasks and load from template
    currentObjective.children = [];

    // Deep clone the template tasks to avoid reference issues
    const templateTasks = JSON.parse(JSON.stringify(template.tasks));

    // Rebuild task objects with proper parentId references
    for (const taskData of templateTasks) {
        const task = new ObjectiveTask({
            description: taskData.description,
            parentId: currentObjective.id
        });

        if (taskData.children && taskData.children.length > 0) {
            loadChildTasksRecursive(task, taskData.children);
        }

        currentObjective.children.push(task);
    }

    updateUiTaskList();
    setCurrentTask();
    saveState();

    toastr.success(`Template "${templateName}" loaded`);
    $('#objective-template-select').closest('.popup_wrapper').find('.popup_cross').click();
}

// Recursively load child tasks
function loadChildTasksRecursive(parentTask, childrenData) {
    for (const childData of childrenData) {
        const childTask = new ObjectiveTask({
            description: childData.description,
            parentId: parentTask.id
        });

        if (childData.children && childData.children.length > 0) {
            loadChildTasksRecursive(childTask, childData.children);
        }

        parentTask.children.push(childTask);
    }
}

// Delete selected template
async function deleteTaskTemplate() {
    const templateName = $('#objective-template-select').val();

    if (!templateName) {
        toastr.warning('Please select a template');
        return;
    }

    const confirmation = await Popup.show.confirm(
        `Are you sure you want to delete template "${templateName}"?`,
        null
    );

    if (!confirmation) {
        return;
    }

    delete extension_settings.objective.templates[templateName];
    saveSettingsDebounced();
    populateTemplateSelect();
    $('#objective-template-preview').html('<p>Select a template to preview</p>');
    toastr.success(`Template "${templateName}" deleted`);
}

// Preview selected template
function previewTaskTemplate() {
    const templateName = $('#objective-template-select').val();

    if (!templateName) {
        $('#objective-template-preview').html('<p>Select a template to preview</p>');
        return;
    }

    const template = extension_settings.objective.templates[templateName];

    if (!template) {
        $('#objective-template-preview').html('<p>Template not found</p>');
        return;
    }

    let previewHtml = `<h4>${template.description || 'No description'}</h4><ul>`;

    for (const task of template.tasks) {
        previewHtml += `<li>${task.description}`;
        if (task.children && task.children.length > 0) {
            previewHtml += renderTaskChildrenPreview(task.children);
        }
        previewHtml += '</li>';
    }

    previewHtml += '</ul>';
    $('#objective-template-preview').html(previewHtml);
}

// Render child tasks for preview
function renderTaskChildrenPreview(children) {
    let html = '<ul>';

    for (const child of children) {
        html += `<li>${child.description}`;
        if (child.children && child.children.length > 0) {
            html += renderTaskChildrenPreview(child.children);
        }
        html += '</li>';
    }

    html += '</ul>';
    return html;
}

// Populate template select dropdown
function populateTemplateSelect(selected) {
    $('#objective-template-select').empty();

    // Add empty option
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.innerText = '-- Select Template --';
    $('#objective-template-select').append(emptyOption);

    // Add templates
    if (extension_settings.objective.templates) {
        for (const templateName in extension_settings.objective.templates) {
            const option = document.createElement('option');
            option.value = templateName;
            option.innerText = templateName;
            option.selected = templateName === selected;
            $('#objective-template-select').append(option);
        }
    }
}

// Add task to completion history
function addToCompletionHistory(task) {
    if (!chat_metadata.objective.completionHistory) {
        chat_metadata.objective.completionHistory = [];
    }

    // Add to history with timestamp
    chat_metadata.objective.completionHistory.push({
        id: task.id,
        description: task.description,
        completionDate: task.completionDate,
        objectiveDescription: currentObjective.description
    });

    // Limit history size to prevent metadata from growing too large
    if (chat_metadata.objective.completionHistory.length > 100) {
        chat_metadata.objective.completionHistory =
            chat_metadata.objective.completionHistory.slice(-100);
    }

    saveMetadataDebounced();
}

// Update task statistics
function updateStatistics(taskCompleted = false) {
    // Initialize chat-specific statistics if they don't exist
    if (!chat_metadata.objective.statistics) {
        chat_metadata.objective.statistics = {
            tasksCompleted: 0,
            tasksCreated: 0,
            objectivesCompleted: 0,
            lastCompletionDate: null
        };
    }

    // Initialize global statistics if they don't exist
    if (!extension_settings.objective.globalStatistics) {
        extension_settings.objective.globalStatistics = {
            tasksCompleted: 0,
            tasksCreated: 0,
            objectivesCompleted: 0,
            lastCompletionDate: null
        };
    }

    // Update relevant statistics
    if (taskCompleted) {
        // Update chat-specific statistics
        chat_metadata.objective.statistics.tasksCompleted++;
        chat_metadata.objective.statistics.lastCompletionDate = new Date().toISOString();

        // Update global statistics
        extension_settings.objective.globalStatistics.tasksCompleted++;
        extension_settings.objective.globalStatistics.lastCompletionDate = new Date().toISOString();

        // Check if all tasks in the current objective are completed
        const allCompleted = currentObjective.children.every(task => task.completed);
        if (allCompleted && currentObjective.children.length > 0) {
            chat_metadata.objective.statistics.objectivesCompleted++;
            extension_settings.objective.globalStatistics.objectivesCompleted++;
        }

        // Save global statistics
        saveSettingsDebounced();
    }

    saveMetadataDebounced();
}

// Show task statistics
function showStatistics() {
    // Initialize chat-specific statistics if they don't exist
    if (!chat_metadata.objective.statistics) {
        chat_metadata.objective.statistics = {
            tasksCompleted: 0,
            tasksCreated: 0,
            objectivesCompleted: 0,
            lastCompletionDate: null
        };
    }

    // Initialize global statistics if they don't exist
    if (!extension_settings.objective.globalStatistics) {
        extension_settings.objective.globalStatistics = {
            tasksCompleted: 0,
            tasksCreated: 0,
            objectivesCompleted: 0,
            lastCompletionDate: null
        };
    }

    // Count total tasks in the current tree
    const totalTasks = countAllTasks(taskTree);

    // Count completed tasks in the current tree
    const completedTasks = countCompletedTasks(taskTree);

    // Calculate completion rate
    const completionRate = totalTasks > 0
        ? Math.round((completedTasks / totalTasks) * 100)
        : 0;

    // Format last completion date for chat-specific statistics
    let lastCompletionText = 'Never';
    if (chat_metadata.objective.statistics.lastCompletionDate) {
        const lastDate = new Date(chat_metadata.objective.statistics.lastCompletionDate);
        lastCompletionText = lastDate.toLocaleString();
    }

    // Format last completion date for global statistics
    let globalLastCompletionText = 'Never';
    if (extension_settings.objective.globalStatistics.lastCompletionDate) {
        const globalLastDate = new Date(extension_settings.objective.globalStatistics.lastCompletionDate);
        globalLastCompletionText = globalLastDate.toLocaleString();
    }

    // Create statistics popup
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
                    <div class="stats-value">${lastCompletionText}</div>
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
                    <div class="stats-value">${globalLastCompletionText}</div>
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

// Generate HTML for completion history
function generateCompletionHistoryHtml() {
    if (!chat_metadata.objective.completionHistory ||
        chat_metadata.objective.completionHistory.length === 0) {
        return '<p>No completed tasks yet</p>';
    }

    // Get last 10 completed tasks, most recent first
    const recentCompletions = [...chat_metadata.objective.completionHistory]
        .reverse()
        .slice(0, 10);

    let html = '<ul class="objective_history_list">';

    for (const completion of recentCompletions) {
        const date = new Date(completion.completionDate);
        const formattedDate = date.toLocaleString();

        html += `
        <li class="objective_history_item">
            <div class="objective_history_task">${completion.description}</div>
            <div class="objective_history_objective">Objective: ${completion.objectiveDescription}</div>
            <div class="objective_history_date">${formattedDate}</div>
        </li>`;
    }

    html += '</ul>';
    return html;
}

// Count all tasks in a task tree
function countAllTasks(task) {
    let count = 0;

    // Don't count the root task
    if (task.parentId !== '') {
        count = 1;
    }

    // Count all children
    for (const child of task.children) {
        count += countAllTasks(child);
    }

    return count;
}

// Count completed tasks in a task tree
function countCompletedTasks(task) {
    let count = 0;

    // Don't count the root task
    if (task.parentId !== '' && task.completed) {
        count = 1;
    }

    // Count all completed children
    for (const child of task.children) {
        count += countCompletedTasks(child);
    }

    return count;
}

// Export tasks to JSON file
async function exportTasks() {
    if (!currentObjective || currentObjective.children.length === 0) {
        toastr.warning('No tasks to export');
        return;
    }

    // Prepare export data
    const exportData = {
        description: currentObjective.description,
        tasks: currentObjective.children.map(task => task.toSaveStateRecurse()),
        exportDate: new Date().toISOString(),
        version: '1.0'
    };

    // Convert to JSON string
    const jsonString = JSON.stringify(exportData, null, 2);

    // Create default filename based on objective description
    let defaultFilename = 'objective-tasks.json';
    if (currentObjective.description) {
        // Create a safe filename from the objective description
        defaultFilename = currentObjective.description
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '-')
            .replace(/-+/g, '-')
            .substring(0, 30) + '.json';
    }

    // Ask user for custom filename
    let filename = await Popup.show.input('Enter filename for export', defaultFilename);

    // If user cancels or provides empty filename, use the default
    if (!filename) {
        filename = defaultFilename;
    }

    // Ensure filename has .json extension
    if (!filename.toLowerCase().endsWith('.json')) {
        filename += '.json';
    }

    // Create and trigger download link
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    // Clean up
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);

    toastr.success(`Tasks exported as "${filename}"`);
}

// Import tasks from JSON file
async function importTasks() {
    // Create file input element
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';

    // Handle file selection
    fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            // Read file
            const text = await file.text();
            const importData = JSON.parse(text);

            // Validate import data
            if (!importData.tasks || !Array.isArray(importData.tasks)) {
                throw new Error('Invalid import file format');
            }

            // Confirm if current tasks exist
            if (currentObjective.children.length > 0) {
                const confirmation = await Popup.show.confirm(
                    'This will replace your current tasks. Continue?',
                    null
                );

                if (!confirmation) {
                    return;
                }
            }

            // Update objective description if it exists in import
            if (importData.description) {
                currentObjective.description = importData.description;
            }

            // Clear current tasks and load from import
            currentObjective.children = [];

            // Rebuild task objects with proper parentId references
            for (const taskData of importData.tasks) {
                const task = new ObjectiveTask({
                    description: taskData.description,
                    completed: taskData.completed || false,
                    parentId: currentObjective.id,
                });

                if (taskData.children && taskData.children.length > 0) {
                    loadChildTasksRecursive(task, taskData.children);
                }

                currentObjective.children.push(task);
            }

            updateUiTaskList();
            setCurrentTask();
            saveState();

            toastr.success('Tasks imported successfully');

        } catch (error) {
            console.error('Import error:', error);
            toastr.error('Failed to import tasks: ' + error.message);
        }
    };

    // Trigger file selection
    fileInput.click();
}

// Export task templates to a JSON file
function exportTaskTemplates() {
    const templateName = $('#objective-template-select').val();

    // Check if a template is selected
    if (!templateName) {
        toastr.warning('Please select a template to export');
        return;
    }

    // Check if the template exists
    if (!extension_settings.objective.templates || !extension_settings.objective.templates[templateName]) {
        toastr.error('Template not found');
        return;
    }

    // Prepare export data with only the selected template
    const exportData = {
        templates: {
            [templateName]: extension_settings.objective.templates[templateName]
        },
        exportDate: new Date().toISOString(),
        version: '1.0'
    };

    // Convert to JSON string
    const jsonString = JSON.stringify(exportData, null, 2);

    // Create download link
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    // Create filename based on template name
    const filename = `objective-template-${templateName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').substring(0, 30)}.json`;

    // Create and trigger download link
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    // Clean up
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);

    toastr.success(`Template "${templateName}" exported successfully`);
}

// Import task templates from a JSON file
async function importTaskTemplates() {
    // Create file input element
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';

    // Handle file selection
    fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            // Read file
            const text = await file.text();
            const importData = JSON.parse(text);

            // Validate import data
            if (!importData.templates || typeof importData.templates !== 'object') {
                throw new Error('Invalid template file format');
            }

            // Count templates to import
            const templateCount = Object.keys(importData.templates).length;
            if (templateCount === 0) {
                throw new Error('No templates found in the import file');
            }

            // Initialize templates object if it doesn't exist
            if (!extension_settings.objective.templates) {
                extension_settings.objective.templates = {};
            }

            // Check for existing templates with the same names
            const existingTemplates = [];
            for (const templateName in importData.templates) {
                if (extension_settings.objective.templates[templateName]) {
                    existingTemplates.push(templateName);
                }
            }

            // If there are existing templates, ask for conflict resolution choice
            if (existingTemplates.length > 0) {
                let choice = 'skip'; // Default to skip if no choice is made

                // Check if Popup.show.select is available
                if (typeof Popup.show.select === 'function') {
                    const options = [
                        { text: 'Overwrite existing templates', value: 'overwrite' },
                        { text: 'Import with numbered suffix (e.g. "template-2")', value: 'rename' },
                        { text: 'Skip conflicting templates', value: 'skip' }
                    ];

                    choice = await Popup.show.select(
                        `${existingTemplates.length} template(s) already exist with the same name. How would you like to handle this?`,
                        options
                    );
                } else {
                    // Fallback to confirm dialog if select is not available
                    const confirmation = await Popup.show.confirm(
                        `${existingTemplates.length} template(s) already exist with the same name. Would you like to overwrite them?`,
                        null
                    );

                    if (confirmation) {
                        choice = 'overwrite';
                    } else {
                        // Ask if user wants to rename instead of skip
                        const renameConfirmation = await Popup.show.confirm(
                            'Would you like to import with numbered suffixes (e.g. "template-2") instead?',
                            null
                        );

                        if (renameConfirmation) {
                            choice = 'rename';
                        }
                    }
                }

                if (!choice || choice === 'skip') {
                    // User chose to skip, so filter out existing templates
                    for (const templateName of existingTemplates) {
                        delete importData.templates[templateName];
                    }
                } else if (choice === 'rename') {
                    // User chose to rename, so add numbered suffix to conflicting templates
                    const renamedTemplates = {};

                    for (const templateName in importData.templates) {
                        if (extension_settings.objective.templates[templateName]) {
                            // Find an available name with suffix
                            let newName = templateName;
                            let suffix = 2;

                            while (extension_settings.objective.templates[newName] || renamedTemplates[newName]) {
                                newName = `${templateName}-${suffix}`;
                                suffix++;
                            }

                            // Add with new name
                            renamedTemplates[newName] = importData.templates[templateName];
                        } else {
                            // No conflict, keep original name
                            renamedTemplates[templateName] = importData.templates[templateName];
                        }
                    }

                    // Replace with renamed templates
                    importData.templates = renamedTemplates;
                }
                // If choice was 'overwrite', we keep the original names and overwrite
            }

            // Merge imported templates with existing ones
            Object.assign(extension_settings.objective.templates, importData.templates);
            saveSettingsDebounced();

            // Get the first imported template name to select
            const firstImportedTemplate = Object.keys(importData.templates)[0];

            // Refresh the template select dropdown and select the first imported template
            populateTemplateSelect(firstImportedTemplate);

            // Update the preview to show the first imported template
            previewTaskTemplate();

            // Show success message
            const importedCount = Object.keys(importData.templates).length;
            toastr.success(`Imported ${importedCount} templates successfully`);

        } catch (error) {
            console.error('Template import error:', error);
            toastr.error('Failed to import templates: ' + error.message);
        }
    };

    // Trigger file selection
    fileInput.click();
}

// Add task to recently completed tasks array
function addToRecentlyCompletedTasks(task) {
    // First, remove any existing entry for this task to avoid duplicates
    recentlyCompletedTasks = recentlyCompletedTasks.filter(t => t.id !== task.id);

    // Add to the beginning of the array (most recent first)
    recentlyCompletedTasks.unshift({
        id: task.id,
        description: task.description,
        completionDate: task.completionDate
    });

    // Limit the array size based on user settings
    const maxCompletedTasks = Number($('#objective-completed-count').val()) || 3;
    if (recentlyCompletedTasks.length > maxCompletedTasks) {
        recentlyCompletedTasks = recentlyCompletedTasks.slice(0, maxCompletedTasks);
    }

    // Update the UI with the new count
    updateCompletedTasksCount();

    // Update the extension prompt to include recently completed tasks
    setCurrentTask();
}

function onShowCompletedTasksInput() {
    setCurrentTask();
    saveState();
}

function onCompletedTasksCountInput() {
    // Update the recently completed tasks array based on the new count
    const maxCompletedTasks = Number($('#objective-completed-count').val()) || 3;
    if (recentlyCompletedTasks.length > maxCompletedTasks) {
        recentlyCompletedTasks = recentlyCompletedTasks.slice(0, maxCompletedTasks);

        // Update the UI with the new count
        updateCompletedTasksCount();
    }

    setCurrentTask();
    saveState();
}

async function onPurgeCompletedTasksClick() {
    // If there are no tasks to purge, just show a message
    if (recentlyCompletedTasks.length === 0) {
        toastr.info('No recently completed tasks to purge');
        return;
    }

    // Ask for confirmation before purging
    const confirmation = await Popup.show.confirm('Are you sure you want to purge all recently completed tasks?', null);

    if (!confirmation) {
        return;
    }

    // Clear the recently completed tasks array
    recentlyCompletedTasks = [];

    // Update the UI with the new count
    updateCompletedTasksCount();

    // Update the extension prompt
    setCurrentTask();
    saveState();

    toastr.success('Recently completed tasks have been purged');
}

// Show recently completed tasks in a popup
function showRecentlyCompletedTasks() {
    if (recentlyCompletedTasks.length === 0) {
        toastr.info('No recently completed tasks');
        return;
    }

    let popupText = `
    <div class="objective_statistics_modal">
        <h3 class="stats-header">Recently Completed Tasks</h3>
        
        <div class="stats-container">
            <div class="stats-section">
                <h4 class="stats-section-header">Task History</h4>
                <p>These tasks are included in the AI's context when "Include completed tasks in prompt" is enabled.</p>
                
                <div class="objective_completion_history">
                    <ul class="objective_history_list">`;

    for (const task of recentlyCompletedTasks) {
        const date = new Date(task.completionDate);
        const formattedDate = date.toLocaleString();
        popupText += `
                        <li class="objective_history_item">
                            <div class="objective_history_task">${task.description}</div>
                            <div class="objective_history_date">Completed: ${formattedDate}</div>
                        </li>`;
    }

    popupText += `
                    </ul>
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

    // Add event listener for the purge button in the popup
    $('#recently-completed-tasks-purge').on('click', () => {
        onPurgeCompletedTasksClick();
        // Close the popup
        $('.popup_cross').click();
    });
}

function onPromptRoleInput() {
    // Get the selected role from the dropdown
    const selectedRole = $('#objective-prompt-role').val();

    // Map the string value to the enum value from extension_prompt_roles
    let roleValue;
    switch (selectedRole) {
        case 'system':
            roleValue = extension_prompt_roles.SYSTEM;
            break;
        case 'user':
            roleValue = extension_prompt_roles.USER;
            break;
        case 'assistant':
        default:
            roleValue = extension_prompt_roles.ASSISTANT;
            break;
    }

    // Update the settings
    chat_metadata.objective.promptRole = roleValue;

    // Update the extension prompt with the new role
    setCurrentTask();
    saveState();
}

function onInjectionFrequencyInput() {
    // Reset the injection counter when the frequency is changed
    // Set to 0 to ensure the next message will have the task injected
    injectionCounter = 0;
    saveState();
}

// Add our jQuery initialization code
jQuery(async () => {
    const settingsHtml = await renderExtensionTemplateAsync('third-party/ST-SuperObjective', 'settings');

    // CSS styles are now defined in style.css

    addManualTaskCheckUi();
    const getContainer = () => $(document.getElementById('objective_container') ?? document.getElementById('extensions_settings'));
    getContainer().append(settingsHtml);

    $(document).on('click', '#objective-generate', onGenerateObjectiveClick);
    $(document).on('click', '#objective-generate-more', onGenerateAdditionalTasksClick);
    $(document).on('input', '#objective-chat-depth', onChatDepthInput);
    $(document).on('input', '#objective-check-frequency', onCheckFrequencyInput);
    $(document).on('click', '#objective-hide-tasks', onHideTasksInput);
    $(document).on('click', '#objective-clear', onClearTasksClick);
    $(document).on('click', '#objective_prompt_edit', onEditPromptClick);
    $(document).on('click', '#objective-parent', onParentClick);
    $(document).on('focusout', '#objective-text', onObjectiveTextFocusOut);
    $(document).on('click', '#objective-show-completed', onShowCompletedTasksInput);
    $(document).on('input', '#objective-completed-count', onCompletedTasksCountInput);
    $(document).on('click', '#objective-purge-completed', onPurgeCompletedTasksClick);
    $(document).on('click', '#objective-view-completed', showRecentlyCompletedTasks);
    $(document).on('click', '#objective-show-upcoming', onShowUpcomingTasksInput);
    $(document).on('input', '#objective-upcoming-count', onUpcomingTasksCountInput);
    $(document).on('click', '#objective-purge-upcoming', onPurgeUpcomingTasksClick);
    $(document).on('click', '#objective-view-upcoming', showUpcomingTasks);
    $(document).on('click', '#objectiveExtensionPopoutButton', function (e) {
        doPopout(e);
        e.stopPropagation();
    });

    // Ensure parent button is hidden on first load
    $('#objective-parent').hide();

    loadSettings();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        resetState();
        loadSettings();
        updateUiTaskList();
    });
    eventSource.on(event_types.MESSAGE_SWIPED, () => {
        lastMessageWasSwipe = true;
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        if (currentChatId == undefined || jQuery.isEmptyObject(currentTask)) {
            return;
        }

        // Store the current task ID before checking
        const taskId = currentTask.id ? currentTask.id : null;

        // Increment the elapsed messages counter for the current task
        incrementTaskElapsedMessages();

        // Get the injection frequency
        const injectionFrequency = Number($('#objective-injection-frequency').val()) || 1;

        // Track if we need to inject on this message
        const wasTimeToInject = injectionCounter === 0;

        // Increment the injection counter
        // Reset to 0 when we reach the frequency, which means it's time to inject again
        injectionCounter++;
        if (injectionCounter >= injectionFrequency) {
            injectionCounter = 0;
        }

        let checkForCompletion = false;
        const noCheckTypes = ['continue', 'quiet', 'impersonate'];
        const lastType = substituteParams('{{lastGenerationType}}');

        // Check if we should decrement counter based on swipe setting
        const swipesDecrement = $('#objective-swipes-decrement').prop('checked');
        const shouldDecrement = !lastMessageWasSwipe || (lastMessageWasSwipe && swipesDecrement);

        if (Number($('#objective-check-frequency').val()) > 0 && !noCheckTypes.includes(lastType) && shouldDecrement) {
            // Check only at specified interval. Don't let counter go negative
            if (--checkCounter <= 0) {
                checkCounter = Math.max(0, checkCounter);
                checkForCompletion = true;
            }
        }

        // Reset the swipe flag
        lastMessageWasSwipe = false;

        const checkTaskPromise = checkForCompletion ? checkTaskCompleted() : Promise.resolve();
        checkTaskPromise.finally(() => {
            // If it was time to inject when this function started (counter was 0), update the task
            // Or if task completion check was performed, update the task
            if ((wasTimeToInject || checkForCompletion) && taskId) {
                setCurrentTask(taskId);
            }
            $('#objective-counter').text(checkCounter);
        });
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'taskcheck',
        callback: checkTaskCompleted,
        helpString: 'Checks if the current task is completed',
        returns: 'true or false',
    }));

    // Add event listeners for the buttons defined in settings.html
    $(document).on('click', '#objective_templates', onManageTemplatesClick);
    $(document).on('click', '#objective_export', exportTasks);
    $(document).on('click', '#objective_import', importTasks);
    $(document).on('click', '#objective_statistics', showStatistics);

    $(document).on('click', '#objective-swipes-decrement', onSwipesDecrementInput);
    $(document).on('input', '#objective-injection-frequency', onInjectionFrequencyInput);
    $(document).on('change', '#objective-prompt-role', onPromptRoleInput);

    // Initialize the prompt role dropdown
    const selectElement = $('#objective-prompt-role');

    // Set the initial value based on the saved setting
    const savedRole = chat_metadata.objective.promptRole;
    if (savedRole === extension_prompt_roles.SYSTEM) {
        selectElement.val('system');
    } else if (savedRole === extension_prompt_roles.USER) {
        selectElement.val('user');
    } else {
        selectElement.val('assistant');
    }

    // Add event listener for the prompt role dropdown
    selectElement.on('change', onPromptRoleInput);
});

// Update the UI to show how many recently completed tasks are being tracked
function updateCompletedTasksCount() {
    const count = recentlyCompletedTasks.length;
    const viewButton = $('#objective-view-completed');

    if (count > 0) {
        viewButton.val(`View Tasks (${count})`);
    } else {
        viewButton.val('View Tasks');
    }
}

// Update upcoming tasks based on the current task
function updateUpcomingTasks() {
    // Clear the current upcoming tasks
    upcomingTasks = [];

    if (!currentTask || !currentTask.id || !currentObjective) {
        return;
    }

    // Find the current task's index in the parent's children array
    const parent = getTaskById(currentTask.parentId);
    if (!parent) return;

    const currentIndex = parent.children.findIndex(task => task.id === currentTask.id);
    if (currentIndex === -1) return;

    // Get the maximum number of upcoming tasks to show
    const maxUpcomingTasks = Number($('#objective-upcoming-count').val()) || 3;

    // Add tasks that come after the current task
    for (let i = currentIndex + 1; i < parent.children.length && upcomingTasks.length < maxUpcomingTasks; i++) {
        const task = parent.children[i];
        if (!task.completed) {
            upcomingTasks.push({
                id: task.id,
                description: task.description
            });
        }
    }

    // If we still need more tasks and there are other incomplete tasks elsewhere, add them
    if (upcomingTasks.length < maxUpcomingTasks) {
        // Get all incomplete tasks in order
        const allIncompleteTasks = getAllIncompleteTasks(taskTree);

        // Filter out tasks that are already in upcomingTasks or are the current task
        const filteredTasks = allIncompleteTasks.filter(task =>
            task.id !== currentTask.id &&
            !upcomingTasks.some(upcomingTask => upcomingTask.id === task.id)
        );

        // Add remaining tasks up to the limit
        for (let i = 0; i < filteredTasks.length && upcomingTasks.length < maxUpcomingTasks; i++) {
            upcomingTasks.push({
                id: filteredTasks[i].id,
                description: filteredTasks[i].description
            });
        }
    }

    // Update the UI with the new count
    updateUpcomingTasksCount();
}

// Get all incomplete tasks in the tree in a flat array
function getAllIncompleteTasks(task) {
    let result = [];

    // Skip the root task
    if (task.parentId !== '') {
        if (!task.completed) {
            result.push(task);
        }
    }

    // Recursively add all children's incomplete tasks
    for (const child of task.children) {
        result = result.concat(getAllIncompleteTasks(child));
    }

    return result;
}

// Update the UI to show how many upcoming tasks are being tracked
function updateUpcomingTasksCount() {
    const count = upcomingTasks.length;
    const viewButton = $('#objective-view-upcoming');

    if (count > 0) {
        viewButton.val(`View Tasks (${count})`);
    } else {
        viewButton.val('View Tasks');
    }
}

function onShowUpcomingTasksInput() {
    setCurrentTask();
    saveState();
}

function onUpcomingTasksCountInput() {
    // Update the upcoming tasks array based on the new count
    updateUpcomingTasks();
    setCurrentTask();
    saveState();
}

async function onPurgeUpcomingTasksClick() {
    // If there are no tasks to purge, just show a message
    if (upcomingTasks.length === 0) {
        toastr.info('No upcoming tasks to purge');
        return;
    }

    // Ask for confirmation before purging
    const confirmation = await Popup.show.confirm('Are you sure you want to purge all upcoming tasks?', null);

    if (!confirmation) {
        return;
    }

    // Clear the upcoming tasks array
    upcomingTasks = [];

    // Update the UI with the new count
    updateUpcomingTasksCount();

    // Update the extension prompt
    setCurrentTask();
    saveState();

    toastr.success('Upcoming tasks have been purged');
}

// Show upcoming tasks in a popup
function showUpcomingTasks() {
    if (upcomingTasks.length === 0) {
        toastr.info('No upcoming tasks');
        return;
    }

    let popupText = `
    <div class="objective_statistics_modal">
        <h3 class="stats-header">Upcoming Tasks</h3>
        
        <div class="stats-container">
            <div class="stats-section">
                <h4 class="stats-section-header">Task Queue</h4>
                <p>These tasks are included in the AI's context when "Include upcoming tasks in prompt" is enabled.</p>
                
                <div class="objective_completion_history">
                    <ul class="objective_history_list">`;

    for (const task of upcomingTasks) {
        popupText += `
                        <li class="objective_history_item">
                            <div class="objective_history_task">${task.description}</div>
                        </li>`;
    }

    popupText += `
                    </ul>
                </div>
            </div>
            
            <div class="stats-section">
                <h4 class="stats-section-header">Actions</h4>
                <p>Clearing upcoming tasks will remove them from the prompt context.</p>
                <div class="flex-container justifyCenter marginTop10">
                    <button id="upcoming-tasks-purge" class="menu_button">Purge All Upcoming Tasks</button>
                </div>
            </div>
        </div>
    </div>`;

    callGenericPopup(popupText, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true, wider: true });

    // Add event listener for the purge button in the popup
    $('#upcoming-tasks-purge').on('click', () => {
        onPurgeUpcomingTasksClick();
        // Close the popup
        $('.popup_cross').click();
    });
}
