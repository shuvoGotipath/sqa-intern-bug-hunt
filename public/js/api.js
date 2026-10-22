export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details || {};
  }
}

/**
 * fetch wrapper: JSON in/out, FormData passthrough, consistent errors.
 * The X-Requested-With header is required by the server for state-changing calls.
 */
export async function api(url, { method = 'GET', body, form } = {}) {
  const headers = { 'X-Requested-With': 'fetch', Accept: 'application/json' };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Network error — check your connection and try again.');
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status}).`, data?.details);
  return data;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function toast(message, type = '') {
  let region = document.querySelector('.toast-region');
  if (!region) {
    region = document.createElement('div');
    region.className = 'toast-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

/** Shows server-side field errors next to inputs (matched by name) and returns the first invalid element. */
export function showFieldErrors(formEl, details = {}) {
  clearFieldErrors(formEl);
  let first = null;
  for (const [name, message] of Object.entries(details)) {
    const input = formEl.querySelector(`[name="${name}"]`);
    if (!input) continue;
    input.setAttribute('aria-invalid', 'true');
    const err = document.createElement('div');
    err.className = 'error';
    err.id = `${formEl.id || 'f'}-${name}-error`;
    err.textContent = message;
    input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), err.id].filter(Boolean).join(' '));
    (input.closest('.field') || input.parentElement).appendChild(err);
    first ||= input;
  }
  return first;
}

export function clearFieldErrors(formEl) {
  formEl.querySelectorAll('.error').forEach((e) => {
    const input = formEl.querySelector(`[aria-describedby~="${e.id}"]`);
    if (input) {
      const ids = input.getAttribute('aria-describedby').split(' ').filter((x) => x !== e.id);
      ids.length ? input.setAttribute('aria-describedby', ids.join(' ')) : input.removeAttribute('aria-describedby');
    }
    e.remove();
  });
  formEl.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
}

export function setBusy(button, busy, busyLabel) {
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${escapeHtml(busyLabel || 'Working…')}`;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

export const storage = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};
