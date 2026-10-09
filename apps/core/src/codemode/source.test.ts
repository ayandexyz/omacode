import test from "node:test";
import assert from "node:assert/strict";
import { stripTrailingScriptTag } from "./source.js";

test("a trailing </script> is dropped", () => {
  assert.equal(stripTrailingScriptTag('return "x";\n</script>'), 'return "x";\n');
  assert.equal(stripTrailingScriptTag("return 1;</script>  \n"), "return 1;\n");
  assert.equal(stripTrailingScriptTag("return 1;\n</SCRIPT >"), "return 1;\n");
});

test("a script without the tag, or with it mid-source, is unchanged", () => {
  assert.equal(stripTrailingScriptTag("return 1;"), "return 1;");
  const inString = 'const s = "</script>";\nreturn s;';
  assert.equal(stripTrailingScriptTag(inString), inString);
});
