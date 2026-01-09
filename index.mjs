import { existsSync } from "node:fs"
import { mkdir, readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const CONFIG_FILENAME = "anythropic.json"
const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode")
const CACHE_DIR = join(homedir(), ".cache", "opencode-anythropic-auth")
const DEFAULT_REPO = "https://github.com/anomalyco/opencode-anthropic-auth.git"
const DEFAULT_BRANCH = "main"

const createLogger = (debug) => ({
	log: (...args) => debug && console.log("[anythropic-auth]", ...args),
	warn: (...args) => debug && console.warn("[anythropic-auth]", ...args),
	error: (...args) => debug && console.error("[anythropic-auth]", ...args),
})

/**
 * Load configuration from anythropic.json
 * Search order: project directory -> OpenCode config directory (~/.config/opencode/)
 * @param {string} projectDir - The project directory to search first
 * @returns {Promise<{repo?: string, branch?: string, ref?: string, forceUpdate?: boolean, debug?: boolean} | null>}
 */
async function loadConfig(projectDir) {
	const searchPaths = [
		join(projectDir, CONFIG_FILENAME),
		join(OPENCODE_CONFIG_DIR, CONFIG_FILENAME),
	]

	for (const configPath of searchPaths) {
		if (existsSync(configPath)) {
			try {
				const content = await readFile(configPath, "utf-8")
				return JSON.parse(content)
			} catch {
				// Silent fail, try next path
			}
		}
	}

	return null
}

/**
 * Get a safe directory name from a git URL
 * @param {string} repoUrl
 * @returns {string}
 */
function getRepoCacheName(repoUrl) {
	return repoUrl
		.replace(/^https?:\/\//, "")
		.replace(/\.git$/, "")
		.replace(/[^a-zA-Z0-9-_]/g, "_")
}

/**
 * Clone or update the repository
 * @param {string} repoUrl - Git repository URL
 * @param {string} branch - Branch name to checkout
 * @param {string | undefined} ref - Specific commit/tag to checkout
 * @param {boolean} forceUpdate - Force re-clone even if cached
 * @param {ReturnType<typeof createLogger>} log - Logger instance
 * @returns {Promise<string>} - Path to the cloned repository
 */
async function ensureRepo(repoUrl, branch, ref, forceUpdate, log) {
	const cacheName = getRepoCacheName(repoUrl)
	const repoPath = join(CACHE_DIR, cacheName)

	if (!existsSync(CACHE_DIR)) {
		await mkdir(CACHE_DIR, { recursive: true })
	}

	const repoExists = existsSync(join(repoPath, ".git"))

	if (forceUpdate && repoExists) {
		log.log("Force update requested, removing cached repo...")
		await rm(repoPath, { recursive: true, force: true })
	}

	if (!existsSync(join(repoPath, ".git"))) {
		log.log(`Cloning ${repoUrl}...`)

		const cloneResult = Bun.spawnSync(
			["git", "clone", "--depth", "1", "--branch", branch, repoUrl, repoPath],
			{ stdout: "pipe", stderr: "pipe" },
		)

		if (cloneResult.exitCode !== 0) {
			const stderr = new TextDecoder().decode(cloneResult.stderr)
			throw new Error(`Failed to clone repository: ${stderr}`)
		}

		log.log(`Cloned to ${repoPath}`)
	} else {
		log.log(`Updating cached repo at ${repoPath}...`)

		const fetchResult = Bun.spawnSync(["git", "fetch", "origin", branch], {
			cwd: repoPath,
			stdout: "pipe",
			stderr: "pipe",
		})

		if (fetchResult.exitCode === 0) {
			Bun.spawnSync(["git", "reset", "--hard", `origin/${branch}`], {
				cwd: repoPath,
				stdout: "pipe",
				stderr: "pipe",
			})
		}
	}

	if (ref) {
		log.log(`Checking out ref: ${ref}`)
		const checkoutResult = Bun.spawnSync(["git", "checkout", ref], {
			cwd: repoPath,
			stdout: "pipe",
			stderr: "pipe",
		})

		if (checkoutResult.exitCode !== 0) {
			const stderr = new TextDecoder().decode(checkoutResult.stderr)
			log.warn(`Failed to checkout ref ${ref}: ${stderr}`)
		}
	}

	const packageJsonPath = join(repoPath, "package.json")
	if (existsSync(packageJsonPath)) {
		log.log("Installing dependencies...")
		const installResult = Bun.spawnSync(["bun", "install"], {
			cwd: repoPath,
			stdout: "pipe",
			stderr: "pipe",
		})

		if (installResult.exitCode !== 0) {
			const stderr = new TextDecoder().decode(installResult.stderr)
			log.warn(`Failed to install dependencies: ${stderr}`)
		}
	}

	return repoPath
}

/**
 * Load the plugin module from the repository
 * @param {string} repoPath - Path to the cloned repository
 * @param {ReturnType<typeof createLogger>} log - Logger instance
 * @returns {Promise<any>}
 */
async function loadPluginModule(repoPath, log) {
	const entryPoints = [
		"index.mjs",
		"index.js",
		"dist/index.mjs",
		"dist/index.js",
		"src/index.mjs",
		"src/index.js",
	]

	for (const entry of entryPoints) {
		const entryPath = join(repoPath, entry)
		if (existsSync(entryPath)) {
			log.log(`Loading plugin from ${entryPath}`)
			const moduleUrl = pathToFileURL(entryPath).href
			return await import(moduleUrl)
		}
	}

	const packageJsonPath = join(repoPath, "package.json")
	if (existsSync(packageJsonPath)) {
		const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"))
		const main = packageJson.main || packageJson.module
		if (main) {
			const mainPath = join(repoPath, main)
			if (existsSync(mainPath)) {
				log.log(`Loading plugin from ${mainPath}`)
				const moduleUrl = pathToFileURL(mainPath).href
				return await import(moduleUrl)
			}
		}
	}

	throw new Error(`Could not find entry point in repository at ${repoPath}`)
}

/**
 * Find the plugin export from a module
 * @param {any} mod - The loaded module
 * @returns {import('@opencode-ai/plugin').Plugin | null}
 */
function findPluginExport(mod) {
	for (const [name, value] of Object.entries(mod)) {
		if (
			typeof value === "function" &&
			(name.endsWith("Plugin") || name.includes("Auth"))
		) {
			return value
		}
	}

	if (mod.default && typeof mod.default === "function") {
		return mod.default
	}

	for (const value of Object.values(mod)) {
		if (typeof value === "function") {
			return value
		}
	}

	return null
}

/**
 * OpenCode Plugin that loads and forwards a custom anthropic-auth implementation
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function AnthropicAuthPlugin(input) {
	const { directory } = input

	const config = await loadConfig(directory)

	const debug = config?.debug || false
	const log = createLogger(debug)

	const repoUrl = config?.repo || DEFAULT_REPO
	const branch = config?.branch || DEFAULT_BRANCH
	const ref = config?.ref
	const forceUpdate = config?.forceUpdate || false

	log.log(`Using repository: ${repoUrl}`)
	log.log(ref ? `Using ref: ${ref}` : `Using branch: ${branch}`)

	try {
		const repoPath = await ensureRepo(repoUrl, branch, ref, forceUpdate, log)
		const pluginModule = await loadPluginModule(repoPath, log)
		const pluginExport = findPluginExport(pluginModule)

		if (!pluginExport) {
			log.error("No plugin export found in loaded module")
			return {}
		}

		log.log("Initializing loaded plugin...")
		const hooks = await pluginExport(input)

		log.log("Successfully loaded custom anthropic-auth plugin")
		return hooks
	} catch (err) {
		log.error("Failed to load plugin:", err.message)
		log.error("Falling back to empty hooks")
		return {}
	}
}

export default AnthropicAuthPlugin
