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
import {
    updateUpcomingTasks,
    updateUpcomingTasksCount,
    onShowUpcomingTasksInput,
    onUpcomingTasksCountInput,
    onPurgeUpcomingTasksClick,
    showUpcomingTasks,
} from './lib/upcoming-tasks.js';
import {
    setCurrentTask,
    updateUiTaskList,
} from './lib/ui-tasklist.js';
import { doPopout } from './lib/ui-popout.js';
import {
    generateTasks,
    generateAdditionalTasks,
    markTaskCompleted,
    checkTaskCompleted,
} from './lib/generation.js';
import { onEditPromptClick } from './lib/prompts-modal.js';

const MODULE_NAME = 'SuperObjective';

//###############################//
//#       Task Management       #//
//###############################//



//###############################//
//#       UI AND Settings       #//
//###############################//


globalThis.debugObjectiveExtension = debugObjectiveExtension;



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
