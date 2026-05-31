import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const packageJson = JSON.parse(readFileSync("apps/server/package.json", "utf8"));

function assertIncludes(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

assertIncludes(
  workflow,
  "# Deny default token permissions. Jobs grant only the scopes they need.\npermissions: {}",
  "release workflow should deny default token permissions",
);

assertIncludes(
  workflow,
  "    permissions:\n      contents: read\n      deployments: write\n      id-token: write",
  "publish/deploy job should have only the permissions it needs",
);

assertIncludes(
  workflow,
  "  create-github-release:\n    name: Create GitHub release\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    needs: release",
  "GitHub release creation should run in a dedicated job after publish/deploy",
);

assertIncludes(
  workflow,
  "    permissions:\n      contents: write",
  "GitHub release job should grant contents: write locally",
);

assertIncludes(
  workflow,
  'gh release create "v$version" \\',
  "release workflow should create GitHub releases from the package version tag",
);

assertIncludes(
  workflow,
  "            --verify-tag \\",
  "GitHub release creation should verify the remote tag exists",
);

assert.ok(
  !workflow.includes("            --latest \\"),
  "GitHub release creation should not force backfilled releases to Latest",
);

const version = String(packageJson.version);
const escapedVersion = escapeRegExp(version);
const changelogSection = changelog.match(new RegExp(`(?:^|\\n)## ${escapedVersion}\\n([\\s\\S]*?)(?=\\n## |$)`));

assert.ok(changelogSection, `CHANGELOG.md should include a ## ${version} section`);
assert.ok(changelogSection[1].trim().length > 0, `CHANGELOG.md section for ${version} should not be empty`);

console.log("Release workflow validation passed.");
