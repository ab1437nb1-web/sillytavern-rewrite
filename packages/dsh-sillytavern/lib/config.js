/**
 * Resolves the on-disk location of the plugin's own data.
 *
 * The three rows share one library directory, so each row's `dataDir` config
 * wins only when set; otherwise every row resolves the same default.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DATA_DIR_ENV = 'DSH_SILLYTAVERN_DATA'

export function resolveDataDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.trim()
  }
  if (process.env[DATA_DIR_ENV]) {
    return process.env[DATA_DIR_ENV]
  }
  if (process.env.DSH_PROFILE_DIR) {
    return join(process.env.DSH_PROFILE_DIR, 'data', 'sillytavern')
  }
  if (process.env.DSH_HOME) {
    return join(process.env.DSH_HOME, 'data', 'sillytavern')
  }
  return join(homedir(), '.dsh', 'data', 'sillytavern')
}
