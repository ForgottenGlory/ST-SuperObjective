/**
 * LLM-driven task generation and completion checking.
 *
 * `generateTasks` and `generateAdditionalTasks` ask the model to produce a
 * numbered task list (whole-replacement vs append). `markTaskCompleted` is
 * the user-driven "I say it's done" path. `checkTaskCompleted` is the
 * AI-driven completion check fired automatically every N messages.
 */

import { is_send_press, generateQuietPrompt } from '../../../../../script.js';
import { waitUntilCondition } from '../../../../utils.js';
import { is_group_generating, selected_group } from '../../../../group-chats.js';

import { state, defaultPrompts } from './state.js';
import { substituteParamsPrompts } from './prompts.js';
import { getNextIncompleteTaskRecurse } from './task.js';
import { setCurrentTask, updateUiTaskList } from './ui-tasklist.js';

/**
 * Replace the current objective's task list with a freshly generated one.
 *
 * Existing tasks are preserved if generation fails or yields nothing
 * parseable — we only clear children once we have a usable response.
 */
export async function generateTasks() {
    const prompt = substituteParamsPrompts(state.objectivePrompts.createTask, false);
    console.log('[SuperObjective] generateTasks prompt:\n%s', prompt);
    toastr.info('Generating tasks for objective', 'Please wait...');

    let taskResponse;
    try {
        taskResponse = await generateQuietPrompt(prompt, false, false);
    } catch (err) {
        console.error('Failed to generate tasks:', err);
        toastr.error('Failed to generate tasks. Existing tasks were preserved.');
        return;
    }

    const numbered = /^\d+\./;
    const parsed = taskResponse
        .split('\n')
        .map(x => x.trim())
        .filter(x => numbered.test(x))
        .map(x => x.replace(numbered, '').trim())
        .filter(x => x.length > 0);

    if (parsed.length === 0) {
        console.warn('Task generation returned no parseable tasks. Existing tasks preserved. Response was:', taskResponse);
        toastr.warning('No tasks were generated. Existing tasks were preserved.');
        return;
    }

    state.currentObjective.children = [];
    let firstTask = null;
    for (const description of parsed) {
        const newTask = state.currentObjective.addTask(description);
        if (!firstTask) firstTask = newTask;
    }
    updateUiTaskList();
    setCurrentTask(firstTask ? firstTask.id : null);

    console.info(`Response for Objective: '${state.currentObjective.description}' was \n'${taskResponse}', \nwhich created tasks \n${JSON.stringify(state.currentObjective.children.map(v => v.toSaveStateRecurse()), null, 2)} `);
    toastr.success(`Generated ${state.currentObjective.children.length} tasks`, 'Done!');
}

/**
 * Append additional tasks to the current objective without clearing
 * existing ones. Falls through to `generateTasks` when the list is empty.
 */
export async function generateAdditionalTasks() {
    if (!state.currentObjective || state.currentObjective.children.length === 0) {
        return generateTasks();
    }

    const existingTasksText = state.currentObjective.children
        .map((task, index) => `${index + 1}. ${task.description}`)
        .join('\n');

    let prompt = state.objectivePrompts.additionalTasks || defaultPrompts.additionalTasks;
    prompt = prompt.replace(/{{existingTasks}}/gi, existingTasksText);
    prompt = prompt.replace(/{{objective}}/gi, state.currentObjective?.description ?? '');
    prompt = substituteParamsPrompts(prompt, false);

    console.log('[SuperObjective] generateAdditionalTasks prompt:\n%s', prompt);
    toastr.info('Generating additional tasks', 'Please wait...');

    let taskResponse;
    try {
        taskResponse = await generateQuietPrompt(prompt, false, false);
    } catch (err) {
        console.error('Failed to generate additional tasks:', err);
        toastr.error('Failed to generate additional tasks.');
        return;
    }

    const initialCount = state.currentObjective.children.length;
    const numbered = /^\d+\./;

    let firstNewTask = null;
    for (const line of taskResponse.split('\n').map(x => x.trim())) {
        if (!numbered.test(line)) continue;
        const description = line.replace(numbered, '').trim();
        if (!description) continue;
        const newTask = state.currentObjective.addTask(description);
        if (!firstNewTask) firstNewTask = newTask;
    }

    const newCount = state.currentObjective.children.length - initialCount;
    updateUiTaskList();

    if (newCount > 0 && firstNewTask) {
        setCurrentTask(firstNewTask.id);
    } else {
        const next = getNextIncompleteTaskRecurse(state.taskTree);
        setCurrentTask(next ? next.id : null);
    }

    console.info(`Generated ${newCount} additional tasks for objective: '${state.currentObjective.description}'`);
    toastr.success(`Added ${newCount} additional tasks`, 'Done!');
}

/** User-driven "this task is done." Forwards to ObjectiveTask.completeTask. */
export async function markTaskCompleted() {
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
    state.currentTask.completeTask();
}

/**
 * AI-driven completion check, fired automatically every N messages or
 * manually via the Extras menu / `/taskcheck` slash command.
 *
 * - Waits for any concurrent generation to finish so the LLM gets a stable
 *   chat to look at.
 * - When the active task has a duration requirement and it isn't met yet,
 *   we still ask the model whether it would mark the task complete (so the
 *   user gets a "would have been completed" warning), but we don't actually
 *   complete it.
 *
 * Returns the literal string "true" or "false" (slash-command friendly).
 *
 * @returns {Promise<string>}
 */
export async function checkTaskCompleted() {
    if (!state.currentTask) {
        console.warn('No current task to check');
        return String(false);
    }

    const toast = toastr.info('Checking for task completion...', 'Task Check');

    try {
        if (selected_group) {
            await waitUntilCondition(() => is_group_generating === false, 10000, 100);
        }
        await waitUntilCondition(() => is_send_press === false, 30000, 100);
    } catch {
        console.debug('Failed to wait for group to finish generating');
        toastr.clear(toast);
        return String(false);
    }

    const taskId = state.currentTask.id;

    // If the task has a duration requirement that hasn't been met, run the
    // check anyway so the user knows the LLM thinks it's done — but don't
    // mark it complete.
    if (state.currentTask.duration > 0 && state.currentTask.elapsedMessages < state.currentTask.duration) {
        console.debug(`Task ${state.currentTask.id} has duration ${state.currentTask.duration}, but only ${state.currentTask.elapsedMessages} messages have passed`);

        const prompt = substituteParamsPrompts(state.objectivePrompts.checkTaskCompleted, false);
        console.log('[SuperObjective] checkTaskCompleted prompt (duration-gated):\n%s', prompt);
        const response = (await generateQuietPrompt(prompt, false, false)).toLowerCase();
        toastr.clear(toast);

        if (response.includes('true')) {
            console.debug(`Task ${state.currentTask.id} would be completed but duration requirement not met: ${state.currentTask.elapsedMessages}/${state.currentTask.duration} messages passed`);
            toastr.warning(
                `Task would be completed but duration requirement not met: ${state.currentTask.elapsedMessages}/${state.currentTask.duration} messages needed`,
                'Task Duration Not Met'
            );
        }

        state.checkCounter = Number($('#objective-check-frequency').val());
        setCurrentTask(taskId);
        return String(false);
    }

    if (state.currentTask.duration > 0) {
        console.debug(`Task ${state.currentTask.id} duration requirement met: ${state.currentTask.elapsedMessages}/${state.currentTask.duration} messages passed`);
    }

    const prompt = substituteParamsPrompts(state.objectivePrompts.checkTaskCompleted, false);
    console.log('[SuperObjective] checkTaskCompleted prompt:\n%s', prompt);
    const response = (await generateQuietPrompt(prompt, false, false)).toLowerCase();
    toastr.clear(toast);

    state.checkCounter = Number($('#objective-check-frequency').val());

    if (response.includes('true')) {
        console.info(`Character determined task '${state.currentTask.description}' is completed.`);
        state.currentTask.completeTask();
        toastr.success(`Task "${state.currentTask.description}" completed!`, 'Task Completed');
        return String(true);
    }

    if (!response.includes('false')) {
        console.warn(`checkTaskCompleted response did not contain true or false. taskResponse: ${response}`);
    } else {
        console.debug(`Checked task completion. taskResponse: ${response}`);
        toastr.info(`Task "${state.currentTask.description}" is not complete yet`, 'Task Incomplete');
        setCurrentTask(taskId);
    }

    return String(false);
}
