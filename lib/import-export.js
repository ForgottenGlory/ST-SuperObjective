/**
 * Whole-objective task JSON in/out: download the current task tree as a
 * .json file, or load tasks (replacing the current set) from a file.
 *
 * Distinct from templates: templates live in extension settings and are
 * reusable structures stripped of completion status; this file just does
 * one-shot serialization of the live tree.
 */

import { Popup } from '../../../../popup.js';

import { state } from './state.js';
import { ObjectiveTask, loadChildTasksFromPlainObject } from './task.js';
import { saveState } from './persistence.js';
import { setCurrentTask, updateUiTaskList } from './ui-tasklist.js';

/** Download the current objective's tasks as a JSON file. */
export async function exportTasks() {
    if (!state.currentObjective || state.currentObjective.children.length === 0) {
        toastr.warning('No tasks to export');
        return;
    }

    const exportData = {
        description: state.currentObjective.description,
        tasks: state.currentObjective.children.map(t => t.toSaveStateRecurse()),
        exportDate: new Date().toISOString(),
        version: '1.0',
    };
    const jsonString = JSON.stringify(exportData, null, 2);

    let defaultFilename = 'objective-tasks.json';
    if (state.currentObjective.description) {
        defaultFilename = state.currentObjective.description
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '-')
            .replace(/-+/g, '-')
            .substring(0, 30) + '.json';
    }

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

    toastr.success(`Tasks exported as "${filename}"`);
}

/** Pop a file picker, parse the JSON, and replace the current task tree. */
export async function importTasks() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';
    fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const importData = JSON.parse(await file.text());
            if (!importData.tasks || !Array.isArray(importData.tasks)) {
                throw new Error('Invalid import file format');
            }

            if (state.currentObjective.children.length > 0) {
                if (!await Popup.show.confirm('This will replace your current tasks. Continue?', null)) {
                    return;
                }
            }

            if (importData.description) {
                state.currentObjective.description = importData.description;
            }

            state.currentObjective.children = [];
            for (const data of importData.tasks) {
                const task = new ObjectiveTask({
                    description: data.description,
                    completed: data.completed || false,
                    parentId: state.currentObjective.id,
                    duration: data.duration ?? 0,
                    elapsedMessages: data.elapsedMessages ?? 0,
                    completionDate: data.completionDate ?? null,
                });
                if (data.children && data.children.length > 0) {
                    loadChildTasksFromPlainObject(task, data.children);
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
    fileInput.click();
}
