/**
 * The "Manage Prompts" modal: lets the user view, edit, save, delete, and
 * import/export named prompt sets that override the defaults.
 *
 * Saved sets live under `extension_settings.objective.customPrompts`. The
 * currently-applied set is mirrored into `state.objectivePrompts`.
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { callGenericPopup, Popup, POPUP_TYPE } from '../../../../popup.js';

import { state, defaultPrompts } from './state.js';
import { saveState } from './persistence.js';
import { setCurrentTask } from './ui-tasklist.js';

/** Open the Manage Prompts modal and wire up its inputs and buttons. */
export function onEditPromptClick() {
    const popupText = `
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

    // Seed the textareas from the active prompt set.
    $('#objective-prompt-generate').val(state.objectivePrompts.createTask);
    $('#objective-prompt-additional').val(state.objectivePrompts.additionalTasks || defaultPrompts.additionalTasks);
    $('#objective-prompt-check').val(state.objectivePrompts.checkTaskCompleted);
    $('#objective-prompt-extension-prompt').val(state.objectivePrompts.currentTask);
    $('#objective-prompt-completed-tasks').val(state.objectivePrompts.completedTasks || defaultPrompts.completedTasks);
    $('#objective-prompt-upcoming-tasks').val(state.objectivePrompts.upcomingTasks || defaultPrompts.upcomingTasks);

    // Live-bind each textarea to the matching field on state.objectivePrompts.
    const fields = [
        ['#objective-prompt-generate',          'createTask'],
        ['#objective-prompt-additional',        'additionalTasks'],
        ['#objective-prompt-check',             'checkTaskCompleted'],
        ['#objective-prompt-extension-prompt',  'currentTask'],
        ['#objective-prompt-completed-tasks',   'completedTasks'],
        ['#objective-prompt-upcoming-tasks',    'upcomingTasks'],
    ];
    for (const [selector, field] of fields) {
        $(selector).on('input', () => {
            state.objectivePrompts[field] = String($(selector).val());
            saveState();
            setCurrentTask();
        });
    }

    $('#objective-custom-prompt-new').on('click', newCustomPrompt);
    $('#objective-custom-prompt-save').on('click', saveCustomPrompt);
    $('#objective-custom-prompt-delete').on('click', deleteCustomPrompt);
    $('#objective-custom-prompt-export').on('click', exportCustomPrompts);
    $('#objective-custom-prompt-import').on('click', importCustomPrompts);
    $('#objective-custom-prompt-select').on('change', loadCustomPrompt);
}

/** Persist the current textarea contents under a fresh user-supplied name. */
async function newCustomPrompt() {
    const name = await Popup.show.input('Custom Prompt name', null);
    if (!name) {
        toastr.warning('Please set custom prompt name to save.');
        return;
    }
    if (name === 'default') {
        toastr.error('Cannot save over default prompt');
        return;
    }

    // Make sure the prompt set is fully populated before snapshotting.
    if (!state.objectivePrompts.additionalTasks) state.objectivePrompts.additionalTasks = defaultPrompts.additionalTasks;
    if (!state.objectivePrompts.completedTasks)  state.objectivePrompts.completedTasks  = defaultPrompts.completedTasks;
    if (!state.objectivePrompts.upcomingTasks)   state.objectivePrompts.upcomingTasks   = defaultPrompts.upcomingTasks;

    extension_settings.objective.customPrompts[name] = { ...state.objectivePrompts };
    saveSettingsDebounced();
    populateCustomPrompts(name);
}

/** Update the currently-selected custom prompt with the textarea contents. */
function saveCustomPrompt() {
    const name = String($('#objective-custom-prompt-select').find(':selected').val());
    if (name === 'default') {
        toastr.error('Cannot save over default prompt');
        return;
    }
    Object.assign(extension_settings.objective.customPrompts[name], state.objectivePrompts);
    saveSettingsDebounced();
    populateCustomPrompts(name);
    toastr.success('Prompt saved as ' + name);
}

/** Delete the selected prompt set after confirmation. */
async function deleteCustomPrompt() {
    const name = String($('#objective-custom-prompt-select').find(':selected').val());
    if (name === 'default') {
        toastr.error('Cannot delete default prompt');
        return;
    }
    if (!await Popup.show.confirm('Are you sure you want to delete this prompt?', null)) {
        return;
    }

    delete extension_settings.objective.customPrompts[name];
    saveSettingsDebounced();
    state.selectedCustomPrompt = 'default';
    populateCustomPrompts(state.selectedCustomPrompt);
    loadCustomPrompt();
}

/** Download the selected prompt set as a JSON file with a custom filename. */
async function exportCustomPrompts() {
    const promptName = $('#objective-custom-prompt-select').val();
    if (!promptName) {
        toastr.warning('Please select a prompt to export');
        return;
    }
    if (!extension_settings.objective.customPrompts || !extension_settings.objective.customPrompts[promptName]) {
        toastr.error('Prompt not found');
        return;
    }

    const exportData = {
        customPrompts: { [promptName]: extension_settings.objective.customPrompts[promptName] },
        exportDate: new Date().toISOString(),
        version: '1.0',
    };
    const jsonString = JSON.stringify(exportData, null, 2);

    const defaultFilename = `objective-prompt-${promptName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').substring(0, 30)}.json`;
    let filename = await Popup.show.input('Enter filename for export', defaultFilename);
    if (!filename) filename = defaultFilename;
    if (!filename.toLowerCase().endsWith('.json')) filename += '.json';

    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);

    toastr.success(`Prompt "${promptName}" exported as "${filename}"`);
}

/** Pop a file picker, parse the JSON, and merge prompts in (with conflict resolution). */
async function importCustomPrompts() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';
    fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const importData = JSON.parse(await file.text());

            if (!importData.customPrompts || typeof importData.customPrompts !== 'object') {
                throw new Error('Invalid prompt file format');
            }
            if (Object.keys(importData.customPrompts).length === 0) {
                throw new Error('No prompts found in the import file');
            }

            extension_settings.objective.customPrompts ??= {};

            const existingPrompts = Object.keys(importData.customPrompts)
                .filter(name => extension_settings.objective.customPrompts[name]);

            if (existingPrompts.length > 0) {
                let choice = 'skip';

                if (typeof Popup.show.select === 'function') {
                    const options = [
                        { text: 'Overwrite existing prompts', value: 'overwrite' },
                        { text: 'Import with numbered suffix (e.g. "prompt-2")', value: 'rename' },
                        { text: 'Skip conflicting prompts', value: 'skip' },
                    ];
                    choice = await Popup.show.select(
                        `${existingPrompts.length} prompt(s) already exist with the same name. How would you like to handle this?`,
                        options,
                    );
                } else {
                    if (await Popup.show.confirm(
                        `${existingPrompts.length} prompt(s) already exist with the same name. Would you like to overwrite them?`,
                        null,
                    )) {
                        choice = 'overwrite';
                    } else if (await Popup.show.confirm(
                        'Would you like to import with numbered suffixes (e.g. "prompt-2") instead?',
                        null,
                    )) {
                        choice = 'rename';
                    }
                }

                if (!choice || choice === 'skip') {
                    for (const name of existingPrompts) {
                        delete importData.customPrompts[name];
                    }
                } else if (choice === 'rename') {
                    const renamed = {};
                    for (const name in importData.customPrompts) {
                        if (extension_settings.objective.customPrompts[name]) {
                            let newName = name;
                            let suffix = 2;
                            while (extension_settings.objective.customPrompts[newName] || renamed[newName]) {
                                newName = `${name}-${suffix++}`;
                            }
                            renamed[newName] = importData.customPrompts[name];
                        } else {
                            renamed[name] = importData.customPrompts[name];
                        }
                    }
                    importData.customPrompts = renamed;
                }
            }

            Object.assign(extension_settings.objective.customPrompts, importData.customPrompts);
            saveSettingsDebounced();
            populateCustomPrompts();

            const importedCount = Object.keys(importData.customPrompts).length;
            toastr.success(`Imported ${importedCount} prompts successfully`);
        } catch (error) {
            console.error('Prompt import error:', error);
            toastr.error('Failed to import prompts: ' + error.message);
        }
    };
    fileInput.click();
}

/** Load the selected prompt set into the textareas (and into state). */
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
 * Repopulate the prompt-select dropdown with the current saved sets.
 * @param {string} [selected]
 */
function populateCustomPrompts(selected) {
    if (!selected) selected = state.selectedCustomPrompt || 'default';

    $('#objective-custom-prompt-select').empty();
    for (const name in extension_settings.objective.customPrompts) {
        const option = document.createElement('option');
        option.innerText = name;
        option.value = name;
        option.selected = name === selected;
        $('#objective-custom-prompt-select').append(option);
    }
}
