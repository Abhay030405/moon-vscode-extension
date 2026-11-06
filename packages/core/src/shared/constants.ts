// Fixed values that never change between setups. Anything a user might change
// belongs in config/moon.json instead (see config.ts).

/** Folder (relative to the Moon repo root) that holds the config files. */
export const CONFIG_DIR = "config";

/** The user's own config file (git-ignored). */
export const CONFIG_FILE_NAME = "moon.json";

/** The committed example the user copies to create CONFIG_FILE_NAME. */
export const EXAMPLE_CONFIG_FILE_NAME = "moon.example.json";
