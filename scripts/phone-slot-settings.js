function slotEnvKey(baseKey, port) {
  const key = String(baseKey || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${baseKey}`);
  const portText = String(port || "").trim();
  if (!/^\d+$/.test(portText)) throw new Error(`Invalid phone UI port: ${port}`);
  return `${key}_${portText}`;
}

function uniq(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function hasEnvValue(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined && env[key] !== "";
}

function firstEnvValue(env, keys) {
  for (const key of keys) {
    if (hasEnvValue(env, key)) return env[key];
  }
  return undefined;
}

function settingEnvKeysForSlot(baseKey, port, fallbackKeys = []) {
  const keys = uniq([baseKey, ...fallbackKeys]);
  return [...keys, ...keys.map((key) => slotEnvKey(key, port))];
}

function slotSettingValue(env, baseKey, port, { launchEnvKeys, fallbackKeys = [], fallback } = {}) {
  const keys = uniq([baseKey, ...fallbackKeys]);
  const scopedKeys = keys.map((key) => slotEnvKey(key, port));
  if (launchEnvKeys) {
    const scopedLaunchValue = firstEnvValue(
      env,
      scopedKeys.filter((key) => launchEnvKeys.has(key)),
    );
    if (scopedLaunchValue !== undefined) return scopedLaunchValue;
  }

  const scopedValue = firstEnvValue(env, scopedKeys);
  if (scopedValue !== undefined) return scopedValue;

  if (launchEnvKeys) {
    const launchValue = firstEnvValue(
      env,
      keys.filter((key) => launchEnvKeys.has(key)),
    );
    if (launchValue !== undefined) return launchValue;
  }

  const globalValue = firstEnvValue(env, keys);
  return globalValue !== undefined ? globalValue : fallback;
}

function defaultCodexAppServerPort(phonePort, fallback = 45213) {
  const port = Number(phonePort);
  const candidate = port - 1;
  if (Number.isInteger(candidate) && candidate >= 1024 && candidate <= 65535) return candidate;
  return fallback;
}

module.exports = {
  defaultCodexAppServerPort,
  settingEnvKeysForSlot,
  slotEnvKey,
  slotSettingValue,
};
