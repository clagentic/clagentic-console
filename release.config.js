var config = {
  repositoryUrl: "https://github.com/clagentic/clagentic-console.git",
  branches: [
    { name: "main", prerelease: "beta", channel: "beta" },
    { name: "release" }
  ],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
    "@semantic-release/npm",
    ["@semantic-release/git", {
      assets: ["package.json", "CHANGELOG.md"],
      message: "Release ${nextRelease.version}"
    }],
    ["@semantic-release/github", {
      // A beta is not "released" (plan #670 lifecycle rule: awaiting-release != released) —
      // successComment/releasedLabels must only fire on the stable channel. The github plugin
      // has no inline per-channel toggle for these two options, so the supported mechanism is
      // successCommentCondition: a lodash template evaluated with the full release context
      // (including nextRelease.channel), gating whether success() comments/labels at all.
      // Stable releases (the "release" branch) carry no channel, so `!nextRelease.channel`
      // is true only on stable.
      successCommentCondition: "<%= !nextRelease.channel %>",
      successComment: "This issue has been resolved in version ${nextRelease.version}.\n\nTo update, run:\n```\nnpx @clagentic/console@${nextRelease.version}\n```",
      releasedLabels: ["status/released"]
    }]
  ]
}

module.exports = config
