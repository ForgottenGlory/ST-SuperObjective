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
import { onManageTemplatesClick } from './lib/templates-modal.js';
import { exportTasks, importTasks } from './lib/import-export.js';

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
