export const APP_CONFIG = Object.freeze({
  mode: 'local',
  apiOrigin: 'http://127.0.0.1:4317',
  mediaStorage: 'disk'
});

export function sessionStorageKey(config = APP_CONFIG) {
  return `annotated-session:${new URL(config.apiOrigin).origin}`;
}
