/**
 * SuperObjective — entry point.
 *
 * Each functional area lives in its own `lib/` module. This file is just
 * glue: it loads the settings template, wires DOM event handlers to the
 * exported handler functions, registers the SillyTavern event listeners
 * (CHAT_CHANGED, MESSAGE_RECEIVED, MESSAGE_SWIPED), and registers the
 * `/taskcheck` slash command.
 */

import {
    chat_metadata,
    eventSource,
    event_types,
    extension_prompt_roles,
    substituteParams,
} from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';

import { state } from './lib/state.js';
import { incrementTaskElapsedMessages } from './lib/task.js';
import { loadSettings, resetState, debugObjectiveExtension } from './lib/persistence.js';
import { showStatistics } from './lib/statistics.js';
import {
    onShowCompletedTasksInput,
    onCompletedTasksCountInput,
    onPurgeCompletedTasksClick,
    showRecentlyCompletedTasks,
} from './lib/recent-tasks.js';
import {
    onShowUpcomingTasksInput,
    onUpcomingTasksCountInput,
    showUpcomingTasks,
} from './lib/upcoming-tasks.js';
import { setCurrentTask, updateUiTaskList } from './lib/ui-tasklist.js';
import { mountWorkspace, openWorkspace, getSelectedTask, setSelectedTask } from './lib/ui-workspace.js';
import { checkTaskCompleted } from './lib/generation.js';
import { onEditPromptClick } from './lib/prompts-modal.js';
import { onManageTemplatesClick } from './lib/templates-modal.js';
import { exportTasks, importTasks } from './lib/import-export.js';
import {
    addManualTaskCheckUi,
    onGenerateObjectiveClick,
    onGenerateAdditionalTasksClick,
    onChatDepthInput,
    onObjectiveTextFocusOut,
    onCheckFrequencyInput,
    onSwipesDecrementInput,
    onHideTasksInput,
    onClearTasksClick,
    onPromptRoleInput,
    onInjectionFrequencyInput,
} from './lib/ui-settings.js';

// Console-only debug helper — `debugObjectiveExtension()` from devtools.
globalThis.debugObjectiveExtension = debugObjectiveExtension;

jQuery(async () => {
    const [settingsHtml, workspaceHtml] = await Promise.all([
        renderExtensionTemplateAsync('third-party/ST-SuperObjective', 'settings'),
        renderExtensionTemplateAsync('third-party/ST-SuperObjective', 'workspace'),
    ]);

    addManualTaskCheckUi();

    const getContainer = () =>
        $(document.getElementById('objective_container') ?? document.getElementById('extensions_settings'));
    getContainer().append(settingsHtml);

    // Mount the workspace overlay (hidden until the user opens it). All
    // form inputs the existing handlers reference live inside this template,
    // so loadSettings() can populate them even before the overlay is shown.
    mountWorkspace(workspaceHtml);

    // Settings panel: action buttons + inputs.
    $(document).on('click',   '#objective-generate',          onGenerateObjectiveClick);
    $(document).on('click',   '#objective-generate-more',     onGenerateAdditionalTasksClick);
    $(document).on('input',   '#objective-chat-depth',        onChatDepthInput);
    $(document).on('input',   '#objective-check-frequency',   onCheckFrequencyInput);
    $(document).on('click',   '#objective-hide-tasks',        onHideTasksInput);
    $(document).on('click',   '#objective-clear',             onClearTasksClick);
    $(document).on('click',   '#objective_prompt_edit',       onEditPromptClick);
    $(document).on('focusout','#objective-text',              onObjectiveTextFocusOut);
    $(document).on('click',   '#objective-show-completed',    onShowCompletedTasksInput);
    $(document).on('input',   '#objective-completed-count',   onCompletedTasksCountInput);
    $(document).on('click',   '#objective-purge-completed',   onPurgeCompletedTasksClick);
    $(document).on('click',   '#objective-view-completed',    showRecentlyCompletedTasks);
    $(document).on('click',   '#objective-show-upcoming',     onShowUpcomingTasksInput);
    $(document).on('input',   '#objective-upcoming-count',    onUpcomingTasksCountInput);
    $(document).on('click',   '#objective-view-upcoming',     showUpcomingTasks);
    $(document).on('click',   '#objective-swipes-decrement',  onSwipesDecrementInput);
    $(document).on('input',   '#objective-injection-frequency', onInjectionFrequencyInput);
    $(document).on('change',  '#objective-prompt-role',       onPromptRoleInput);
    $(document).on('click',   '#objective_templates',         onManageTemplatesClick);
    $(document).on('click',   '#objective_export',            exportTasks);
    $(document).on('click',   '#objective_import',            importTasks);
    $(document).on('click',   '#objective_statistics',        showStatistics);
    $(document).on('click', '#objective-open-workspace', () => openWorkspace());

    // Top-level "Add" button in the upcoming-tasks panel header.
    $(document).on('click', '#objective-task-add-toplevel', () => {
        if (!state.currentObjective) return;
        const newTask = state.currentObjective.addTask('New Task');
        updateUiTaskList();
        setCurrentTask(newTask.id);
    });

    // "Add" button in the subtasks panel — adds a child under the selected
    // task. This replaces the per-row fork/branch icon: instead of drilling
    // into a task to add to it, you select it and add from the right column.
    $(document).on('click', '#objective-add-subtask', () => {
        const selected = getSelectedTask();
        if (!selected) return;
        selected.addTask('New Subtask');
        setSelectedTask(selected.id);
    });

    loadSettings();

    // Initialize the Task Prompt Role dropdown from saved metadata.
    const roleSelect = $('#objective-prompt-role');
    const savedRole = chat_metadata.objective.promptRole;
    if (savedRole === extension_prompt_roles.SYSTEM)      roleSelect.val('system');
    else if (savedRole === extension_prompt_roles.USER)   roleSelect.val('user');
    else                                                  roleSelect.val('assistant');
    roleSelect.on('change', onPromptRoleInput);

    // SillyTavern event hooks.
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

        incrementTaskElapsedMessages();

        const injectionFrequency = Number($('#objective-injection-frequency').val()) || 1;
        const wasTimeToInject = state.injectionCounter === 0;

        // Bump injection counter; wraps to 0 when frequency hits.
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

        if (Number($('#objective-check-frequency').val()) > 0
            && !noCheckTypes.includes(lastType)
            && shouldDecrement) {
            if (--state.checkCounter <= 0) {
                state.checkCounter = Math.max(0, state.checkCounter);
                checkForCompletion = true;
            }
        }

        state.lastMessageWasSwipe = false;

        const checkTaskPromise = checkForCompletion ? checkTaskCompleted() : Promise.resolve();
        checkTaskPromise.finally(() => {
            // Re-inject if either the counter rolled (it's a normal injection
            // tick) or we just performed a completion check (which may have
            // changed the current task).
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
});
