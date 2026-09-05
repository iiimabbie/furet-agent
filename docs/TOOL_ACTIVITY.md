# Tool activity messages

Umiro shows one temporary Discord activity line while tools run. Each progress event edits the same message, so only the newest status remains visible. You can keep a larger custom phrase library in a separate YAML or JSON file instead of crowding `config.yaml`.

## Configuration

```yaml
discord:
  tool_activity:
    enabled: true
    mode: append
    pools_file: workspace/config/tool-activity.yaml
    pools: {}
```

- `pools_file` is optional. Relative paths resolve from the Umiro repository root.
- `pools` remains available for small inline overrides and backward compatibility.
- When the same key exists in both places, inline `pools` wins.
- `append` adds custom lines after the built-in library.
- `replace` uses only custom pools; missing tool/category keys fall back to `common`, then to the built-in final fallback.
- The file is loaded when a Discord request starts, so edits do not require a gateway restart. If it is missing or malformed, Umiro logs the error and continues with the available inline pools and fallback line without blocking the reply.

## Phrase file format

```yaml
common:
  - "Doing a little bit of magic..."
  - "Following a very suspicious sparkle..."

read_file:
  - "Reading the tiny runes..."

search:
  - "Chasing clues through the sparkles..."
```

Keys may be exact tool names such as `read_file`, categories such as `read`, `write`, `shell`, `search`, `discord`, `github`, `image`, `schedule`, `memory`, `google`, and `integrity`, or `common`. Selection order is exact tool, category, then `common`. Unknown and plugin tools therefore use `common` unless an exact-name pool is configured.

Each displayed phrase receives a category-appropriate emoji prefix. Keep every entry to one short line. Newlines are collapsed, duplicates and blank values are removed, and non-string values are ignored. Do not include secrets, tool arguments, commands, file paths, or claims that work has already succeeded.
