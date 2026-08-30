/**
 * toast.js — lightweight toast notification system
 */

let container = null;

function getContainer() {
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'success'|'warning'|'error'} type
 * @param {number} duration ms
 */
export function showToast(message, type = 'success', duration = 4000) {
  const icons = { success: '✓', warning: '⚠', error: '✕' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <span class="toast-icon">${icons[type] ?? '·'}</span>
    <span class="toast-message">${message}</span>
  `;

  const c = getContainer();
  c.appendChild(el);

  // Auto-remove
  setTimeout(() => {
    el.style.animation = 'toast-out 250ms ease forwards';
    setTimeout(() => el.remove(), 260);
  }, duration);
}
