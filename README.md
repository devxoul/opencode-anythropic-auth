# opencode-anythropic-auth

An OpenCode plugin that loads a custom fork of the `opencode-anthropic-auth` plugin from a user-specified repository.

## Installation

Add to your `opencode.json`:

```json
{
  "plugins": ["opencode-anythropic-auth"]
}
```

### Disabling Default Plugins

By default, OpenCode loads builtin plugins (`opencode-anthropic-auth`, `opencode-copilot-auth`) alongside your custom plugins. To use **only** your custom fork and prevent the builtin from loading:

```bash
OPENCODE_DISABLE_DEFAULT_PLUGINS=1 opencode
```

Or add to your shell profile:

```bash
export OPENCODE_DISABLE_DEFAULT_PLUGINS=1
```

## Configuration

Create an `anythropic.json` file in one of these locations (searched in order):

1. Project root (same directory as `opencode.json`)
2. OpenCode config directory (`~/.config/opencode/`)

```json
{
  "repo": "https://github.com/your-username/opencode-anthropic-auth.git",
  "branch": "main"
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `repo` | string | `https://github.com/lenstr/opencode-anthropic-auth` | Git repository URL |
| `branch` | string | `fix/mcp-tool-prefix` | Branch to checkout |
| `ref` | string | - | Specific commit/tag (overrides branch) |
| `forceUpdate` | boolean | `false` | Force re-clone on every load |
| `debug` | boolean | `false` | Enable debug logging to console |

All fields are optional. Without a config file, the plugin loads the default `opencode-anthropic-auth` from Anomaly.

## How It Works

1. Reads config from `anythropic.json` (project root → `~/.config/opencode/`)
2. Clones/updates the specified repository to `~/.cache/opencode-anythropic-auth/`
3. Installs dependencies with `bun install`
4. Dynamically imports and forwards the plugin exports to OpenCode

## Use Cases

- Test custom modifications to the anthropic-auth plugin
- Use a private fork with organization-specific settings
- Pin to a specific version/commit for stability
- Experiment with auth flow changes without publishing

## Cache Location

Repositories are cached at:

```
~/.cache/opencode-anythropic-auth/<repo-name>/
```

To clear cache, delete this directory or set `"forceUpdate": true`.

## License

MIT
