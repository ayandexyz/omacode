// =============================================================================
// Tolerate a model closing its script like HTML (spec 2026-10-05-codemode.md §6.3).
// MiniMax-M3 ended 13 of 103 scripts with `</script>` — a SyntaxError that cost a
// turn each time. A trailing closing tag is never valid JavaScript, so dropping
// it cannot change what a valid script does.
// =============================================================================

const TRAILING_SCRIPT_TAG = /\s*<\/script\s*>\s*$/i;

export function stripTrailingScriptTag(source: string): string {
  return source.replace(TRAILING_SCRIPT_TAG, "\n");
}
