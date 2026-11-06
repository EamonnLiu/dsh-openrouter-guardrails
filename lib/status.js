/**
 * Best-effort record of the last pass at `$DSH_HOME/cache/openrouter-guardrails.json`.
 *
 * The desktop app keeps plugin logs in memory, so this file is the durable
 * answer to "did it run, and what did it write". It holds model ids and
 * counts, never the key.
 *
 * @module dsh-openrouter-guardrails/status
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** File name inside the harness cache directory. */
export const STATUS_FILE = 'openrouter-guardrails.json'

/** The status file path for the current `DSH_HOME`. */
export function statusPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'cache', STATUS_FILE)
}

/**
 * Persist one report.
 * @param {object} report
 * @returns {Promise<string>} the written path.
 */
export async function writeStatus(report) {
  const file = statusPath()
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return file
}
