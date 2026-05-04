/**
 * The "popout" feature: detaches the SuperObjective drawer into a floating,
 * draggable window so it stays visible alongside the chat. Includes a
 * watchdog that self-heals if the popout is dismissed externally (e.g. by
 * ESC) without the close button being clicked.
 */

import { animation_duration } from '../../../../../script.js';
import { dragElement } from '../../../../../scripts/RossAscends-mods.js';
import { loadMovingUIState } from '../../../../../scripts/power-user.js';

import { watchdog } from './utils.js';
import { loadSettings } from './persistence.js';

/**
 * Toggle the popout window. The first call detaches the drawer into a
 * floating panel; the second restores it.
 *
 * @param {MouseEvent} e Original click on the popout button — its target's
 *   ancestor chain is used to locate the drawer to detach.
 */
export function doPopout(e) {
    const target = e.target;

    if ($('#objectiveExtensionPopout').length !== 0) {
        console.debug('saw existing popout, removing');
        $('#objectiveExtensionPopout').fadeOut(animation_duration, () => {
            $('#objectiveExtensionPopoutClose').trigger('click');
        });
        return;
    }

    console.debug('did not see popout yet, creating');
    // Reuse the zoomed-avatar template as a generic floating-div skeleton.
    const drawer = $(target).parent().parent().parent().find('.inline-drawer-content');
    const originalHTMLClone = drawer.html();
    const template = $('#zoomed_avatar_template').html();
    const controlBarHtml = `<div class="panelControlBar flex-container">
        <div id="objectiveExtensionPopoutheader" class="fa-solid fa-grip drag-grabber hoverglow"></div>
        <div id="objectiveExtensionPopoutClose" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
    </div>`;

    const popout = $(template)
        .attr('id', 'objectiveExtensionPopout')
        .removeClass('zoomed_avatar')
        .addClass('draggable')
        .empty();

    drawer.html('<div class="flex-container alignitemscenter justifyCenter wide100p"><small>Currently popped out</small></div>');
    popout.append(controlBarHtml).append(originalHTMLClone);
    $('#movingDivs').append(popout);
    $('#objectiveExtensionDrawerContents').addClass('scrollY');
    loadSettings();
    loadMovingUIState();

    $('#objectiveExtensionPopout').css('display', 'flex').fadeIn(animation_duration);
    dragElement(popout);

    let popoutContents = $('#objectiveExtensionDrawerContents');
    const controller = new AbortController();

    const restoreDrawer = () => {
        drawer.empty();
        drawer.append(popoutContents);
        $('#objectiveExtensionPopout').remove();
    };

    // Close button — the happy path.
    $('#objectiveExtensionPopoutClose').off('click').on('click', () => {
        $('#objectiveExtensionDrawerContents').removeClass('scrollY');
        popoutContents = $('#objectiveExtensionDrawerContents');
        $('#objectiveExtensionPopout').fadeOut(animation_duration, () => {
            restoreDrawer();
            controller.abort();
        });
        loadSettings();
    });

    // Watchdog: if the popout gets dismissed by ESC or other external means,
    // the drawer would otherwise be stuck on "Currently popped out" forever.
    // Detect a missing drawer-contents node and self-heal.
    watchdog(5000, controller.signal, () => {
        if ($('#objectiveExtensionDrawerContents').length === 0) {
            console.debug('detected broken popout, restoring');
            restoreDrawer();
            loadSettings();
            controller.abort();
        }
    });
}
