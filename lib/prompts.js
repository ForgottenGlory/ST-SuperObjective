/**
 * Macro substitution for SuperObjective prompt templates.
 *
 * Handles the SuperObjective-specific placeholders ({{objective}},
 * {{task}} / {{currentTask}}, {{parent}}, {{completedTasks}},
 * {{upcomingTasks}}) and then delegates to SillyTavern's global
 * `substituteParams` so that {{char}}, {{user}}, {{lastGenerationType}},
 * etc. also resolve before the prompt is sent.
 */

import { substituteParams } from '../../../../../script.js';

import { state } from './state.js';

/**
 * Substitute SuperObjective-specific placeholders in a prompt template.
 *
 * @param {string} content                  Raw prompt template.
 * @param {boolean} substituteGlobal        Whether to substitute {{parent}}.
 *   {{task}} and {{currentTask}} are always substituted; this flag exists
 *   only because older versions gated {{task}} behind it (which silently
 *   broke checkTaskCompleted). New callers should pass `true` when they
 *   want {{parent}} expanded.
 * @returns {string}                        Prompt with placeholders filled in.
 */
export function substituteParamsPrompts(content, substituteGlobal) {
    if (!content) {
        return '';
    }

    let result = content;

    // {{objective}} — the description of the active objective.
    result = result.replace(/{{objective}}/gi, state.currentObjective?.description ?? '');

    // {{task}} and {{currentTask}} are aliases. Always substitute, even when
    // there is no current task (in which case they collapse to the empty
    // string). The previous gating behind substituteGlobal silently broke
    // checkTaskCompleted, where the LLM saw the literal {{task}} string.
    const taskDesc = state.currentTask?.description ?? '';
    result = result.replace(/{{task}}/gi, taskDesc);
    result = result.replace(/{{currentTask}}/gi, taskDesc);

    if (substituteGlobal) {
        result = result.replace(/{{parent}}/gi, state.currentTask?.parent?.description ?? '');
    }

    // Recently completed and upcoming tasks are only emitted when there's a
    // current task — otherwise the placeholders are stripped.
    if (state.currentTask && state.currentTask.id) {
        if (result.includes('{{completedTasks}}')) {
            const text = state.recentlyCompletedTasks.length > 0
                ? state.recentlyCompletedTasks.map(t => `[${t.description}]`).join(', ')
                : 'No tasks completed yet';
            result = result.replace(/{{completedTasks}}/gi, text);
        }
        if (result.includes('{{upcomingTasks}}')) {
            const text = state.upcomingTasks.length > 0
                ? state.upcomingTasks.map(t => `[${t.description}]`).join(', ')
                : 'No upcoming tasks yet';
            result = result.replace(/{{upcomingTasks}}/gi, text);
        }
    } else {
        result = result.replace(/{{completedTasks}}/g, '');
        result = result.replace(/{{upcomingTasks}}/g, '');
    }

    // Hand off to SillyTavern for the standard {{char}}, {{user}}, etc.
    return substituteParams(result);
}
