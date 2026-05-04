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
import { escapeHtml, watchdog } from './lib/utils.js';
import { state, defaultPrompts, defaultSettings } from './lib/state.js';
import { substituteParamsPrompts } from './lib/prompts.js';
import {
    ObjectiveTask,
    getTaskById,
    getTaskByIdRecurse,
    getNextIncompleteTaskRecurse,
    incrementTaskElapsedMessages,
} from './lib/task.js';
import {
    saveState,
    loadSettings,
    resetState,
    debugObjectiveExtension,
} from './lib/persistence.js';
import {
    addToCompletionHistory,
    updateStatistics,
    showStatistics,
} from './lib/statistics.js';
import {
    addToRecentlyCompletedTasks,
    updateCompletedTasksCount,
    onShowCompletedTasksInput,
    onCompletedTasksCountInput,
    onPurgeCompletedTasksClick,
    showRecentlyCompletedTasks,
} from './lib/recent-tasks.js';

const MODULE_NAME = 'SuperObjective';

//###############################//
//#       Task Management       #//
//###############################//

// Call Quiet Generate to create task list using character context, then convert to tasks. Should not be called much.
async function generateTasks() {
    const prompt = substituteParamsPrompts(state.objectivePrompts.createTask, false);
    console.log('Generating tasks for objective with prompt');
    toastr.info('Generating tasks for objective', 'Please wait...');

    let taskResponse;
    try {
        taskResponse = await generateQuietPrompt(prompt, false, false);
    } catch (err) {
        console.error('Failed to generate tasks:', err);
        toastr.error('Failed to generate tasks. Existing tasks were preserved.');
        return;
    }

    const numberedListPattern = /^\d+\./;
    const parsedTasks = taskResponse
        .split('\n')
        .map(x => x.trim())
        .filter(x => numberedListPattern.test(x))
        .map(x => x.replace(numberedListPattern, '').trim())
        .filter(x => x.length > 0);

    // Bail out before destroying existing tasks if the response had nothing usable.
    if (parsedTasks.length === 0) {
        console.warn('Task generation returned no parseable tasks. Existing tasks preserved. Response was:', taskResponse);
        toastr.warning('No tasks were generated. Existing tasks were preserved.');
        return;
    }

    // Now it's safe to clear and replace.
    state.currentObjective.children = [];
    let firstTask = null;
    for (const description of parsedTasks) {
        const newTask = state.currentObjective.addTask(description);
        if (!firstTask) {
            firstTask = newTask;
        }
    }
    updateUiTaskList();

    // Find and highlight the first task
    if (firstTask) {
        setCurrentTask(firstTask.id);
    } else {
        setCurrentTask();
    }

    console.info(`Response for Objective: '${state.currentObjective.description}' was \n'${taskResponse}', \nwhich created tasks \n${JSON.stringify(state.currentObjective.children.map(v => v.toSaveStateRecurse()), null, 2)} `);
    toastr.success(`Generated ${state.currentObjective.children.length} tasks`, 'Done!');
}

// Generate additional tasks without clearing existing ones
async function generateAdditionalTasks() {
    // If there are no existing tasks, just use the regular generate function
    if (!state.currentObjective || state.currentObjective.children.length === 0) {
        return generateTasks();
    }

    // Create a list of existing tasks for the prompt
    let existingTasksText = state.currentObjective.children.map((task, index) =>
        `${index + 1}. ${task.description}`).join('\n');

    // Use the additionalTasks prompt with the existing tasks inserted
    let additionalPrompt = state.objectivePrompts.additionalTasks || defaultPrompts.additionalTasks;
    additionalPrompt = additionalPrompt.replace(/{{existingTasks}}/gi, existingTasksText);

    // Make sure objective is replaced before calling substituteParamsPrompts
    additionalPrompt = additionalPrompt.replace(/{{objective}}/gi, state.currentObjective?.description ?? '');

    additionalPrompt = substituteParamsPrompts(additionalPrompt, false);

    console.log('Generating additional tasks for objective');
    toastr.info('Generating additional tasks', 'Please wait...');

    let taskResponse;
    try {
        taskResponse = await generateQuietPrompt(additionalPrompt, false, false);
    } catch (err) {
        console.error('Failed to generate additional tasks:', err);
        toastr.error('Failed to generate additional tasks.');
        return;
    }

    const initialTaskCount = state.currentObjective.children.length;
    const numberedListPattern = /^\d+\./;

    // Track the first new task we add
    let firstNewTask = null;

    // Add new tasks to the existing list
    for (const task of taskResponse.split('\n').map(x => x.trim())) {
        if (task.match(numberedListPattern) != null) {
            const description = task.replace(numberedListPattern, '').trim();
            if (!description) continue;
            const newTask = state.currentObjective.addTask(description);
            if (!firstNewTask) {
                firstNewTask = newTask;
            }
        }
    }

    const newTaskCount = state.currentObjective.children.length - initialTaskCount;
    updateUiTaskList();

    // If new tasks were added, highlight the first new task
    if (newTaskCount > 0 && firstNewTask) {
        setCurrentTask(firstNewTask.id);
    } else {
        // Otherwise find the first incomplete task
        const nextTask = getNextIncompleteTaskRecurse(state.taskTree);
        if (nextTask) {
            setCurrentTask(nextTask.id);
        } else {
            setCurrentTask();
        }
    }

    console.info(`Generated ${newTaskCount} additional tasks for objective: '${state.currentObjective.description}'`);
    toastr.success(`Added ${newTaskCount} additional tasks`, 'Done!');
}

async function markTaskCompleted() {
    if (!state.currentTask) {
        console.warn('No current task to mark as completed');
        toastr.warning('No current task to mark as completed');
        return;
    }

    if (state.currentTask.completed) {
        toastr.info('Task was already marked as completed');
        return;
    }

    console.info(`User determined task '${state.currentTask.description}' is completed.`);
    // completeTask handles history, stats, parent-cascade, and next-task selection.
    state.currentTask.completeTask();
}

// Call Quiet Generate to check if a task is completed
async function checkTaskCompleted() {
    if (!state.currentTask) {
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
    const taskId = state.currentTask.id;

    // Check if the task has a duration set and if enough messages have passed
    if (state.currentTask.duration > 0) {
        // If not enough messages have passed, skip the completion check
        if (state.currentTask.elapsedMessages < state.currentTask.duration) {
            console.debug(`Task ${state.currentTask.id} has duration ${state.currentTask.duration}, but only ${state.currentTask.elapsedMessages} messages have passed`);

            // Prepare the check prompt (but don't send it yet)
            const prompt = substituteParamsPrompts(state.objectivePrompts.checkTaskCompleted, false);

            // Run a quiet check to see if the task would be completed
            const taskResponse = (await generateQuietPrompt(prompt, false, false)).toLowerCase();

            // Clear the initial toast
            toastr.clear(toast);

            // If the task would be completed but duration requirement not met, show a special message
            if (taskResponse.includes('true')) {
                console.debug(`Task ${state.currentTask.id} would be completed but duration requirement not met: ${state.currentTask.elapsedMessages}/${state.currentTask.duration} messages passed`);
                toastr.warning(`Task would be completed but duration requirement not met: ${state.currentTask.elapsedMessages}/${state.currentTask.duration} messages needed`, 'Task Duration Not Met');
            }

            // Reset counter but don't check completion yet
            state.checkCounter = Number($('#objective-check-frequency').val());

            // Make sure to preserve the highlight
            setCurrentTask(taskId);

            return String(false);
        }

        console.debug(`Task ${state.currentTask.id} duration requirement met: ${state.currentTask.elapsedMessages}/${state.currentTask.duration} messages passed`);
    }

    // At this point either there's no duration requirement or the requirement has been met
    // Generate the prompt and get response
    const prompt = substituteParamsPrompts(state.objectivePrompts.checkTaskCompleted, false);
    const taskResponse = (await generateQuietPrompt(prompt, false, false)).toLowerCase();

    // Clear the "checking" toast
    toastr.clear(toast);

    // Reset check counter for next time
    state.checkCounter = Number($('#objective-check-frequency').val());

    // Check response if task complete
    if (taskResponse.includes('true')) {
        console.info(`Character determined task '${state.currentTask.description}' is completed.`);
        state.currentTask.completeTask();
        toastr.success(`Task "${state.currentTask.description}" completed!`, 'Task Completed');
        return String(true);
    } else if (!(taskResponse.includes('false'))) {
        console.warn(`checkTaskCompleted response did not contain true or false. taskResponse: ${taskResponse}`);
    } else {
        console.debug(`Checked task completion. taskResponse: ${taskResponse}`);
        // Show a toast notification when task is not completed
        toastr.info(`Task "${state.currentTask.description}" is not complete yet`, 'Task Incomplete');
        // If task is not completed, make sure to preserve the highlight
        setCurrentTask(taskId);
    }

    return String(false);
}

// Set a task in extensionPrompt context. Defaults to first incomplete
export function setCurrentTask(taskId = null, skipSave = false) {
    const context = getContext();

    // Store the previous current task ID
    const previousTaskId = state.currentTask?.id ?? null;

    // Find the task, either next incomplete, or by provided taskId
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
        // If this is a different task than before, reset the elapsed messages counter
        if (previousTaskId !== state.currentTask.id) {
            state.currentTask.elapsedMessages = 0;
            console.debug(`Reset elapsed messages counter for new current task ${state.currentTask.id}`);
        }

        // Check if we should inject the task based on the injection counter
        // Always inject if:
        // - skipSave is true (usually means we just loaded from settings)
        // - injectionCounter is 0 (it's time to inject based on frequency)
        // - it's a new task (previous task ID is different)
        const shouldInjectTask = skipSave || state.injectionCounter === 0 || previousTaskId !== state.currentTask.id;

        if (shouldInjectTask) {
            let extensionPromptText = substituteParamsPrompts(state.objectivePrompts.currentTask, true);

            // Add recently completed tasks if enabled
            if ($('#objective-show-completed').prop('checked') && state.recentlyCompletedTasks.length > 0) {
                const completedTasksText = state.recentlyCompletedTasks
                    .map(task => `[${task.description}]`)
                    .join(', ');

                let completedTasksPrompt = state.objectivePrompts.completedTasks.replace(/{{completedTasks}}/gi, completedTasksText);
                completedTasksPrompt = substituteParams(completedTasksPrompt);

                extensionPromptText = `${extensionPromptText}\n${completedTasksPrompt}`;
            }

            // Update upcoming tasks based on the current task
            updateUpcomingTasks();

            // Add upcoming tasks if enabled
            if ($('#objective-show-upcoming').prop('checked') && state.upcomingTasks.length > 0) {
                const upcomingTasksText = state.upcomingTasks
                    .map(task => `[${task.description}]`)
                    .join(', ');

                let upcomingTasksPrompt = state.objectivePrompts.upcomingTasks.replace(/{{upcomingTasks}}/gi, upcomingTasksText);
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

//###############################//
//#       Custom Prompts        #//
//###############################//

function onEditPromptClick() {
    let popupText = '';
    popupText += `
    <div class="objective_prompt_modal">
        <div class="objective_prompt_block justifyCenter">
            <label for="objective-custom-prompt-select">Custom Prompt Select</label>
            <select id="objective-custom-prompt-select" class="text_pole"></select>
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
        <small>Edit prompts used by Objective for this session. You can use {{objective}} or {{currentTask}} ({{task}} is also accepted) plus any other standard template variables. Save template to persist changes.</small>
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
    populateCustomPrompts(state.selectedCustomPrompt);

    // Set current values
    $('#objective-prompt-generate').val(state.objectivePrompts.createTask);
    $('#objective-prompt-additional').val(state.objectivePrompts.additionalTasks || defaultPrompts.additionalTasks);
    $('#objective-prompt-check').val(state.objectivePrompts.checkTaskCompleted);
    $('#objective-prompt-extension-prompt').val(state.objectivePrompts.currentTask);
    $('#objective-prompt-completed-tasks').val(state.objectivePrompts.completedTasks || defaultPrompts.completedTasks);
    $('#objective-prompt-upcoming-tasks').val(state.objectivePrompts.upcomingTasks || defaultPrompts.upcomingTasks);

    // Handle value updates
    $('#objective-prompt-generate').on('input', () => {
        state.objectivePrompts.createTask = String($('#objective-prompt-generate').val());
        saveState();
        setCurrentTask();
    });
    $('#objective-prompt-additional').on('input', () => {
        state.objectivePrompts.additionalTasks = String($('#objective-prompt-additional').val());
        saveState();
        setCurrentTask();
    });
    $('#objective-prompt-check').on('input', () => {
        state.objectivePrompts.checkTaskCompleted = String($('#objective-prompt-check').val());
        saveState();
        setCurrentTask();
    });
    $('#objective-prompt-extension-prompt').on('input', () => {
        state.objectivePrompts.currentTask = String($('#objective-prompt-extension-prompt').val());
        saveState();
        setCurrentTask();
    });
    $('#objective-prompt-completed-tasks').on('input', () => {
        state.objectivePrompts.completedTasks = String($('#objective-prompt-completed-tasks').val());
        saveState();
        setCurrentTask();
    });
    $('#objective-prompt-upcoming-tasks').on('input', () => {
        state.objectivePrompts.upcomingTasks = String($('#objective-prompt-upcoming-tasks').val());
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
    if (!state.objectivePrompts.additionalTasks) {
        state.objectivePrompts.additionalTasks = defaultPrompts.additionalTasks;
    }

    // Make sure we have the completed tasks prompt
    if (!state.objectivePrompts.completedTasks) {
        state.objectivePrompts.completedTasks = defaultPrompts.completedTasks;
    }

    // Make sure we have the upcoming tasks prompt
    if (!state.objectivePrompts.upcomingTasks) {
        state.objectivePrompts.upcomingTasks = defaultPrompts.upcomingTasks;
    }

    extension_settings.objective.customPrompts[customPromptName] = {};
    Object.assign(extension_settings.objective.customPrompts[customPromptName], state.objectivePrompts);
    saveSettingsDebounced();
    populateCustomPrompts(customPromptName);
}

function saveCustomPrompt() {
    const customPromptName = String($('#objective-custom-prompt-select').find(':selected').val());
    if (customPromptName == 'default') {
        toastr.error('Cannot save over default prompt');
        return;
    }
    Object.assign(extension_settings.objective.customPrompts[customPromptName], state.objectivePrompts);
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
    state.selectedCustomPrompt = 'default';
    populateCustomPrompts(state.selectedCustomPrompt);
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
    Object.assign(state.objectivePrompts, extension_settings.objective.customPrompts[optionSelected]);
    state.selectedCustomPrompt = optionSelected;

    $('#objective-prompt-generate').val(state.objectivePrompts.createTask).trigger('input');
    $('#objective-prompt-additional').val(state.objectivePrompts.additionalTasks || defaultPrompts.additionalTasks).trigger('input');
    $('#objective-prompt-check').val(state.objectivePrompts.checkTaskCompleted);
    $('#objective-prompt-extension-prompt').val(state.objectivePrompts.currentTask);
    $('#objective-prompt-completed-tasks').val(state.objectivePrompts.completedTasks || defaultPrompts.completedTasks);
    $('#objective-prompt-upcoming-tasks').val(state.objectivePrompts.upcomingTasks || defaultPrompts.upcomingTasks);

    saveState();
    setCurrentTask();
}

/**
 * Populate the custom prompt select dropdown with saved prompts.
 * @param {string} selected Optional selected prompt
 */
function populateCustomPrompts(selected) {
    if (!selected) {
        selected = state.selectedCustomPrompt || 'default';
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


globalThis.debugObjectiveExtension = debugObjectiveExtension;


// Populate UI task list
export function updateUiTaskList() {
    // Clear existing task list
    $('#objective-tasks').empty();

    // Remove existing filter/sort controls to prevent duplication
    $('#objective-filter-sort').remove();

    // Show button to navigate back to parent objective if parent exists
    if (state.currentObjective) {
        if (state.currentObjective.parentId !== '') {
            $('#objective-parent').show();
        } else {
            $('#objective-parent').hide();
        }
    } else {
        // If no current objective, hide the parent button
        $('#objective-parent').hide();
    }

    // Show the objective text in the text area
    $('#objective-text').val(state.currentObjective ? state.currentObjective.description : '');

    // Show/hide Generate More Tasks button based on whether there are existing tasks
    if (state.currentObjective && state.currentObjective.children.length > 0) {
        $('#objective-generate-more').show();
    } else {
        $('#objective-generate-more').hide();
    }

    if (state.currentObjective && state.currentObjective.children.length > 0) {
        // Add tasks to UI
        for (const task of state.currentObjective.children) {
            task.addUiElement();
        }

        // Find the first incomplete task in the current objective's children
        const firstIncompleteTask = state.currentObjective.children.find(task => !task.completed);
        if (firstIncompleteTask) {
            setCurrentTask(firstIncompleteTask.id, true);
        } else {
            // All tasks are completed: clear the "current task" so the prompt
            // injection doesn't misleadingly tell the LLM a completed task is
            // still in progress.
            setCurrentTask(null, true);
        }
    } else {
        // Show button to add tasks if there are none
        $('#objective-tasks').append(`
        <input id="objective-task-add-first" type="button" class="menu_button" value="Add Task">
        `);
        $('#objective-task-add-first').on('click', () => {
            const newTask = state.currentObjective.addTask('');
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
        // Note: do NOT call .disableSelection() here. It attaches a global
        // mousedown.preventDefault() that blocks focus into contenteditable
        // task spans on Chrome/Chromium, making task descriptions uneditable.
        // The `handle` option already restricts drag-init to the grip icon,
        // and `cancel` excludes interactive elements as a belt-and-braces.
        $('#objective-tasks').sortable({
            items: '> .objective-task-item',
            handle: '[id^=objective-task-drag-]',
            cancel: 'input,textarea,button,select,option,[contenteditable="true"]',
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
                    const task = state.currentObjective.children.find(t => t.id === taskId);
                    if (task) {
                        newChildren.push(task);
                    }
                }

                // Replace the children array with the new ordered array
                state.currentObjective.children = newChildren;

                // Update upcoming tasks list and other UI elements
                updateUpcomingTasks();
                updateCompletedTasksCount();

                // Remove all highlights first
                $('.objective-task').removeClass('objective-task-highlight');
                $('.objective-task').css({ 'border-color': '', 'border-width': '' });

                // After reordering, always select the first incomplete task based on the new order
                const firstIncompleteTask = state.currentObjective.children.find(task => !task.completed);
                if (firstIncompleteTask) {
                    // Use setCurrentTask to properly update the current task and apply highlighting
                    setCurrentTask(firstIncompleteTask.id);
                } else {
                    // All complete: clear current task rather than re-injecting a completed one.
                    setCurrentTask(null);
                }

                // Save the new state
                saveState();
            }
        });
    } else {
        console.warn("jQuery UI sortable not available. Drag-and-drop task reordering is disabled.");
        // Add a small notice at the top of the task list
        if (state.currentObjective && state.currentObjective.children.length > 0) {
            $('#objective-tasks').prepend('<div class="sortable-notice" style="font-size: 0.8em; opacity: 0.7; margin-bottom: 10px;">Note: Drag-and-drop ordering requires jQuery UI.</div>');
        }
    }
}

// Calculate and update the progress bar
function updateProgressBar() {
    if (!state.currentObjective || state.currentObjective.children.length === 0) {
        // No tasks to show progress for
        $('#objective-progress-container').hide();
        return;
    }

    // Count completed tasks
    let completedCount = 0;
    let totalCount = state.currentObjective.children.length;

    for (const task of state.currentObjective.children) {
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
    state.currentObjective = getTaskById(state.currentObjective.parentId);
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
    if (state.currentObjective) {
        state.currentObjective.description = $('#objective-text').val();
        saveState();
    }
}

// Update how often we check for task completion
function onCheckFrequencyInput() {
    state.checkCounter = Number($('#objective-check-frequency').val());
    $('#objective-counter').text(state.checkCounter);
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
    if (state.currentObjective) {
        state.currentObjective.children = [];
        // Clear recently completed tasks as well
        state.recentlyCompletedTasks = [];

        // Update the UI with the new count
        updateCompletedTasksCount();

        updateUiTaskList();
        setCurrentTask();
        saveState();
        toastr.success('All tasks cleared');
    }
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

        let popoutContents = $('#objectiveExtensionDrawerContents');
        const controller = new AbortController();

        const restoreDrawer = () => {
            originalElement.empty();
            originalElement.append(popoutContents);
            $('#objectiveExtensionPopout').remove();
        };

        //setup listener for close button to restore extensions menu
        $('#objectiveExtensionPopoutClose').off('click').on('click', function () {
            $('#objectiveExtensionDrawerContents').removeClass('scrollY');
            popoutContents = $('#objectiveExtensionDrawerContents');
            $('#objectiveExtensionPopout').fadeOut(animation_duration, () => {
                restoreDrawer();
                controller.abort();
            });
            loadSettings();
        });

        // Watchdog: if the popout gets dismissed by ESC or other external
        // means, the drawer would otherwise be stuck on "Currently popped out"
        // forever. Detect a missing drawer-contents node and self-heal.
        watchdog(5000, controller.signal, () => {
            if ($('#objectiveExtensionDrawerContents').length === 0) {
                console.debug('detected broken popout, restoring');
                restoreDrawer();
                loadSettings();
                controller.abort();
            }
        });
    } else {
        console.debug('saw existing popout, removing');
        $('#objectiveExtensionPopout').fadeOut(animation_duration, () => { $('#objectiveExtensionPopoutClose').trigger('click'); });
    }
}

// Add template management UI
function onManageTemplatesClick() {
    let popupText = '';
    popupText += `
    <div class="objective_templates_modal">
        <div class="objective_prompt_block justifyCenter">
            <label for="objective-template-select">Task Templates</label>
            <select id="objective-template-select" class="text_pole"></select>
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
    if (!state.currentObjective || state.currentObjective.children.length === 0) {
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
    const templateTasks = JSON.parse(JSON.stringify(state.currentObjective.children));
    clearCompletionStatusRecursive(templateTasks);

    extension_settings.objective.templates[templateName] = {
        description: state.currentObjective.description,
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
    if (state.currentObjective.children.length > 0) {
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
        state.currentObjective.description = template.description;
    }

    // Clear current tasks and load from template
    state.currentObjective.children = [];

    // Deep clone the template tasks to avoid reference issues
    const templateTasks = JSON.parse(JSON.stringify(template.tasks));

    // Rebuild task objects with proper parentId references
    for (const taskData of templateTasks) {
        const task = new ObjectiveTask({
            description: taskData.description,
            parentId: state.currentObjective.id
        });

        if (taskData.children && taskData.children.length > 0) {
            loadChildTasksRecursive(task, taskData.children);
        }

        state.currentObjective.children.push(task);
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

    let previewHtml = `<h4>${escapeHtml(template.description) || 'No description'}</h4><ul>`;

    for (const task of template.tasks) {
        previewHtml += `<li>${escapeHtml(task.description)}`;
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
        html += `<li>${escapeHtml(child.description)}`;
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
// Show task statistics — moved to lib/statistics.js, but the local
// declaration below is the legacy block being removed.
// Export tasks to JSON file
async function exportTasks() {
    if (!state.currentObjective || state.currentObjective.children.length === 0) {
        toastr.warning('No tasks to export');
        return;
    }

    // Prepare export data
    const exportData = {
        description: state.currentObjective.description,
        tasks: state.currentObjective.children.map(task => task.toSaveStateRecurse()),
        exportDate: new Date().toISOString(),
        version: '1.0'
    };

    // Convert to JSON string
    const jsonString = JSON.stringify(exportData, null, 2);

    // Create default filename based on objective description
    let defaultFilename = 'objective-tasks.json';
    if (state.currentObjective.description) {
        // Create a safe filename from the objective description
        defaultFilename = state.currentObjective.description
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
            if (state.currentObjective.children.length > 0) {
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
                state.currentObjective.description = importData.description;
            }

            // Clear current tasks and load from import
            state.currentObjective.children = [];

            // Rebuild task objects with proper parentId references
            for (const taskData of importData.tasks) {
                const task = new ObjectiveTask({
                    description: taskData.description,
                    completed: taskData.completed || false,
                    parentId: state.currentObjective.id,
                });

                if (taskData.children && taskData.children.length > 0) {
                    loadChildTasksRecursive(task, taskData.children);
                }

                state.currentObjective.children.push(task);
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
    state.injectionCounter = 0;
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
        state.lastMessageWasSwipe = true;
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        if (state.currentChatId == undefined || !state.currentTask) {
            return;
        }

        const taskId = state.currentTask.id ?? null;

        // Increment the elapsed messages counter for the current task
        incrementTaskElapsedMessages();

        // Get the injection frequency
        const injectionFrequency = Number($('#objective-injection-frequency').val()) || 1;

        // Track if we need to inject on this message
        const wasTimeToInject = state.injectionCounter === 0;

        // Increment the injection counter
        // Reset to 0 when we reach the frequency, which means it's time to inject again
        state.injectionCounter++;
        if (state.injectionCounter >= injectionFrequency) {
            state.injectionCounter = 0;
        }

        let checkForCompletion = false;
        const noCheckTypes = ['continue', 'quiet', 'impersonate'];
        const lastType = substituteParams('{{lastGenerationType}}');

        // Detect swipes via both the event flag AND lastGenerationType: in
        // SillyTavern, MESSAGE_SWIPED can fire after MESSAGE_RECEIVED on
        // swipe-right generations, so the flag alone misses some swipes
        // (GitHub issue #1).
        const isSwipe = state.lastMessageWasSwipe || lastType === 'swipe';
        const swipesDecrement = $('#objective-swipes-decrement').prop('checked');
        const shouldDecrement = !isSwipe || swipesDecrement;

        if (Number($('#objective-check-frequency').val()) > 0 && !noCheckTypes.includes(lastType) && shouldDecrement) {
            // Check only at specified interval. Don't let counter go negative
            if (--state.checkCounter <= 0) {
                state.checkCounter = Math.max(0, state.checkCounter);
                checkForCompletion = true;
            }
        }

        // Reset the swipe flag
        state.lastMessageWasSwipe = false;

        const checkTaskPromise = checkForCompletion ? checkTaskCompleted() : Promise.resolve();
        checkTaskPromise.finally(() => {
            // If it was time to inject when this function started (counter was 0), update the task
            // Or if task completion check was performed, update the task
            if ((wasTimeToInject || checkForCompletion) && taskId) {
                setCurrentTask(taskId);
            }
            $('#objective-counter').text(state.checkCounter);
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


// Update upcoming tasks based on the current task
export function updateUpcomingTasks() {
    // Clear the current upcoming tasks
    state.upcomingTasks = [];

    if (!state.currentTask || !state.currentTask.id || !state.currentObjective) {
        return;
    }

    // Find the current task's index in the parent's children array
    const parent = getTaskById(state.currentTask.parentId);
    if (!parent) return;

    const currentIndex = parent.children.findIndex(task => task.id === state.currentTask.id);
    if (currentIndex === -1) return;

    // Get the maximum number of upcoming tasks to show
    const maxUpcomingTasks = Number($('#objective-upcoming-count').val()) || 3;

    // Add tasks that come after the current task
    for (let i = currentIndex + 1; i < parent.children.length && state.upcomingTasks.length < maxUpcomingTasks; i++) {
        const task = parent.children[i];
        if (!task.completed) {
            state.upcomingTasks.push({
                id: task.id,
                description: task.description
            });
        }
    }

    // If we still need more tasks and there are other incomplete tasks elsewhere, add them
    if (state.upcomingTasks.length < maxUpcomingTasks) {
        // Get all incomplete tasks in order
        const allIncompleteTasks = getAllIncompleteTasks(state.taskTree);

        // Filter out tasks that are already in upcomingTasks or are the current task
        const filteredTasks = allIncompleteTasks.filter(task =>
            task.id !== state.currentTask.id &&
            !state.upcomingTasks.some(upcomingTask => upcomingTask.id === task.id)
        );

        // Add remaining tasks up to the limit
        for (let i = 0; i < filteredTasks.length && state.upcomingTasks.length < maxUpcomingTasks; i++) {
            state.upcomingTasks.push({
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
    const count = state.upcomingTasks.length;
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
    if (state.upcomingTasks.length === 0) {
        toastr.info('No upcoming tasks to purge');
        return;
    }

    // Ask for confirmation before purging
    const confirmation = await Popup.show.confirm('Are you sure you want to purge all upcoming tasks?', null);

    if (!confirmation) {
        return;
    }

    // Clear the upcoming tasks array
    state.upcomingTasks = [];

    // Update the UI with the new count
    updateUpcomingTasksCount();

    // Update the extension prompt
    setCurrentTask();
    saveState();

    toastr.success('Upcoming tasks have been purged');
}

// Show upcoming tasks in a popup
function showUpcomingTasks() {
    if (state.upcomingTasks.length === 0) {
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

    for (const task of state.upcomingTasks) {
        popupText += `
                        <li class="objective_history_item">
                            <div class="objective_history_task">${escapeHtml(task.description)}</div>
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
