/**
 * Settings panel input handlers and the SillyTavern Extras menu items.
 *
 * Most of these are one-liner glue functions that read a setting from a
 * form control, push it into state/metadata, and trigger a save. The
 * Extras menu items expose Manual Task Check + Complete Current Task.
 */

import { chat_metadata, extension_prompt_roles } from '../../../../../script.js';

import { state } from './state.js';
import { saveState } from './persistence.js';
import { setCurrentTask, updateUiTaskList } from './ui-tasklist.js';
import { getTaskById } from './task.js';
import { updateCompletedTasksCount } from './recent-tasks.js';
import { generateTasks, generateAdditionalTasks, markTaskCompleted, checkTaskCompleted } from './generation.js';

/** "Go to parent" — switch the current objective up one level. */
export function onParentClick() {
    state.currentObjective = getTaskById(state.currentObjective.parentId);
    updateUiTaskList();
    setCurrentTask();
}

/** "Auto-Generate Tasks" — full replacement. */
export async function onGenerateObjectiveClick() {
    await generateTasks();
    saveState();
}

/** "Generate More Tasks" — append. */
export async function onGenerateAdditionalTasksClick() {
    await generateAdditionalTasks();
    saveState();
}

/** Position-in-Chat input. */
export function onChatDepthInput() {
    saveState();
    setCurrentTask();
}

/** Persist objective description on focusout. */
export function onObjectiveTextFocusOut() {
    if (state.currentObjective) {
        state.currentObjective.description = $('#objective-text').val();
        saveState();
    }
}

/** Task Check Frequency input. */
export function onCheckFrequencyInput() {
    state.checkCounter = Number($('#objective-check-frequency').val());
    $('#objective-counter').text(state.checkCounter);
    saveState();
}

/** "Count swipes toward task check frequency" checkbox. */
export function onSwipesDecrementInput() {
    saveState();
}

/** "Hide Tasks" checkbox. */
export function onHideTasksInput() {
    $('#objective-tasks').prop('hidden', $('#objective-hide-tasks').prop('checked'));
    saveState();
}

/** "Clear Tasks" button — wipes the current objective's tasks. */
export function onClearTasksClick() {
    if (state.currentObjective) {
        state.currentObjective.children = [];
        state.recentlyCompletedTasks = [];
        updateCompletedTasksCount();
        updateUiTaskList();
        setCurrentTask();
        saveState();
        toastr.success('All tasks cleared');
    }
}

/** Task Prompt Role dropdown — sets which role tasks are injected as. */
export function onPromptRoleInput() {
    const selected = $('#objective-prompt-role').val();

    let role;
    switch (selected) {
        case 'system': role = extension_prompt_roles.SYSTEM; break;
        case 'user':   role = extension_prompt_roles.USER;   break;
        case 'assistant':
        default:       role = extension_prompt_roles.ASSISTANT; break;
    }

    chat_metadata.objective.promptRole = role;
    setCurrentTask();
    saveState();
}

/** Task Injection Frequency input. */
export function onInjectionFrequencyInput() {
    // Reset to 0 so the next message will inject (rather than waiting through
    // however many messages of the old frequency we'd already accumulated).
    state.injectionCounter = 0;
    saveState();
}

/**
 * Add the SuperObjective items to the Extras (wand) menu: a manual
 * "AI check completion now" trigger and a "mark current done" trigger.
 */
export function addManualTaskCheckUi() {
    const getWandContainer = () =>
        $(document.getElementById('objective_wand_container') ?? document.getElementById('extensionsMenu'));
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

    $('#objective-task-manual-check-menu-item')
        .attr('title', 'Trigger AI check of completed tasks')
        .on('click', checkTaskCompleted);
    $('#objective-task-complete-current-menu-item')
        .attr('title', 'Mark the current task as completed.')
        .on('click', markTaskCompleted);
}
