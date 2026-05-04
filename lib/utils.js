/**
 * Small stateless helpers used across the extension.
 * Keep this file dependency-free so anything else can import from it.
 */

/**
 * Escape arbitrary text for safe interpolation into HTML strings.
 *
 * Used wherever user-controlled content (task descriptions, objective text)
 * is interpolated into a template literal that becomes innerHTML — without
 * this, a description like `<img src=x onerror=alert(1)>` imported from a
 * malicious template JSON would execute.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

