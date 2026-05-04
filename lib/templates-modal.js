/**
 * The "Manage Templates" modal: lets the user save the current task tree
 * as a named template, load a template (replacing current tasks), and
 * import/export templates as JSON.
 *
 * Templates are stored under `extension_settings.objective.templates` and
 * exclude completion status — loading a template gives you a fresh,
 * unstarted version of the saved task structure.
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { callGenericPopup, Popup, POPUP_TYPE } from '../../../../popup.js';

import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { ObjectiveTask, loadChildTasksFromPlainObject } from './task.js';
import { saveState } from './persistence.js';
import { setCurrentTask, updateUiTaskList } from './ui-tasklist.js';

/** Open the Manage Templates modal and wire up its buttons. */
export function onManageTemplatesClick() {
    const popupText = `
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

    $('#objective-template-save').on('click', saveTaskTemplate);
    $('#objective-template-load').on('click', loadTaskTemplate);
    $('#objective-template-delete').on('click', deleteTaskTemplate);
    $('#objective-template-export').on('click', exportTaskTemplates);
    $('#objective-template-import').on('click', importTaskTemplates);
    $('#objective-template-select').on('change', previewTaskTemplate);
}

/** Snapshot the current objective's tasks under a user-supplied name. */
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

    extension_settings.objective.templates ??= {};

    // Templates are completion-agnostic — strip the `completed` flags before save.
    const templateTasks = JSON.parse(JSON.stringify(state.currentObjective.children));
    clearCompletionStatusRecursive(templateTasks);

    extension_settings.objective.templates[templateName] = {
        description: state.currentObjective.description,
        tasks: templateTasks,
    };

    saveSettingsDebounced();
    populateTemplateSelect(templateName);
    previewTaskTemplate();
    toastr.success(`Template "${templateName}" saved`);
}

/** Recursively clear `completed` on a plain-object task array. */
function clearCompletionStatusRecursive(tasks) {
    for (const task of tasks) {
        task.completed = false;
        if (task.children && task.children.length > 0) {
            clearCompletionStatusRecursive(task.children);
        }
    }
}

/** Replace the current objective's tasks with a deep-cloned template tree. */
async function loadTaskTemplate() {
    const templateName = $('#objective-template-select').val();
    if (!templateName) {
        toastr.warning('Please select a template');
        return;
    }

    if (state.currentObjective.children.length > 0) {
        if (!await Popup.show.confirm('This will replace your current tasks. Continue?', null)) {
            return;
        }
    }

    const template = extension_settings.objective.templates[templateName];
    if (!template) {
        toastr.error('Template not found');
        return;
    }

    if (template.description) {
        state.currentObjective.description = template.description;
    }

    state.currentObjective.children = [];
    const templateTasks = JSON.parse(JSON.stringify(template.tasks));
    for (const data of templateTasks) {
        const task = new ObjectiveTask({ description: data.description, parentId: state.currentObjective.id });
        if (data.children && data.children.length > 0) {
            loadChildTasksFromPlainObject(task, data.children);
        }
        state.currentObjective.children.push(task);
    }

    updateUiTaskList();
    setCurrentTask();
    saveState();

    toastr.success(`Template "${templateName}" loaded`);
    $('#objective-template-select').closest('.popup_wrapper').find('.popup_cross').click();
}

/** Delete the selected template after confirmation. */
async function deleteTaskTemplate() {
    const templateName = $('#objective-template-select').val();
    if (!templateName) {
        toastr.warning('Please select a template');
        return;
    }
    if (!await Popup.show.confirm(`Are you sure you want to delete template "${templateName}"?`, null)) {
        return;
    }

    delete extension_settings.objective.templates[templateName];
    saveSettingsDebounced();
    populateTemplateSelect();
    $('#objective-template-preview').html('<p>Select a template to preview</p>');
    toastr.success(`Template "${templateName}" deleted`);
}

/** Render a nested-list preview of the selected template into the modal. */
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

    const items = template.tasks.map(t => `<li>${escapeHtml(t.description)}${
        t.children && t.children.length > 0 ? renderTaskChildrenPreview(t.children) : ''
    }</li>`).join('');

    $('#objective-template-preview').html(
        `<h4>${escapeHtml(template.description) || 'No description'}</h4><ul>${items}</ul>`
    );
}

/** Recursive helper for previewTaskTemplate. */
function renderTaskChildrenPreview(children) {
    const items = children.map(c => `<li>${escapeHtml(c.description)}${
        c.children && c.children.length > 0 ? renderTaskChildrenPreview(c.children) : ''
    }</li>`).join('');
    return `<ul>${items}</ul>`;
}

/** Repopulate the template-select dropdown with current saved templates. */
function populateTemplateSelect(selected) {
    $('#objective-template-select').empty();
    $('#objective-template-select').append(
        '<option value="">-- Select Template --</option>'
    );
    if (!extension_settings.objective.templates) return;
    for (const name in extension_settings.objective.templates) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.innerText = name;
        opt.selected = name === selected;
        $('#objective-template-select').append(opt);
    }
}

/** Download the selected template as a JSON file. */
function exportTaskTemplates() {
    const templateName = $('#objective-template-select').val();
    if (!templateName) {
        toastr.warning('Please select a template to export');
        return;
    }
    if (!extension_settings.objective.templates || !extension_settings.objective.templates[templateName]) {
        toastr.error('Template not found');
        return;
    }

    const exportData = {
        templates: { [templateName]: extension_settings.objective.templates[templateName] },
        exportDate: new Date().toISOString(),
        version: '1.0',
    };
    const jsonString = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const filename = `objective-template-${templateName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').substring(0, 30)}.json`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);

    toastr.success(`Template "${templateName}" exported successfully`);
}

/** Pop a file picker, parse the JSON, and merge templates in (with conflict resolution). */
async function importTaskTemplates() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';
    fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const importData = JSON.parse(await file.text());

            if (!importData.templates || typeof importData.templates !== 'object') {
                throw new Error('Invalid template file format');
            }
            if (Object.keys(importData.templates).length === 0) {
                throw new Error('No templates found in the import file');
            }

            extension_settings.objective.templates ??= {};

            const existing = Object.keys(importData.templates)
                .filter(name => extension_settings.objective.templates[name]);

            if (existing.length > 0) {
                let choice = 'skip';

                if (typeof Popup.show.select === 'function') {
                    choice = await Popup.show.select(
                        `${existing.length} template(s) already exist with the same name. How would you like to handle this?`,
                        [
                            { text: 'Overwrite existing templates', value: 'overwrite' },
                            { text: 'Import with numbered suffix (e.g. "template-2")', value: 'rename' },
                            { text: 'Skip conflicting templates', value: 'skip' },
                        ],
                    );
                } else {
                    if (await Popup.show.confirm(
                        `${existing.length} template(s) already exist with the same name. Would you like to overwrite them?`,
                        null,
                    )) {
                        choice = 'overwrite';
                    } else if (await Popup.show.confirm(
                        'Would you like to import with numbered suffixes (e.g. "template-2") instead?',
                        null,
                    )) {
                        choice = 'rename';
                    }
                }

                if (!choice || choice === 'skip') {
                    for (const name of existing) delete importData.templates[name];
                } else if (choice === 'rename') {
                    const renamed = {};
                    for (const name in importData.templates) {
                        if (extension_settings.objective.templates[name]) {
                            let newName = name;
                            let suffix = 2;
                            while (extension_settings.objective.templates[newName] || renamed[newName]) {
                                newName = `${name}-${suffix++}`;
                            }
                            renamed[newName] = importData.templates[name];
                        } else {
                            renamed[name] = importData.templates[name];
                        }
                    }
                    importData.templates = renamed;
                }
            }

            Object.assign(extension_settings.objective.templates, importData.templates);
            saveSettingsDebounced();

            const firstImported = Object.keys(importData.templates)[0];
            populateTemplateSelect(firstImported);
            previewTaskTemplate();

            toastr.success(`Imported ${Object.keys(importData.templates).length} templates successfully`);
        } catch (error) {
            console.error('Template import error:', error);
            toastr.error('Failed to import templates: ' + error.message);
        }
    };
    fileInput.click();
}
